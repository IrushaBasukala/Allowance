import {
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicId,
} from "@hashgraph/sdk";
import {
  decodeReceipt,
  encodeReceipt,
  type Receipt,
  type ReceiptReader,
  type ReceiptSink,
} from "./receipt.js";

export type Network = "testnet" | "mainnet" | "previewnet";

const MIRROR: Record<Network, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
  previewnet: "https://previewnet.mirrornode.hedera.com",
};

export interface HederaConfig {
  accountId: string;
  privateKey: string;
  network: Network;
  /** Force an interpretation. Omit to auto-detect. */
  keyType?: "ECDSA" | "ED25519";
}

/**
 * Parse an operator key without caring how the portal happened to format it.
 *
 * Hedera hands out keys in several encodings — DER hex (the portal default),
 * raw 32-byte hex, and 0x-prefixed raw for ECDSA. Guessing wrong throws an
 * unhelpful parse error, so try the encodings in order of likelihood and only
 * fail once none of them work.
 */
export function parsePrivateKey(
  raw: string,
  keyType?: "ECDSA" | "ED25519",
): PrivateKey {
  const key = raw.trim().replace(/^["']|["']$/g, "");

  const attempts: Array<() => PrivateKey> = keyType
    ? [
        () =>
          keyType === "ECDSA"
            ? PrivateKey.fromStringECDSA(key)
            : PrivateKey.fromStringED25519(key),
      ]
    : [
        () => PrivateKey.fromStringDer(key), // portal default
        () => PrivateKey.fromStringECDSA(key),
        () => PrivateKey.fromStringED25519(key),
      ];

  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      continue;
    }
  }
  throw new Error(describeBadKey(key));
}

/**
 * Explain WHY a key failed, not merely that it did.
 *
 * Every encoding the portal produces parses cleanly — DER, raw hex, with or
 * without an 0x prefix. So a failure here is almost never the format; it is a
 * truncated paste. The portal shortens the key on screen with an ellipsis, and
 * reading it off the display rather than using the copy button yields a key
 * that looks right and is short. Reporting the length makes that obvious.
 */
function describeBadKey(key: string): string {
  const body = /^0x/i.test(key) ? key.slice(2) : key;
  const lines = ["HEDERA_PRIVATE_KEY could not be parsed.", ""];

  lines.push(`  length seen : ${body.length} hex characters`);
  lines.push("  expected    : 64 (raw) or 100 (DER, begins 3030)");
  lines.push("");

  if (key.includes("...") || key.includes("\u2026")) {
    lines.push('  The value contains "..." — that is the portal truncating');
    lines.push("  the display, not part of the key. Use the copy button.");
  } else if (body.length < 64) {
    lines.push("  Too short: this is a truncated paste. The portal shortens");
    lines.push('  the key on screen. Click the copy icon beside "HEX Encoded');
    lines.push('  Private Key" instead of selecting the visible text.');
  } else if (!/^[0-9a-fA-F]+$/.test(body)) {
    const bad = [...new Set(body.replace(/[0-9a-fA-F]/g, "").split(""))].join(
      "",
    );
    lines.push(`  Contains non-hex characters: ${JSON.stringify(bad)}`);
    lines.push("  Check for quotes, spaces, or a line break in .env.");
  } else if (body.length > 64 && body.length < 100) {
    lines.push("  Between raw (64) and DER (100) length — a partial DER key.");
    lines.push("  Re-copy the whole value.");
  } else {
    lines.push("  Correct length but rejected. Set HEDERA_KEY_TYPE explicitly");
    lines.push("  to ECDSA or ED25519 to match your account type.");
  }

  lines.push("");
  lines.push("  portal.hedera.com > your account > copy icon");
  return lines.join("\n");
}

export function makeClient(cfg: HederaConfig): Client {
  const client =
    cfg.network === "mainnet"
      ? Client.forMainnet()
      : cfg.network === "previewnet"
        ? Client.forPreviewnet()
        : Client.forTestnet();
  client.setOperator(
    cfg.accountId,
    parsePrivateKey(cfg.privateKey, cfg.keyType),
  );
  return client;
}

/**
 * Create the topic receipts will be written to.
 *
 * No submit key is set, which makes the topic public-write. That is the right
 * default here: anyone can append, but nobody — including us — can alter or
 * remove what is already there. Append-only is the property we need; exclusive
 * write is not. A submit key would let us censor our own denials, which is
 * precisely the power an audit trail should not grant its owner.
 *
 * Garbage from third parties is handled at read time: decodeReceipt() ignores
 * anything malformed, and windowSpend() filters by envelope id.
 */
export async function createReceiptTopic(
  client: Client,
  memo = "allowance:receipts:v1",
): Promise<string> {
  const tx = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  if (!receipt.topicId) throw new Error("topic creation returned no topic id");
  return receipt.topicId.toString();
}

/** Writes receipts to an HCS topic. */
export class HcsReceiptSink implements ReceiptSink {
  readonly kind = "hcs";

  constructor(
    private readonly client: Client,
    private readonly topicId: string,
  ) {}

  async write(receipt: Receipt): Promise<string> {
    const payload = encodeReceipt(receipt);
    const submitted = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(this.topicId))
      .setMessage(payload)
      .execute(this.client);
    const rec = await submitted.getReceipt(this.client);
    // Sequence number is the topic's own ordering — the receipt's place in line.
    return `${this.topicId}@${rec.topicSequenceNumber?.toString() ?? "?"}`;
  }
}

/**
 * Reads receipts back through a mirror node.
 *
 * Mirror nodes are the read path for HCS. Note this is REST, not a Subgraph:
 * HCS messages are not EVM events, so The Graph cannot index them. Reputation
 * comes from The Graph; our own history comes from here.
 */
export class MirrorReceiptReader implements ReceiptReader {
  readonly kind = "mirror";
  private readonly base: string;

  constructor(
    private readonly topicId: string,
    network: Network = "testnet",
    baseUrl?: string,
  ) {
    this.base = baseUrl ?? MIRROR[network];
  }

  async read(sinceTs: number): Promise<Receipt[]> {
    const out: Receipt[] = [];
    let path =
      `/api/v1/topics/${this.topicId}/messages` +
      `?timestamp=gte:${sinceTs}&order=asc&limit=100`;

    // Mirror responses are paginated; follow links.next until exhausted.
    while (path) {
      const res = await fetch(this.base + path);

      // A topic that exists but has never been written to returns 404 here.
      // That is an empty log, not a failure — and treating it as one breaks
      // the very first payment ever made under a fresh topic, because the
      // spend replay throws before the policy is even evaluated.
      if (res.status === 404) return out;

      if (!res.ok) {
        throw new Error(
          `mirror node ${res.status} for topic ${this.topicId}: ${await res.text()}`,
        );
      }
      const body = (await res.json()) as {
        messages?: Array<{ message?: string }>;
        links?: { next?: string | null };
      };

      for (const m of body.messages ?? []) {
        if (!m.message) continue;
        // Mirror returns message contents base64-encoded.
        const decoded = decodeReceipt(
          Buffer.from(m.message, "base64").toString("utf8"),
        );
        if (decoded) out.push(decoded);
      }
      path = body.links?.next ?? "";
    }
    return out;
  }
}
