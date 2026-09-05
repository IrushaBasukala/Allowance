import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { CounterpartyMode, type Envelope } from "@allowance/envelope";
import {
  evaluate,
  needsReputation,
  Reason,
  type EvaluationContext,
  type PaymentRequest,
  type Reputation,
} from "../src/index.js";

const owner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const HBAR = 100_000_000n;
const NOW = 1_760_000_000n;
const AGENT = "0.0.4417542";
const TRUSTED = "0.0.5551212"; // on the allowlist
const STRANGER = "0.0.7778888"; // not on the list
const ATTACKER = "0.0.666";

function env(o: Partial<Envelope> = {}): Envelope {
  return {
    version: "1",
    envelopeId: `0x${"ab".repeat(32)}`,
    principal: owner.address,
    agent: AGENT,
    currency: "HBAR",
    perCall: 2n * HBAR,
    perWindow: 50n * HBAR,
    windowSeconds: 86_400n,
    counterpartyMode: CounterpartyMode.AllowlistOrReputation,
    allowlist: [TRUSTED],
    minReputation: 600,
    minFeedbackCount: 5,
    notBefore: NOW - 1000n,
    notAfter: NOW + 1000n,
    receiptTopic: "0.0.98765",
    ...o,
  };
}

function req(o: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    agent: AGENT,
    counterparty: TRUSTED,
    amount: 40_000_000n, // 0.4 HBAR
    currency: "HBAR",
    ...o,
  };
}

function ctx(o: Partial<EvaluationContext> = {}): EvaluationContext {
  return { now: NOW, principal: owner.address, spentInWindow: 0n, ...o };
}

const good: Reputation = {
  score: 820,
  feedbackCount: 34,
  source: "thegraph:erc8004-base",
};

describe("happy path", () => {
  it("allows a small payment to an allowlisted counterparty", () => {
    const d = evaluate(env(), req(), ctx());
    expect(d.decision).toBe("ALLOW");
    expect(d.evidence.allowlisted).toBe(true);
  });
});

describe("authority", () => {
  it("denies when the signature did not hold", () => {
    const d = evaluate(env(), req(), ctx({ principal: null }));
    expect(d.reason).toBe(Reason.BAD_SIGNATURE);
  });

  it("denies before the envelope is active", () => {
    const d = evaluate(env({ notBefore: NOW + 500n }), req(), ctx());
    expect(d.reason).toBe(Reason.ENVELOPE_NOT_YET_VALID);
  });

  it("denies after expiry", () => {
    const d = evaluate(env({ notAfter: NOW - 1n }), req(), ctx());
    expect(d.reason).toBe(Reason.ENVELOPE_EXPIRED);
  });
});

describe("scope", () => {
  it("denies an envelope issued to a different agent", () => {
    const d = evaluate(env(), req({ agent: "0.0.9999999" }), ctx());
    expect(d.reason).toBe(Reason.WRONG_AGENT);
  });

  it("denies a currency mismatch", () => {
    const d = evaluate(env(), req({ currency: "0.0.1234" }), ctx());
    expect(d.reason).toBe(Reason.WRONG_CURRENCY);
  });

  it("denies a zero or negative amount", () => {
    expect(evaluate(env(), req({ amount: 0n }), ctx()).reason).toBe(
      Reason.INVALID_AMOUNT,
    );
  });
});

describe("limits", () => {
  // The prompt-injection scene in the demo.
  it("denies a payment over the per-call limit", () => {
    const d = evaluate(
      env(),
      req({ counterparty: ATTACKER, amount: 500n * HBAR }),
      ctx(),
    );
    expect(d.reason).toBe(Reason.OVER_PER_CALL);
    expect(d.evidence.perCall).toBe((2n * HBAR).toString());
  });

  // The runaway-loop scene.
  it("denies when the window would be exceeded", () => {
    const d = evaluate(
      env(),
      req({ amount: 1n * HBAR }),
      ctx({ spentInWindow: 49n * HBAR + 50_000_000n }),
    );
    expect(d.reason).toBe(Reason.WINDOW_EXHAUSTED);
    expect(d.evidence.wouldTotal).toBe((50n * HBAR + 50_000_000n).toString());
  });

  it("allows a payment that lands exactly on the window limit", () => {
    const d = evaluate(
      env(),
      req({ amount: 1n * HBAR }),
      ctx({ spentInWindow: 49n * HBAR }),
    );
    expect(d.decision).toBe("ALLOW");
  });

  it("checks the per-call limit before the window", () => {
    const d = evaluate(
      env(),
      req({ amount: 500n * HBAR }),
      ctx({ spentInWindow: 49n * HBAR }),
    );
    expect(d.reason).toBe(Reason.OVER_PER_CALL);
  });
});

