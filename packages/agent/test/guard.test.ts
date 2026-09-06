import { describe, it, expect } from "vitest";
import { CounterpartyMode, type Envelope } from "@allowance/envelope";
import { Reason } from "@allowance/policy";
import { demoReputationSource, guarded } from "@allowance/reputation";
import { MemoryReceiptStore, SpendTracker } from "@allowance/receipts";
import { createGuard } from "../src/guard.js";

const NOW = 1_760_000_000n;
const HBAR = 100_000_000n;
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const SERVICE = "0.0.5551212";
const ATTACKER = "0.0.666";

function env(o: Partial<Envelope> = {}): Envelope {
  return {
    version: "1",
    envelopeId: `0x${"ab".repeat(32)}` as `0x${string}`,
    principal: OWNER,
    agent: "0.0.10248326",
    currency: "HBAR",
    perCall: 2n * HBAR,
    perWindow: 5n * HBAR,
    windowSeconds: 3600n,
    counterpartyMode: CounterpartyMode.AllowlistOrReputation,
    allowlist: [SERVICE],
    minReputation: 600,
    minFeedbackCount: 5,
    notBefore: NOW - 100n,
    notAfter: NOW + 3600n,
    receiptTopic: "0.0.98765",
    ...o,
  };
}

function harness(
  overrides: { envelope?: Envelope; principal?: typeof OWNER | null } = {},
) {
  const envelope = overrides.envelope ?? env();
  const store = new MemoryReceiptStore();
  const tracker = new SpendTracker(store, {
    envelopeId: envelope.envelopeId,
    currency: "HBAR",
    windowSeconds: envelope.windowSeconds,
    refreshMs: 0,
  });
  const guard = createGuard({
    envelope,
    principal: overrides.principal === undefined ? OWNER : overrides.principal,
    reputation: guarded(demoReputationSource()),
    tracker,
    receipts: store,
    now: () => NOW,
  });
  return { guard, store, tracker, envelope };
}

const ctx = (payTo: string, amount: bigint, asset = "0.0.0") => ({
  selectedRequirements: {
    scheme: "exact",
    network: "hedera:testnet",
    asset,
    amount: amount.toString(),
    payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer: "0.0.7162784" },
  },
});

describe("guard — x402 BeforePaymentCreationHook", () => {
  it("lets an in-policy payment through", async () => {
    const { guard } = harness();
    const r = await guard.beforePaymentCreation(ctx(SERVICE, 1n * HBAR));
    expect(r).toBeUndefined();
  });

  it("aborts an over-limit payment with the reason code", async () => {
    const { guard } = harness();
    const r = await guard.beforePaymentCreation(ctx(ATTACKER, 500n * HBAR));
    expect(r).toEqual({ abort: true, reason: Reason.OVER_PER_CALL });
  });

  it("aborts when the envelope signature did not hold", async () => {
    const { guard } = harness({ principal: null });
    const r = await guard.beforePaymentCreation(ctx(SERVICE, 1n * HBAR));
    expect(r).toEqual({ abort: true, reason: Reason.BAD_SIGNATURE });
  });

  it("fails closed on requirements it cannot parse", async () => {
    const { guard } = harness();
    const r = await guard.beforePaymentCreation({ selectedRequirements: {} });
    expect(r).toEqual({ abort: true, reason: Reason.UNREADABLE_REQUIREMENTS });
  });

  it("records a receipt even when it cannot read the requirements", async () => {
    const { guard, store } = harness();
    await guard.beforePaymentCreation({ selectedRequirements: {} });
    expect(store.all).toHaveLength(1);
    expect(store.all[0]).toMatchObject({
      d: "DENY",
      r: Reason.UNREADABLE_REQUIREMENTS,
    });
  });

  it("rejects the old nested price shape, which is not what x402 sends", async () => {
    const { guard } = harness();
    const r = await guard.beforePaymentCreation({
      selectedRequirements: {
        payTo: SERVICE,
        price: { asset: "0.0.0", amount: "100000000" },
      },
    });
    expect(r).toEqual({ abort: true, reason: Reason.UNREADABLE_REQUIREMENTS });
  });

  it("maps Hedera asset 0.0.0 to HBAR", async () => {
    const { guard } = harness();
    expect(
      await guard.beforePaymentCreation(ctx(SERVICE, 1n * HBAR)),
    ).toBeUndefined();
  });

  it("refuses a different asset as WRONG_CURRENCY", async () => {
    const { guard } = harness();
    const r = await guard.beforePaymentCreation(
      ctx(SERVICE, 1n * HBAR, "0.0.429274"), // testnet USDC
    );
    expect(r).toEqual({ abort: true, reason: Reason.WRONG_CURRENCY });
  });
});

describe("guard — receipt ordering", () => {
  it("records a denial immediately, since nothing will move", async () => {
    const { guard, store } = harness();
    await guard.beforePaymentCreation(ctx(ATTACKER, 500n * HBAR));
    expect(store.all).toHaveLength(1);
    expect(store.all[0]).toMatchObject({ d: "DENY", r: Reason.OVER_PER_CALL });
  });

  it("does NOT record an allowed payment until settlement confirms", async () => {
    const { guard, store } = harness();
    await guard.beforePaymentCreation(ctx(SERVICE, 1n * HBAR));

    expect(store.all).toHaveLength(0);
  });

  it("records the allowed payment once settlement is reported", async () => {
    const { guard, store } = harness();
    await guard.beforePaymentCreation(ctx(SERVICE, 1n * HBAR));
    await guard.onPaymentResponse({
      response: { headers: { get: () => "0.0.10248326@1760000000.123" } },
    });
    expect(store.all).toHaveLength(1);
    expect(store.all[0]).toMatchObject({ d: "ALLOW", r: Reason.OK });
    expect(store.all[0]?.pay).toBe("0.0.10248326@1760000000.123");
  });

  it("does not charge the window for a payment that never settled", async () => {
    const { guard, tracker } = harness();
    await guard.beforePaymentCreation(ctx(SERVICE, 2n * HBAR));
    expect(await tracker.spentInWindow(NOW)).toBe(0n);
  });

  it("charges the window once settlement confirms", async () => {
    const { guard, tracker } = harness();
    await guard.beforePaymentCreation(ctx(SERVICE, 2n * HBAR));
    await guard.onPaymentResponse({
      response: { headers: { get: () => null } },
    });
    expect(await tracker.spentInWindow(NOW)).toBe(2n * HBAR);
  });
});

describe("guard — budget exhaustion over repeated calls", () => {
  it("stops the agent once the window is spent", async () => {
    const { guard } = harness();
    const reasons: string[] = [];

    for (let i = 0; i < 4; i++) {
      const r = await guard.beforePaymentCreation(ctx(SERVICE, 2n * HBAR));
      if (r && "abort" in r) {
        reasons.push(r.reason);
      } else {
        reasons.push("ALLOWED");
        await guard.onPaymentResponse({
          response: { headers: { get: () => null } },
        });
      }
    }

    expect(reasons).toEqual([
      "ALLOWED",
      "ALLOWED",
      Reason.WINDOW_EXHAUSTED,
      Reason.WINDOW_EXHAUSTED,
    ]);
  });
});
