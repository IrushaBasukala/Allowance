import type { Reputation } from "@allowance/policy";

/**
 * Anything that can answer "what is this counterparty's track record?"
 *
 * The contract is deliberately forgiving in one direction and strict in another:
 *
 *   - Returning `null` means "I could not answer." That is a legitimate outcome,
 *     and the evaluator turns it into REPUTATION_UNAVAILABLE (a denial).
 *   - Throwing is NOT part of the contract. A source that throws will crash the
 *     agent instead of denying the payment, which converts a safe failure into
 *     an outage. Wrap any real source in `guarded()` before using it.
 *
 * Step 6 replaces the static implementation with a Subgraph client. Nothing
 * downstream changes, because nothing downstream knows the difference.
 */
export interface ReputationSource {
  readonly kind: string;
  score(counterparty: string): Promise<Reputation | null>;
}

/**
 * Fixture-backed source. Used for tests, for the demo, and as the fallback
 * whenever the subgraph is unreachable during development.
 *
 * The fixtures below are the cast of the demo video: each one exists to
 * trigger a specific decision path.
 */
export class StaticReputationSource implements ReputationSource {
  readonly kind = "static";

  constructor(private readonly table: Record<string, Reputation | null>) {}

  async score(counterparty: string): Promise<Reputation | null> {
    return this.table[counterparty] ?? null;
  }
}

const src = "static:fixtures";

/** Named fixtures, so tests read as scenarios rather than magic numbers. */
export const DEMO_REPUTATIONS: Record<string, Reputation> = {
  // Established provider — clears any reasonable bar.
  "0.0.7778888": { score: 820, feedbackCount: 34, source: src },
  // Sybil: a flawless score resting on a single self-issued attestation.
  "0.0.4443333": { score: 1000, feedbackCount: 1, source: src },
  // Known-bad: plenty of history, and the history is poor.
  "0.0.666": { score: 120, feedbackCount: 9, source: src },
  // Borderline: sits just under a 600 threshold, to test the boundary.
  "0.0.5150000": { score: 599, feedbackCount: 12, source: src },
};

export function demoReputationSource(): ReputationSource {
  return new StaticReputationSource({ ...DEMO_REPUTATIONS });
}
