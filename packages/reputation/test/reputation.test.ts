import { describe, it, expect } from "vitest";
import { CounterpartyMode, type Envelope } from "@allowance/envelope";
import type { PaymentRequest, Reputation } from "@allowance/policy";
import {
  StaticReputationSource,
  demoReputationSource,
  guarded,
  resolveReputation,
  type ReputationSource,
} from "../src/index.js";

const TRUSTED = "0.0.5551212";
const STRANGER = "0.0.7778888";

function env(o: Partial<Envelope> = {}): Envelope {
  return {
    version: "1",
    envelopeId: `0x${"ab".repeat(32)}`,
    principal: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    agent: "0.0.4417542",
    currency: "HBAR",
    perCall: 200_000_000n,
    perWindow: 5_000_000_000n,
    windowSeconds: 86_400n,
    counterpartyMode: CounterpartyMode.AllowlistOrReputation,
    allowlist: [TRUSTED],
    minReputation: 600,
    minFeedbackCount: 5,
    notBefore: 0n,
    notAfter: 9_999_999_999n,
    receiptTopic: "0.0.98765",
    ...o,
  };
}

const req = (counterparty: string): PaymentRequest => ({
  agent: "0.0.4417542",
  counterparty,
  amount: 40_000_000n,
  currency: "HBAR",
});

describe("StaticReputationSource", () => {
  it("returns known fixtures", async () => {
    const r = await demoReputationSource().score(STRANGER);
    expect(r?.score).toBe(820);
    expect(r?.feedbackCount).toBe(34);
  });

  it("returns null for anyone unknown", async () => {
    expect(await demoReputationSource().score("0.0.0000001")).toBeNull();
  });
});

describe("guarded", () => {
  const rep: Reputation = { score: 700, feedbackCount: 10, source: "t" };

  it("passes through a successful answer", async () => {
    const g = guarded(new StaticReputationSource({ [STRANGER]: rep }));
    expect(await g.score(STRANGER)).toEqual(rep);
  });

  it("turns a thrown error into null rather than crashing", async () => {
    const boom: ReputationSource = {
      kind: "boom",
      async score() {
        throw new Error("subgraph unreachable");
      },
    };
    await expect(guarded(boom).score(STRANGER)).resolves.toBeNull();
  });

  it("times out slow sources into null", async () => {
    const slow: ReputationSource = {
      kind: "slow",
      score: () => new Promise((r) => setTimeout(() => r(rep), 200)),
    };
    const started = Date.now();
    expect(await guarded(slow, { timeoutMs: 20 }).score(STRANGER)).toBeNull();
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("caches, so a burst hits the source once", async () => {
    let calls = 0;
    const counting: ReputationSource = {
      kind: "counting",
      async score() {
        calls++;
        return rep;
      },
    };
    const g = guarded(counting, { cacheTtlMs: 10_000 });
    await g.score(STRANGER);
    await g.score(STRANGER);
    await g.score(STRANGER);
    expect(calls).toBe(1);
  });

  it("re-queries once the entry goes stale", async () => {
    let calls = 0;
    let t = 1000;
    const counting: ReputationSource = {
      kind: "counting",
      async score() {
        calls++;
        return rep;
      },
    };
    const g = guarded(counting, { cacheTtlMs: 5000, clock: () => t });
    await g.score(STRANGER);
    t += 6000;
    await g.score(STRANGER);
    expect(calls).toBe(2);
  });

  it("retries a failure sooner than it re-checks a success", async () => {
    let calls = 0;
    let t = 1000;
    const flaky: ReputationSource = {
      kind: "flaky",
      async score() {
        calls++;
        return null;
      },
    };
    const g = guarded(flaky, { cacheTtlMs: 6000, clock: () => t });
    await g.score(STRANGER);
    t += 1500; // past the negative TTL (1000ms), well short of the positive one
    await g.score(STRANGER);
    expect(calls).toBe(2);
  });
});

describe("resolveReputation", () => {
  const source = demoReputationSource();

  it("returns undefined — not null — when no lookup is needed", async () => {
    const r = await resolveReputation(env(), req(TRUSTED), source);
    expect(r).toBeUndefined();
  });

  it("distinguishes 'not needed' from 'lookup failed'", async () => {
    const skipped = await resolveReputation(env(), req(TRUSTED), source);
    const failed = await resolveReputation(env(), req("0.0.0000001"), source);
    expect(skipped).toBeUndefined();
    expect(failed).toBeNull();
  });

  it("looks up a stranger", async () => {
    const r = await resolveReputation(env(), req(STRANGER), source);
    expect(r).not.toBeNull();
    expect(r?.score).toBe(820);
  });

  it("never looks up under AllowlistOnly", async () => {
    let calls = 0;
    const counting: ReputationSource = {
      kind: "counting",
      async score() {
        calls++;
        return null;
      },
    };
    const e = env({ counterpartyMode: CounterpartyMode.AllowlistOnly });
    await resolveReputation(e, req(STRANGER), counting);
    expect(calls).toBe(0);
  });

  it("allowlisted payments still work while the source is down", async () => {
    const down: ReputationSource = {
      kind: "down",
      async score() {
        throw new Error("down");
      },
    };
    const r = await resolveReputation(env(), req(TRUSTED), guarded(down));
    expect(r).toBeUndefined();
  });
});
