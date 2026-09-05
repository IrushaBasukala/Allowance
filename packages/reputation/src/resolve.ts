import type { Envelope } from "@allowance/envelope";
import {
  needsReputation,
  type PaymentRequest,
  type Reputation,
} from "@allowance/policy";
import type { ReputationSource } from "./source.js";

/**
 * Produce the `reputation` field for an EvaluationContext.
 *
 * The three-state return is meaningful and matches EvaluationContext exactly:
 *
 *   undefined  — no lookup was needed (allowlisted, or the mode never checks)
 *   null       — a lookup was attempted and failed  -> REPUTATION_UNAVAILABLE
 *   Reputation — a real answer
 *
 * Keeping "not needed" distinct from "failed" is what lets the console show
 * `reputation lookup: skipped` instead of implying an outage, and it is why
 * an allowlisted payment still succeeds while The Graph is down.
 */
export async function resolveReputation(
  envelope: Envelope,
  request: PaymentRequest,
  source: ReputationSource,
): Promise<Reputation | null | undefined> {
  if (!needsReputation(envelope, request)) return undefined;
  return source.score(request.counterparty);
}
