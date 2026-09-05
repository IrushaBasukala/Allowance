import type { Receipt } from "./receipt.js";

/**
 * How much has been spent in the trailing window.
 *
 * This is the function that makes the audit trail load-bearing rather than
 * decorative. Spend is not a counter we keep and happen to log — it is
 * *derived* from the log. Delete the receipts and the evaluator can no longer
 * compute its own limits.
 *
 * Two rules, both deliberate:
 *
 *   - Only ALLOW receipts count. A refused payment moved no money, so counting
 *     it would let an attacker exhaust your budget purely by making requests
 *     that fail. Denials are recorded, never charged.
 *
 *   - Only matching currency counts. An envelope denominated in HBAR must not
 *     have its window consumed by payments in some HTS token.
 *
 * The window is rolling: always the trailing `windowSeconds` from `now`, never
 * a calendar boundary. Midnight-to-midnight is exploitable — spend the full
 * limit at 23:59 and the whole limit again two minutes later.
 */
export function windowSpend(
  receipts: readonly Receipt[],
  opts: {
    now: bigint;
    windowSeconds: bigint;
    envelopeId: string;
    currency: string;
  },
): bigint {
  const cutoff = Number(opts.now - opts.windowSeconds);
  let total = 0n;

  for (const r of receipts) {
    if (r.d !== "ALLOW") continue;
    if (r.eid !== opts.envelopeId) continue;
    if (r.cur !== opts.currency) continue;
    if (r.ts <= cutoff) continue; // strictly inside the window
    if (r.ts > Number(opts.now)) continue; // ignore anything clock-skewed into the future

    try {
      total += BigInt(r.amt);
    } catch {
      // A malformed amount on a public topic must not corrupt the total.
      continue;
    }
  }
  return total;
}

/** Earliest timestamp still relevant to a window — the fetch bound for a replay. */
export function windowStart(now: bigint, windowSeconds: bigint): number {
  return Number(now - windowSeconds);
}
