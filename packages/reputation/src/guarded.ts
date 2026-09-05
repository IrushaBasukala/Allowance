import type { Reputation } from "@allowance/policy";
import type { ReputationSource } from "./source.js";

export interface GuardOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  clock?: () => number;
}

interface Entry {
  value: Reputation | null;
  expiresAt: number;
}

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
