import type { Envelope } from "@allowance/envelope";
import {
  evaluate,
  Reason,
  type Decision,
  type PaymentRequest,
} from "@allowance/policy";
import {
  resolveReputation,
  type ReputationSource,
} from "@allowance/reputation";
import {
  buildReceipt,
  type ReceiptSink,
  type SpendTracker,
} from "@allowance/receipts";
import type { Address } from "viem";

const HBAR_ASSET_ID = "0.0.0";

export interface GuardDeps {
  envelope: Envelope;
  principal: Address | null;
  reputation: ReputationSource;
  tracker: SpendTracker;
  receipts: ReceiptSink;
  now?: () => bigint;
  onDecision?: (d: Decision, r: PaymentRequest) => void;
  onError?: (err: unknown) => void;
}

export interface Guard {
  beforePaymentCreation: (context: {
    selectedRequirements?: Record<string, unknown>;
  }) => Promise<void | { abort: true; reason: string }>;
  onPaymentResponse: (context: unknown) => Promise<void>;
}

function readRequirements(req: Record<string, unknown>): {
  counterparty: string;
  amount: bigint;
  currency: string;
} | null {
  const payTo =
    typeof req["payTo"] === "string" ? (req["payTo"] as string) : null;
  const rawAmount = req["amount"];
  const asset =
    typeof req["asset"] === "string" ? (req["asset"] as string) : null;
  if (!payTo || !asset) return null;

  let amount: bigint;
  try {
    if (typeof rawAmount === "string" || typeof rawAmount === "number") {
      amount = BigInt(rawAmount);
    } else if (typeof rawAmount === "bigint") {
      amount = rawAmount;
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const currency = asset === HBAR_ASSET_ID ? "HBAR" : asset;

  return { counterparty: payTo, amount, currency };
}

export function createGuard(deps: GuardDeps): Guard {
  const clock = deps.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));

  // Held between the two hooks: authorized but not yet settled.
  let inFlight: { request: PaymentRequest; decision: Decision } | null = null;

  return {
    async beforePaymentCreation(context) {
      try {
        return await decide(context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.onError?.(err);
        const request: PaymentRequest = {
          agent: deps.envelope.agent,
          counterparty: "unknown",
          amount: 0n,
          currency: deps.envelope.currency,
        };
        const decision: Decision = {
          decision: "DENY",
          reason: Reason.GUARD_ERROR,
          message: `Guard failed: ${message}`,
          evidence: {},
        };
        deps.onDecision?.(decision, request);
        try {
          await deps.receipts.write(
            buildReceipt(deps.envelope, request, decision, { now: clock() }),
          );
        } catch {}
        return { abort: true, reason: Reason.GUARD_ERROR };
      }
    },

    onPaymentResponse: onPaymentResponseImpl,
  };

  async function decide(context: {
    selectedRequirements?: Record<string, unknown>;
  }): Promise<void | { abort: true; reason: string }> {
    const now = clock();
    const parsed = readRequirements(context.selectedRequirements ?? {});

    if (!parsed) {
      const decision: Decision = {
        decision: "DENY",
        reason: Reason.UNREADABLE_REQUIREMENTS,
        message: "Payment requirements could not be interpreted",
        evidence: {},
      };
      const unknown: PaymentRequest = {
        agent: deps.envelope.agent,
        counterparty: "unknown",
        amount: 0n,
        currency: deps.envelope.currency,
      };
      deps.onDecision?.(decision, unknown);
      await deps.receipts.write(
        buildReceipt(deps.envelope, unknown, decision, { now }),
      );
      return { abort: true, reason: Reason.UNREADABLE_REQUIREMENTS };
    }

    const request: PaymentRequest = {
      agent: deps.envelope.agent,
      counterparty: parsed.counterparty,
      amount: parsed.amount,

      currency: parsed.currency,
    };

    const spentInWindow = await deps.tracker.spentInWindow(now);
    const reputation = await resolveReputation(
      deps.envelope,
      request,
      deps.reputation,
    );

    const decision = evaluate(deps.envelope, request, {
      now,
      principal: deps.principal,
      spentInWindow,
      reputation,
    });

    deps.onDecision?.(decision, request);

    if (decision.decision === "DENY") {
      await deps.receipts.write(
        buildReceipt(deps.envelope, request, decision, { now }),
      );
      return { abort: true, reason: decision.reason };
    }

    inFlight = { request, decision };
    return;
  }

  async function onPaymentResponseImpl(context: unknown): Promise<void> {
    if (!inFlight) return;
    const { request, decision } = inFlight;
    inFlight = null;

    const ctx = context as {
      response?: { headers?: { get?: (k: string) => string | null } };
    };
    const paymentRef =
      ctx?.response?.headers?.get?.("x-payment-response") ?? undefined;

    const now = clock();
    await deps.receipts.write(
      buildReceipt(deps.envelope, request, decision, {
        now,
        paymentRef: paymentRef ?? undefined,
      }),
    );

    deps.tracker.noteAllowed(request.amount);
  }
}

export { Reason };
