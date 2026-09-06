import { privateKeyToAccount } from "viem/accounts";
import {
  CounterpartyMode,
  LocalTrustRoot,
  signEnvelopeLocal,
  envelopeHash,
  type Envelope,
} from "../packages/envelope/src/index.js";
import { evaluate, type PaymentRequest } from "../packages/policy/src/index.js";
import {
  demoReputationSource,
  guarded,
  resolveReputation,
  type ReputationSource,
} from "../packages/reputation/src/index.js";

const OWNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const owner = privateKeyToAccount(OWNER_KEY);
const HBAR = 100_000_000n;
const hbar = (t: bigint) => `${Number(t) / 1e8} HBAR`;
const now = BigInt(Math.floor(Date.now() / 1000));

const envelope: Envelope = {
  version: "1",
  envelopeId: `0x${"ab".repeat(32)}`,
  principal: owner.address,
  agent: "0.0.4417542",
  currency: "HBAR",
  perCall: 2n * HBAR,
  perWindow: 50n * HBAR,
  windowSeconds: 86_400n,
  counterpartyMode: CounterpartyMode.AllowlistOrReputation,
  allowlist: ["0.0.5551212"],
  minReputation: 600,
  minFeedbackCount: 5,
  notBefore: now - 60n,
  notAfter: now + 86_400n,
  receiptTopic: "0.0.98765",
};

// Step 6 swaps this one line for a Subgraph client. Nothing else changes.
const live: ReputationSource = guarded(demoReputationSource());

// Simulates The Graph being unreachable.
const outage: ReputationSource = guarded({
  kind: "down",
  async score() {
    throw new Error("subgraph unreachable");
  },
});

async function main() {
  const sig = await signEnvelopeLocal(envelope, OWNER_KEY);
  const trust = new LocalTrustRoot();
  const principal = await trust.verify(envelope, sig);

  console.log("ENVELOPE");
  console.log(`  owner        ${envelope.principal}`);
  console.log(`  agent        ${envelope.agent}`);
  console.log(`  per call     ${hbar(envelope.perCall)}`);
  console.log(`  per 24h      ${hbar(envelope.perWindow)}`);
  console.log(`  allowlist    ${envelope.allowlist.join(", ")}`);
  console.log(
    `  min rep      ${envelope.minReputation} over >=${envelope.minFeedbackCount} reviews`,
  );
  console.log(`  hash         ${envelopeHash(envelope).slice(0, 18)}...`);
  console.log(`  verified     ${principal ? "signature holds" : "INVALID"}\n`);

  const scenes: Array<[string, PaymentRequest, bigint, ReputationSource]> = [
    [
      "Routine call to a known provider",
      {
        agent: envelope.agent,
        counterparty: "0.0.5551212",
        amount: 40_000_000n,
        currency: "HBAR",
      },
      0n,
      live,
    ],
    [
      "New provider, strong public history",
      {
        agent: envelope.agent,
        counterparty: "0.0.7778888",
        amount: 150_000_000n,
        currency: "HBAR",
      },
      0n,
      live,
    ],
    [
      "PROMPT INJECTION: drain to attacker",
      {
        agent: envelope.agent,
        counterparty: "0.0.666",
        amount: 500n * HBAR,
        currency: "HBAR",
      },
      0n,
      live,
    ],
    [
      "RUNAWAY LOOP: budget nearly gone",
      {
        agent: envelope.agent,
        counterparty: "0.0.5551212",
        amount: 1n * HBAR,
        currency: "HBAR",
      },
      49n * HBAR + 50_000_000n,
      live,
    ],
    [
      "SYBIL: perfect score, one review",
      {
        agent: envelope.agent,
        counterparty: "0.0.4443333",
        amount: 50_000_000n,
        currency: "HBAR",
      },
      0n,
      live,
    ],
    [
      "Low-rated provider",
      {
        agent: envelope.agent,
        counterparty: "0.0.666",
        amount: 50_000_000n,
        currency: "HBAR",
      },
      0n,
      live,
    ],
    [
      "Unknown provider, no data",
      {
        agent: envelope.agent,
        counterparty: "0.0.9990000",
        amount: 50_000_000n,
        currency: "HBAR",
      },
      0n,
      live,
    ],
    [
      "OUTAGE: reputation source down, stranger",
      {
        agent: envelope.agent,
        counterparty: "0.0.7778888",
        amount: 50_000_000n,
        currency: "HBAR",
      },
      0n,
      outage,
    ],
    [
      "OUTAGE: allowlisted provider still works",
      {
        agent: envelope.agent,
        counterparty: "0.0.5551212",
        amount: 50_000_000n,
        currency: "HBAR",
      },
      0n,
      outage,
    ],
  ];

  for (const [label, request, spent, source] of scenes) {
    const reputation = await resolveReputation(envelope, request, source);
    const lookup = reputation !== undefined;
    const d = evaluate(envelope, request, {
      now,
      principal,
      spentInWindow: spent,
      reputation,
    });

    const mark = d.decision === "ALLOW" ? "ALLOW " : "DENY  ";
    console.log(`${mark} ${label}`);
    console.log(`       ${hbar(request.amount)} -> ${request.counterparty}`);
    console.log(`       ${d.reason}: ${d.message}`);
    console.log(
      `       reputation lookup: ${lookup ? "yes" : "skipped (allowlisted)"}`,
    );
    console.log();
  }
}

main();
