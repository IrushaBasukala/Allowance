import type { Decision, PaymentRequest } from "@allowance/policy";
import type { Envelope } from "@allowance/envelope";
import { envelopeHash } from "@allowance/envelope";

/**
 * A single decision, written to HCS.
 *
 * Field names are deliberately terse. HCS charges per message and a
 * TopicMessageSubmitTransaction chunks above ~1KB, which turns one logical
 * receipt into several network round-trips. Short keys keep a typical receipt
 * comfortably inside one chunk.
 *
 * `eh` (the envelope hash) is what makes a receipt self-contained: an auditor
 * can prove which envelope governed the decision without us storing the
 * envelope alongside it, and without trusting our copy of it.
 */
export interface Receipt {
  v: 1;
  eid: string; // envelope id
  eh: string; // envelope hash — binds the decision to exact terms
  ts: number; // unix seconds, when we made the call
  ag: string; // agent
  cp: string; // counterparty
  amt: string; // amount, smallest unit, as a string (bigint is not JSON)
  cur: string; // currency
  d: "ALLOW" | "DENY";
  r: string; // reason code
  ev?: Record<string, unknown>; // evidence
  pay?: string; // x402 settlement reference, when the payment went through
}

export function buildReceipt(
  envelope: Envelope,
  request: PaymentRequest,
  decision: Decision,
  opts: { now: bigint; paymentRef?: string },
): Receipt {
  const r: Receipt = {
    v: 1,
    eid: envelope.envelopeId,
    eh: envelopeHash(envelope),
    ts: Number(opts.now),
    ag: request.agent,
    cp: request.counterparty,
    amt: request.amount.toString(),
    cur: request.currency,
    d: decision.decision,
    r: decision.reason,
  };
  if (Object.keys(decision.evidence).length > 0) {
    r.ev = { ...decision.evidence };
  }
  if (opts.paymentRef) r.pay = opts.paymentRef;
  return r;
}

/** Canonical JSON — key order fixed, so the same receipt always encodes identically. */
export function encodeReceipt(receipt: Receipt): string {
  const ordered: Record<string, unknown> = {};
  for (const k of [
    "v",
    "eid",
    "eh",
    "ts",
    "ag",
    "cp",
    "amt",
    "cur",
    "d",
    "r",
    "ev",
    "pay",
  ]) {
    const value = (receipt as unknown as Record<string, unknown>)[k];
    if (value !== undefined) ordered[k] = value;
  }
  return JSON.stringify(ordered);
}

export function decodeReceipt(raw: string): Receipt | null {
  try {
    const o = JSON.parse(raw) as Partial<Receipt>;
    // Anything can be written to a public topic. Only trust well-formed,
    // known-version receipts; ignore the rest rather than throwing, so one
    // bad message cannot break a replay.
    if (o.v !== 1) return null;
    if (typeof o.eid !== "string" || typeof o.ts !== "number") return null;
    if (o.d !== "ALLOW" && o.d !== "DENY") return null;
    if (typeof o.amt !== "string" || typeof o.cp !== "string") return null;
    return o as Receipt;
  } catch {
    return null;
  }
}

/** Where receipts go. HCS in production, memory in tests. */
export interface ReceiptSink {
  readonly kind: string;
  write(receipt: Receipt): Promise<string>; // returns a reference
}

/** Where receipts come back from. */
export interface ReceiptReader {
  readonly kind: string;
  /** Receipts at or after `sinceTs`, oldest first. */
  read(sinceTs: number): Promise<Receipt[]>;
}
