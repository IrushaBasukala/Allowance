import "dotenv/config";
import {
  Erc8004ReputationSource,
  guarded,
} from "../packages/reputation/src/index.js";

async function main() {
  const target = process.argv[2] ?? process.env.SERVICE_AGENT_ID;
  if (!target) {
    throw new Error(
      "No agent given. Pass an agentId or wallet address, or set\n" +
        "  SERVICE_AGENT_ID in .env (run: npx tsx scripts/seed-reputation.ts)",
    );
  }

  const raw = new Erc8004ReputationSource("testnet");
  console.log(`\n  Querying ${raw.kind} for "${target}"...\n`);

  const started = Date.now();
  const direct = await raw.score(target);
  const elapsed = Date.now() - started;

  if (direct === null) {
    console.log("  No agent found for that identifier.");
    console.log(
      "  A payment to this counterparty would be denied: NO_HISTORY\n",
    );
    return;
  }

  console.log(`  score          ${direct.score} / 1000`);
  console.log(`  distinct clients ${direct.feedbackCount}`);
  console.log(`  source         ${direct.source}`);
  console.log(`  latency        ${elapsed}ms`);

  const minReputation = Number(process.env.MIN_REPUTATION ?? 600);
  const minFeedbackCount = Number(process.env.MIN_FEEDBACK_COUNT ?? 3);

  console.log(
    `\n  Against a bar of ${minReputation} over >=${minFeedbackCount} clients:`,
  );
  if (direct.feedbackCount < minFeedbackCount) {
    console.log(
      `    DENY  NO_HISTORY — only ${direct.feedbackCount} distinct client(s)`,
    );
  } else if (direct.score < minReputation) {
    console.log(
      `    DENY  LOW_REPUTATION — ${direct.score} < ${minReputation}`,
    );
  } else {
    console.log(`    ALLOW — clears both thresholds`);
  }

  // The guard wraps every source in a timeout. Worth seeing whether a live
  // registry read fits inside a payment's latency budget on this network.
  const wrapped = guarded(raw, { timeoutMs: 1500 });
  const t2 = Date.now();
  const viaGuard = await wrapped.score(target);
  console.log(
    `\n  Through guarded() with a 1500ms timeout: ` +
      `${viaGuard ? "answered" : "TIMED OUT -> would deny"} in ${Date.now() - t2}ms`,
  );
  if (!viaGuard && elapsed > 1400) {
    console.log(
      `  The registry read is slower than the guard's budget. Raise timeoutMs,\n` +
        `  or accept that reputation lookups fail closed on this network.`,
    );
  }
  console.log();
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
