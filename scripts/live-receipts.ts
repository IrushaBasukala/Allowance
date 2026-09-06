import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import {
  CounterpartyMode,
  LocalTrustRoot,
  signEnvelopeLocal,
  type Envelope,
} from "../packages/envelope/src/index.js";
import { evaluate, type PaymentRequest } from "../packages/policy/src/index.js";
import {
  demoReputationSource,
  guarded,
  resolveReputation,
} from "../packages/reputation/src/index.js";
import {
  buildReceipt,
  HcsReceiptSink,
  makeClient,
  MirrorReceiptReader,
  SpendTracker,
  windowSpend,
  windowStart,
  type Network,
} from "../packages/receipts/src/index.js";

import { loadConfig } from "./config.js";

const HBAR = 100_000_000n;
const hbar = (t: bigint) => `${Number(t) / 1e8} HBAR`;

async function main() {
  const cfg = loadConfig({ requireTopic: true });
  const network = cfg.network;
  const topicId = cfg.topicId!;
  const ownerKey = cfg.ownerKey;
  const owner = privateKeyToAccount(ownerKey!);

  const client = makeClient({
    accountId: cfg.accountId,
    privateKey: cfg.hederaKey,
    network,
    keyType: cfg.keyType,
  });
  const sink = new HcsReceiptSink(client, topicId);
  const reader = new MirrorReceiptReader(topicId, network);
  const reputation = guarded(demoReputationSource());

  const now = BigInt(Math.floor(Date.now() / 1000));
  const envelope: Envelope = {
    version: "1",
    // Fresh id each run, so replays don't mix with earlier runs on the same topic.
    envelopeId:
      `0x${Date.now().toString(16).padStart(64, "0")}` as `0x${string}`,
    principal: owner.address,
    agent: cfg.accountId,
    currency: "HBAR",
    perCall: 2n * HBAR,
    perWindow: 5n * HBAR,
    windowSeconds: 3600n,
    counterpartyMode: CounterpartyMode.AllowlistOrReputation,
    allowlist: ["0.0.5551212"],
    minReputation: 600,
    minFeedbackCount: 5,
    notBefore: now - 60n,
    notAfter: now + 3600n,
    receiptTopic: topicId,
  };

  const sig = await signEnvelopeLocal(envelope, ownerKey!);
  const principal = await new LocalTrustRoot().verify(envelope, sig);
  console.log(`Owner (human) ${owner.address}`);
  console.log(`Agent (Hedera) ${cfg.accountId}`);
  console.log(
    `Envelope ${envelope.envelopeId.slice(0, 12)}... signature ${principal ? "OK" : "INVALID"}`,
  );
  console.log(
    `Limits: ${hbar(envelope.perCall)} per call, ${hbar(envelope.perWindow)} per hour`,
  );
  console.log(`Topic:  ${topicId}\n`);

  const tracker = new SpendTracker(reader, {
    envelopeId: envelope.envelopeId,
    currency: "HBAR",
    windowSeconds: envelope.windowSeconds,
    refreshMs: 60_000, // don't re-read the mirror mid-run
  });

  const attempts: Array<[string, PaymentRequest]> = [
    [
      "Routine call",
      {
        agent: envelope.agent,
        counterparty: "0.0.5551212",
        amount: 2n * HBAR,
        currency: "HBAR",
      },
    ],
    [
      "Routine call",
      {
        agent: envelope.agent,
        counterparty: "0.0.5551212",
        amount: 2n * HBAR,
        currency: "HBAR",
      },
    ],
    [
      "Third call — window is nearly gone",
      {
        agent: envelope.agent,
        counterparty: "0.0.5551212",
        amount: 2n * HBAR,
        currency: "HBAR",
      },
    ],
    [
      "PROMPT INJECTION — drain to attacker",
      {
        agent: envelope.agent,
        counterparty: "0.0.666",
        amount: 500n * HBAR,
        currency: "HBAR",
      },
    ],
  ];

  let allowed = 0n;
  for (const [label, request] of attempts) {
    const spent = await tracker.spentInWindow(now);
    const rep = await resolveReputation(envelope, request, reputation);
    const decision = evaluate(envelope, request, {
      now,
      principal,
      spentInWindow: spent,
      reputation: rep,
    });

    const ref = await sink.write(
      buildReceipt(envelope, request, decision, { now }),
    );
    if (decision.decision === "ALLOW") {
      tracker.noteAllowed(request.amount);
      allowed += request.amount;
    }

    console.log(
      `${decision.decision === "ALLOW" ? "ALLOW " : "DENY  "} ${label}`,
    );
    console.log(`       ${hbar(request.amount)} -> ${request.counterparty}`);
    console.log(`       ${decision.reason}: ${decision.message}`);
    console.log(`       receipt ${ref}\n`);
  }

  console.log("Waiting 6s for mirror node to catch up...\n");
  await new Promise((r) => setTimeout(r, 6000));

  const replayed = await reader.read(windowStart(now, envelope.windowSeconds));
  const mine = replayed.filter((r) => r.eid === envelope.envelopeId);
  const derived = windowSpend(replayed, {
    now,
    windowSeconds: envelope.windowSeconds,
    envelopeId: envelope.envelopeId,
    currency: "HBAR",
  });

  console.log("REPLAY FROM MIRROR NODE");
  console.log(`  receipts on topic for this envelope : ${mine.length}`);
  console.log(
    `  allowed                             : ${mine.filter((r) => r.d === "ALLOW").length}`,
  );
  console.log(
    `  denied                              : ${mine.filter((r) => r.d === "DENY").length}`,
  );
  console.log(`  spend derived from log              : ${hbar(derived)}`);
  console.log(`  spend we tracked locally            : ${hbar(allowed)}`);
  console.log(
    `  match                               : ${derived === allowed ? "YES" : "NO — investigate"}`,
  );
  console.log(`\n  https://hashscan.io/${network}/topic/${topicId}\n`);

  client.close();
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
