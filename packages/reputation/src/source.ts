import type { Reputation } from "@allowance/policy";

export interface ReputationSource {
  readonly kind: string;
  score(counterparty: string): Promise<Reputation | null>;
}

export class StaticReputationSource implements ReputationSource {
  readonly kind = "static";

  constructor(private readonly table: Record<string, Reputation | null>) {}

  async score(counterparty: string): Promise<Reputation | null> {
    return this.table[counterparty] ?? null;
  }
}

const src = "static:fixtures";

export const DEMO_REPUTATIONS: Record<string, Reputation> = {
  "0.0.7778888": { score: 820, feedbackCount: 34, source: src },
  "0.0.4443333": { score: 1000, feedbackCount: 1, source: src },
  "0.0.666": { score: 120, feedbackCount: 9, source: src },
  "0.0.5150000": { score: 599, feedbackCount: 12, source: src },
};

export function demoReputationSource(): ReputationSource {
  return new StaticReputationSource({ ...DEMO_REPUTATIONS });
}
