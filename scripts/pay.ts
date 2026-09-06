import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import {
  CounterpartyMode,
  LocalTrustRoot,
  signEnvelopeLocal,
  type Envelope,
} from "../packages/envelope/src/index.js";
import {
  Erc8004ReputationSource,
  guarded,
} from "../packages/reputation/src/index.js";
import {
  HcsReceiptSink,
  makeClient,
  MirrorReceiptReader,
  SpendTracker,
  windowSpend,
  windowStart,
} from "../packages/receipts/src/index.js";
import { createPayingFetch } from "../packages/agent/src/index.js";
import { loadConfig } from "./config.js";

const HBAR = 100_000_000n;
const hbar = (t: bigint) => `${(Number(t) / 1e8).toFixed(4)} HBAR`;
const BASE = process.env.SERVICE_URL ?? "http://localhost:4021";

async function main() {
  const cfg = loadConfig({ requireTopic: true, requireOwner: true });
  const topicId = cfg.topicId!;
  const owner = privateKeyToAccount(cfg.ownerKey!);
  const price = BigInt(process.env.X402_PRICE_TINYBAR ?? "1000000");
  const payTo = process.env.X402_PAY_TO?.trim() || cfg.accountId;
  const serviceAgentId = process.env.SERVICE_AGENT_ID?.trim();
  if (!serviceAgentId) {
    throw new Error(
      "Missing SERVICE_AGENT_ID — run: npx tsx scripts/seed-reputation.ts\n" +
        "  Without an agent identity the counterparty has no reputation, and\n" +
        "  with an empty allowlist every payment is denied NO_HISTORY.",
    );
  }

  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `Service not reachable at ${BASE}. Start it: npm run service`,
    );
  }

  const now = BigInt(Math.floor(Date.now() / 1000));

  const envelope: Envelope = {
    version: "1",
    envelopeId:
      `0x${Date.now().toString(16).padStart(64, "0")}` as `0x${string}`,
    principal: owner.address,
    agent: cfg.accountId,
    currency: "HBAR",
    perCall: 2n * price, // at most 2 calls' worth in any one payment
    perWindow: 3n * price, // and 3 calls total per hour
    windowSeconds: 3600n,
    counterpartyMode: CounterpartyMode.AllowlistOrReputation,

    allowlist: [],
    minReputation: 600,
    minFeedbackCount: 3,
    notBefore: now - 60n,
    notAfter: now + 3600n,
    receiptTopic: topicId,
  };

  const signature = await signEnvelopeLocal(envelope, cfg.ownerKey!);
  const principal = await new LocalTrustRoot().verify(envelope, signature);

  console.log(`\n  ENVELOPE  signed by ${owner.address}`);
  console.log(`            signature ${principal ? "verified" : "INVALID"}`);
  console.log(`            per call  ${hbar(envelope.perCall)}`);
  console.log(`            per hour  ${hbar(envelope.perWindow)}`);
  console.log(
    `            approved  ${
      envelope.allowlist.length
        ? envelope.allowlist.join(", ")
        : "(none — reputation only)"
    }`,
  );
  console.log(
    `            requires  score >=${envelope.minReputation} over >=${envelope.minFeedbackCount} clients`,
  );
  console.log(`  AGENT     ${cfg.accountId}`);
  console.log(`  TOPIC     ${topicId}\n`);

  const hedera = makeClient({
    accountId: cfg.accountId,
    privateKey: cfg.hederaKey,
    network: cfg.network,
    keyType: cfg.keyType,
  });
  const receipts = new HcsReceiptSink(hedera, topicId);
  const reader = new MirrorReceiptReader(topicId, cfg.network);
  const tracker = new SpendTracker(reader, {
    envelopeId: envelope.envelopeId,
    currency: "HBAR",
    windowSeconds: envelope.windowSeconds,
    refreshMs: 60_000,
  });

  const { fetch: pay } = createPayingFetch({
    accountId: cfg.accountId,
    privateKey: cfg.hederaKey,
    network: process.env.X402_NETWORK,
    envelope,
    principal,

    reputation: guarded(
      new Erc8004ReputationSource("testnet", {
        rpcUrl: process.env.HEDERA_JSON_RPC,
        agentIds: serviceAgentId ? { [payTo]: serviceAgentId } : {},
      }),

      { timeoutMs: 4000 },
    ),
    tracker,
    receipts,
    onError: (err) => {
      const m = err instanceof Error ? err.message : String(err);
      console.log(`  GUARD FAILED  ${m}`);
      if (process.env.DEBUG && err instanceof Error) console.log(err.stack);
    },
    onDecision: (d, r) => {
      const mark = d.decision === "ALLOW" ? "  ALLOW " : "  DENY  ";
      console.log(`${mark} ${hbar(r.amount)} -> ${r.counterparty}`);
      console.log(`          ${d.reason}: ${d.message}`);

      const ev = d.evidence;
      if (ev.reputationScore !== undefined && ev.reputationScore !== null) {
        console.log(
          `          reputation ${ev.reputationScore}/1000 over ` +
            `${ev.feedbackCount} clients (${ev.reputationSource})`,
        );
      }
    },
  });

  const texts = [
    "the service was fast and reliable",
    "this provider seems trusted and secure",
    "a third call, which should exhaust the hourly budget",
    "a fourth call the agent must not be able to make",
  ];

  let paid = 0;
  for (const text of texts) {
    console.log(`  REQUEST   "${text.slice(0, 46)}"`);
    try {
      const res = await pay(
        `${BASE}/v1/analyze?text=${encodeURIComponent(text)}`,
      );
      if (res.ok) {
        const body = (await res.json()) as { sentiment: string; score: number };
        console.log(`          200 -> ${body.sentiment} (${body.score})`);
        paid++;
      } else {
        console.log(`          ${res.status} — payment did not complete`);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.log(`          blocked: ${err.message}`);
      const cause = (err as { cause?: unknown }).cause;
      if (cause) {
        const c = cause instanceof Error ? cause.message : String(cause);
        console.log(`          cause:   ${c}`);
      }
      if (process.env.DEBUG) console.log(err.stack);
    }
    console.log();
  }

  console.log("  Waiting 6s for the mirror node to catch up...\n");
  await new Promise((r) => setTimeout(r, 6000));

  const replayNow = BigInt(Math.floor(Date.now() / 1000));

  const replayed = await reader.read(
    windowStart(replayNow, envelope.windowSeconds),
  );
  const mine = replayed.filter((r) => r.eid === envelope.envelopeId);
  const derived = windowSpend(replayed, {
    now: replayNow,
    windowSeconds: envelope.windowSeconds,
    envelopeId: envelope.envelopeId,
    currency: "HBAR",
  });

  console.log("  AUDIT TRAIL, replayed from HCS");
  console.log(`    receipts        ${mine.length}`);
  console.log(
    `    allowed         ${mine.filter((r) => r.d === "ALLOW").length}`,
  );
  console.log(
    `    denied          ${mine.filter((r) => r.d === "DENY").length}`,
  );
  for (const r of mine) {
    console.log(
      `      ${r.d.padEnd(5)} ${hbar(BigInt(r.amt)).padStart(12)}  ${r.r}`,
    );
  }
  const expected = BigInt(paid) * price;
  console.log(`\n    spend from log  ${hbar(derived)}`);
  console.log(`    paid requests   ${paid}  (${hbar(expected)})`);
  console.log(
    `    reconciles      ${derived === expected ? "YES" : "NO — investigate"}`,
  );
  console.log(`\n    https://hashscan.io/${cfg.network}/topic/${topicId}\n`);

  hedera.close();
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
