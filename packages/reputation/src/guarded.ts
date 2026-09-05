import type { Reputation } from "@allowance/policy";
import type { ReputationSource } from "./source.js";

export interface GuardOptions {
  /** Give up after this long and report unavailable. */
  timeoutMs?: number;
  /** How long a positive answer stays fresh. Keep this short. */
  cacheTtlMs?: number;
  /** Injectable clock, so tests don't sleep. */
  clock?: () => number;
}

interface Entry {
  value: Reputation | null;
  expiresAt: number;
}

/**
 * Wraps a ReputationSource so it can never break the agent.
 *
 * Three jobs:
 *
 * 1. TIMEOUT. A payment decision has a latency budget. A subgraph that hangs
 *    must become a denial, not a stalled agent.
 *
 * 2. CONTAIN ERRORS. Any throw becomes `null`. This is what actually makes
 *    fail-closed work: the evaluator can only deny on unavailable data if it
 *    is handed `null` rather than an exception propagating past it.
 *
 * 3. CACHE, BRIEFLY. The Graph is rate-limited and an agent may hit the same
 *    provider many times in a burst. Reputation moves slowly, so a short TTL
 *    is safe — but only a short one. A long TTL means a counterparty that has
 *    just been downgraded keeps getting paid, which is precisely the failure
 *    the reputation check exists to prevent.
 *
 * Negative results are cached for a fraction of the TTL: an outage should
 * resolve quickly once the source recovers, so we retry sooner than we
 * re-verify a known-good answer.
 */
export function guarded(
  inner: ReputationSource,
  opts: GuardOptions = {},
): ReputationSource {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const ttl = opts.cacheTtlMs ?? 30_000;
  const negativeTtl = Math.floor(ttl / 6);
  const clock = opts.clock ?? Date.now;
  const cache = new Map<string, Entry>();

  return {
    kind: `guarded(${inner.kind})`,

    async score(counterparty: string): Promise<Reputation | null> {
      const now = clock();

      const hit = cache.get(counterparty);
      if (hit && hit.expiresAt > now) return hit.value;

      let value: Reputation | null = null;
      try {
        value = await Promise.race([
          inner.score(counterparty),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), timeoutMs).unref?.(),
          ),
        ]);
      } catch {
        // Deliberately swallowed. An unreachable source is a denial,
        // not a crash. The reason code makes it visible either way.
        value = null;
      }

      cache.set(counterparty, {
        value,
        expiresAt: now + (value === null ? negativeTtl : ttl),
      });
      return value;
    },
  };
}
