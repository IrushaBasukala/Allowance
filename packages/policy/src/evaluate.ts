import { CounterpartyMode, type Envelope } from "@allowance/envelope";
import {
  Reason,
  REASON_TEXT,
  type Decision,
  type EvaluationContext,
  type Evidence,
  type PaymentRequest,
  type ReasonCode,
} from "./reasons.js";

function deny(reason: ReasonCode, evidence: Evidence = {}): Decision {
  return {
    decision: "DENY",
    reason,
    message: REASON_TEXT[reason],
    evidence,
  };
}

function allow(evidence: Evidence = {}): Decision {
  return {
    decision: "ALLOW",
    reason: Reason.OK,
    message: REASON_TEXT[Reason.OK],
    evidence,
  };
}

/**
 * Does this request require a reputation lookup?
 *
 * Called BEFORE evaluate() so the caller can skip a network round-trip when
 * the counterparty is already allowlisted. Pure, and cheap enough to call freely.
 */
export function needsReputation(
  envelope: Envelope,
  request: PaymentRequest,
): boolean {
  const listed = envelope.allowlist.includes(request.counterparty);
  switch (envelope.counterpartyMode) {
    case CounterpartyMode.AllowlistOnly:
      return false;
    case CounterpartyMode.ReputationOnly:
      return true;
    case CounterpartyMode.AllowlistOrReputation:
      return !listed; // the list is a bypass
    default:
      return true; // unknown mode: assume the stricter path
  }
}

function checkReputation(
  envelope: Envelope,
  ctx: EvaluationContext,
  base: Evidence,
): Decision {
  // Fail closed. If we could not learn anything about this counterparty,
  // we refuse. Failing open would make knocking out the data source an
  // attack strategy rather than an inconvenience.
  if (ctx.reputation === undefined || ctx.reputation === null) {
    return deny(Reason.REPUTATION_UNAVAILABLE, {
      ...base,
      reputationScore: null,
      feedbackCount: null,
      reputationSource: null,
    });
  }

  const ev: Evidence = {
    ...base,
    reputationScore: ctx.reputation.score,
    feedbackCount: ctx.reputation.feedbackCount,
    reputationSource: ctx.reputation.source,
    minReputation: envelope.minReputation,
    minFeedbackCount: envelope.minFeedbackCount,
  };

  // Depth before height: a perfect score from one self-issued attestation
  // is worth less than a good score across many distinct counterparties.
  if (ctx.reputation.feedbackCount < envelope.minFeedbackCount) {
    return deny(Reason.NO_HISTORY, ev);
  }
  if (ctx.reputation.score < envelope.minReputation) {
    return deny(Reason.LOW_REPUTATION, ev);
  }
  return allow(ev);
}

/**
 * The whole decision, in one pure function.
 *
 * Checks run cheapest-and-most-certain first, so an obviously bad request is
 * refused without ever reaching the one check that costs a network call.
 */
export function evaluate(
  envelope: Envelope,
  request: PaymentRequest,
  ctx: EvaluationContext,
): Decision {
  // 1. Authority. Nothing else matters if the envelope isn't genuinely the
  //    owner's. Note that TrustRoot.verify already confirms the recovered
  //    signer matches envelope.principal — a valid signature by the wrong
  //    person arrives here as null.
  if (ctx.principal === null) return deny(Reason.BAD_SIGNATURE);

  // 2. Validity period.
  if (ctx.now < envelope.notBefore) return deny(Reason.ENVELOPE_NOT_YET_VALID);
  if (ctx.now > envelope.notAfter) return deny(Reason.ENVELOPE_EXPIRED);

  // 3. Scope. Does this envelope even describe this request?
  if (request.agent !== envelope.agent) return deny(Reason.WRONG_AGENT);
  if (request.currency !== envelope.currency)
    return deny(Reason.WRONG_CURRENCY);
  if (request.amount <= 0n) return deny(Reason.INVALID_AMOUNT);

  // 4. Limits. Local arithmetic — no I/O.
  if (request.amount > envelope.perCall) {
    return deny(Reason.OVER_PER_CALL, {
      perCall: envelope.perCall.toString(),
    });
  }

  const wouldTotal = ctx.spentInWindow + request.amount;
  if (wouldTotal > envelope.perWindow) {
    return deny(Reason.WINDOW_EXHAUSTED, {
      perWindow: envelope.perWindow.toString(),
      spentInWindow: ctx.spentInWindow.toString(),
      wouldTotal: wouldTotal.toString(),
    });
  }

  // 5. Counterparty. The only check that may need the network, so it runs last.
  const listed = envelope.allowlist.includes(request.counterparty);
  const base: Evidence = {
    allowlisted: listed,
    spentInWindow: ctx.spentInWindow.toString(),
    wouldTotal: wouldTotal.toString(),
  };

  switch (envelope.counterpartyMode) {
    case CounterpartyMode.AllowlistOnly:
      return listed ? allow(base) : deny(Reason.NOT_ALLOWLISTED, base);

    case CounterpartyMode.ReputationOnly:
      return checkReputation(envelope, ctx, base);

    case CounterpartyMode.AllowlistOrReputation:
      return listed ? allow(base) : checkReputation(envelope, ctx, base);

    default:
      // An envelope carrying a mode we don't recognise is not something to
      // guess about. Treat it as untrusted.
      return deny(Reason.NOT_ALLOWLISTED, base);
  }
}
