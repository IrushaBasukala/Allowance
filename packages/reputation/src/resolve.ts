import type { Envelope } from "@allowance/envelope";
import {
  needsReputation,
  type PaymentRequest,
  type Reputation,
} from "@allowance/policy";
import type { ReputationSource } from "./source.js";

export async function resolveReputation(
  envelope: Envelope,
  request: PaymentRequest,
  source: ReputationSource,
): Promise<Reputation | null | undefined> {
  if (!needsReputation(envelope, request)) return undefined;
  return source.score(request.counterparty);
}
