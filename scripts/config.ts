import { privateKeyToAccount } from "viem/accounts";
import { parsePrivateKey, type Network } from "@allowance/receipts";

export interface Config {
  accountId: string;
  hederaKey: string;
  network: Network;
  keyType?: "ECDSA" | "ED25519";

  ownerKey?: `0x${string}`;
  ownerAddress?: `0x${string}`;
  topicId?: string;
}

function required(name: string, hint: string): string {
  const v = process.env[name]?.trim();
  if (!v || v === "0x" || v.startsWith("0.0.xxx")) {
    throw new Error(`Missing ${name} in .env — ${hint}`);
  }
  return v;
}

export function loadConfig(
  opts: { requireTopic?: boolean; requireOwner?: boolean } = {},
): Config {
  const requireOwner = opts.requireOwner ?? true;

  const accountId = required(
    "HEDERA_ACCOUNT_ID",
    "copy the Account ID from portal.hedera.com",
  );
  const hederaKey = required(
    "HEDERA_PRIVATE_KEY",
    "copy the HEX Encoded Private Key from portal.hedera.com",
  );

  const rawOwnerKey = process.env.OWNER_PRIVATE_KEY?.trim();
  const ownerKey =
    rawOwnerKey && rawOwnerKey !== "0x"
      ? (rawOwnerKey as `0x${string}`)
      : undefined;
  if (requireOwner && !ownerKey) {
    throw new Error(
      "Missing OWNER_PRIVATE_KEY in .env — run: npx tsx scripts/new-owner-key.ts",
    );
  }

  const keyType = process.env.HEDERA_KEY_TYPE as Config["keyType"];
  const network = (process.env.HEDERA_NETWORK ?? "testnet") as Network;

  // Fail early with a clear message rather than deep inside the SDK.
  parsePrivateKey(hederaKey, keyType);

  let ownerAddress: `0x${string}` | undefined;
  if (ownerKey) {
    try {
      ownerAddress = privateKeyToAccount(ownerKey).address;
    } catch {
      throw new Error(
        `OWNER_PRIVATE_KEY must be 0x followed by 64 hex characters.\n` +
          `  Saw ${ownerKey.replace(/^0x/i, "").length} characters after 0x.\n` +
          `  Generate one: npx tsx scripts/new-owner-key.ts`,
      );
    }

    // The check that matters. An ECDSA Hedera key and a viem key are the same
    // kind of secret, so pasting one into both slots is an easy mistake — and
    // it silently destroys the guarantee, because an agent holding the owner
    // key can sign itself a larger allowance at will.
    if (ownerKey.toLowerCase() === hederaKey.toLowerCase()) {
      throw new Error(
        "OWNER_PRIVATE_KEY and HEDERA_PRIVATE_KEY are identical.\n\n" +
          "  The Hedera key belongs to the agent; the owner key belongs to the\n" +
          "  human who sets its limits. If they are the same, the agent can sign\n" +
          "  itself a bigger allowance and the guard is meaningless.\n\n" +
          "  Generate a separate one: npx tsx scripts/new-owner-key.ts",
      );
    }
  }

  const topicId = process.env.HCS_RECEIPT_TOPIC?.trim() || undefined;
  if (opts.requireTopic && !topicId) {
    throw new Error(
      "Missing HCS_RECEIPT_TOPIC — run: npx tsx scripts/create-topic.ts",
    );
  }

  return {
    accountId,
    hederaKey,
    network,
    keyType,
    ownerKey,
    ownerAddress,
    topicId,
  };
}
