import type { Address } from "viem";

/**
 * Every possible outcome of a spending decision.
 *
 * These strings are user-facing: they appear in receipts, in the console,
 * and on screen in the demo. Treat them as part of the public interface —
 * renaming one changes the meaning of every historical receipt.
 */
export const Reason = {
  OK: "OK",

  // Authority — is this envelope real and current?
  BAD_SIGNATURE: "BAD_SIGNATURE",
  ENVELOPE_NOT_YET_VALID: "ENVELOPE_NOT_YET_VALID",
  ENVELOPE_EXPIRED: "ENVELOPE_EXPIRED",

  // Scope — does this envelope even cover this request?
  WRONG_AGENT: "WRONG_AGENT",
  WRONG_CURRENCY: "WRONG_CURRENCY",
  INVALID_AMOUNT: "INVALID_AMOUNT",

  // Limits — how much?
  OVER_PER_CALL: "OVER_PER_CALL",
  WINDOW_EXHAUSTED: "WINDOW_EXHAUSTED",

  // Counterparty — to whom?
  NOT_ALLOWLISTED: "NOT_ALLOWLISTED",
  NO_HISTORY: "NO_HISTORY",
  LOW_REPUTATION: "LOW_REPUTATION",
  REPUTATION_UNAVAILABLE: "REPUTATION_UNAVAILABLE",
  UNREADABLE_REQUIREMENTS: "UNREADABLE_REQUIREMENTS",
  /** The guard itself failed. A crash is not a decision — it is a denial. */
  GUARD_ERROR: "GUARD_ERROR",
} as const;

export type ReasonCode = (typeof Reason)[keyof typeof Reason];

/** Plain-English text for receipts and UI. Keep these short enough to read on one line. */
export const REASON_TEXT: Record<ReasonCode, string> = {
  OK: "Within the authorized envelope",
  BAD_SIGNATURE: "Envelope signature does not match the stated owner",
  ENVELOPE_NOT_YET_VALID: "Envelope is not active yet",
  ENVELOPE_EXPIRED: "Envelope has expired",
  WRONG_AGENT: "This envelope was not issued to this agent",
  WRONG_CURRENCY: "Payment currency does not match the envelope",
  INVALID_AMOUNT: "Payment amount must be greater than zero",
  OVER_PER_CALL: "Exceeds the per-payment limit",
  WINDOW_EXHAUSTED: "Would exceed the spending limit for this window",
  NOT_ALLOWLISTED: "Recipient is not on the approved list",
  NO_HISTORY: "Recipient has too little verifiable history",
  LOW_REPUTATION: "Recipient's reputation is below the required threshold",
  REPUTATION_UNAVAILABLE: "Reputation data unavailable — denying by default",
  UNREADABLE_REQUIREMENTS: "Payment requirements could not be interpreted",
  GUARD_ERROR: "The spending guard could not complete a check",
};

/** What the agent is proposing to do. */
export interface PaymentRequest {
  agent: string;
  counterparty: string;
  amount: bigint;
  currency: string;
}

export interface Reputation {
  score: number; // 0..1000
  feedbackCount: number; // distinct counterparties who left feedback
  source: string; // e.g. "thegraph:erc8004-base"
}

/**
 * Everything the evaluator needs from the outside world, passed in explicitly.
 *
 * The evaluator makes no network calls and reads no clock. That is what lets us
 * test every decision path in milliseconds, and what lets the same logic run
 * unchanged whether reputation comes from The Graph or a stub.
 */
export interface EvaluationContext {
  /** Unix seconds. Injected, never read from the system clock. */
  now: bigint;
  /** Result of TrustRoot.verify. null means the signature did not hold. */
  principal: Address | null;
  /** Total already spent in the trailing window, from replayed receipts. */
  spentInWindow: bigint;
  /**
   * undefined — not looked up (only valid when needsReputation() is false)
   * null      — lookup was attempted and failed
   * Reputation — a real answer
   */
  reputation?: Reputation | null;
}

export interface Evidence {
  perCall?: string;
  perWindow?: string;
  spentInWindow?: string;
  wouldTotal?: string;
  allowlisted?: boolean;
  reputationScore?: number | null;
  feedbackCount?: number | null;
  reputationSource?: string | null;
  minReputation?: number;
  minFeedbackCount?: number;
}

export interface Decision {
  decision: "ALLOW" | "DENY";
  reason: ReasonCode;
  message: string;
  evidence: Evidence;
}