describe("counterparty — AllowlistOnly", () => {
  const e = env({ counterpartyMode: CounterpartyMode.AllowlistOnly });

  it("allows a listed recipient", () => {
    expect(evaluate(e, req(), ctx()).decision).toBe("ALLOW");
  });

  it("denies a stranger even with perfect reputation", () => {
    const d = evaluate(
      e,
      req({ counterparty: STRANGER }),
      ctx({ reputation: { score: 1000, feedbackCount: 900, source: "x" } }),
    );
    expect(d.reason).toBe(Reason.NOT_ALLOWLISTED);
  });

  it("never requires a reputation lookup", () => {
    expect(needsReputation(e, req({ counterparty: STRANGER }))).toBe(false);
  });
});

describe("counterparty — AllowlistOrReputation", () => {
  const e = env();

  it("skips the lookup for an allowlisted recipient", () => {
    expect(needsReputation(e, req())).toBe(false);
    // No reputation supplied at all, and it still passes.
    expect(evaluate(e, req(), ctx()).decision).toBe("ALLOW");
  });

  it("requires a lookup for a stranger", () => {
    expect(needsReputation(e, req({ counterparty: STRANGER }))).toBe(true);
  });

  it("allows a well-reviewed stranger", () => {
    const d = evaluate(
      e,
      req({ counterparty: STRANGER }),
      ctx({ reputation: good }),
    );
    expect(d.decision).toBe("ALLOW");
    expect(d.evidence.reputationScore).toBe(820);
  });

  it("denies a stranger whose score is too low", () => {
    const d = evaluate(
      e,
      req({ counterparty: STRANGER }),
      ctx({ reputation: { ...good, score: 401 } }),
    );
    expect(d.reason).toBe(Reason.LOW_REPUTATION);
  });

  // The sybil scene: perfect score, one review.
  it("denies a perfect score backed by too little history", () => {
    const d = evaluate(
      e,
      req({ counterparty: STRANGER }),
      ctx({ reputation: { score: 1000, feedbackCount: 1, source: "s" } }),
    );
    expect(d.reason).toBe(Reason.NO_HISTORY);
  });

  it("checks history depth before score", () => {
    const d = evaluate(
      e,
      req({ counterparty: STRANGER }),
      ctx({ reputation: { score: 10, feedbackCount: 1, source: "s" } }),
    );
    expect(d.reason).toBe(Reason.NO_HISTORY);
  });
});

describe("fail closed", () => {
  it("denies when the reputation lookup failed", () => {
    const d = evaluate(
      env(),
      req({ counterparty: STRANGER }),
      ctx({ reputation: null }),
    );
    expect(d.reason).toBe(Reason.REPUTATION_UNAVAILABLE);
  });

  it("denies when reputation was never fetched", () => {
    const d = evaluate(env(), req({ counterparty: STRANGER }), ctx());
    expect(d.reason).toBe(Reason.REPUTATION_UNAVAILABLE);
  });

  it("denies an unrecognised counterparty mode", () => {
    const d = evaluate(env({ counterpartyMode: 99 }), req(), ctx());
    expect(d.decision).toBe("DENY");
  });
});

describe("check ordering", () => {
  it("reports the cheapest failure when several apply", () => {
    // Bad signature, expired, wrong agent, over limit, unknown recipient.
    const d = evaluate(
      env({ notAfter: NOW - 1n }),
      req({ agent: "0.0.1", counterparty: ATTACKER, amount: 900n * HBAR }),
      ctx({ principal: null }),
    );
    expect(d.reason).toBe(Reason.BAD_SIGNATURE);
  });
});
