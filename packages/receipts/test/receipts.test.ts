import { describe, it, expect } from "vitest";
import { CounterpartyMode, type Envelope } from "@allowance/envelope";
import { evaluate, Reason, type PaymentRequest } from "@allowance/policy";
import {
  buildReceipt,
  encodeReceipt,
  decodeReceipt,
  windowSpend,
  MemoryReceiptStore,
  MirrorReceiptReader,
  SpendTracker,
  type Receipt,
} from "../src/index.js";

const NOW = 1_760_000_000n;
const DAY = 86_400n;
const EID = `0x${"ab".repeat(32)}` as `0x${string}`;

function receipt(o: Partial<Receipt> = {}): Receipt {
  return {
    v: 1,
    eid: EID,
    eh: "0xdeadbeef",
    ts: Number(NOW) - 10,
    ag: "0.0.4417542",
    cp: "0.0.5551212",
    amt: "100000000",
    cur: "HBAR",
    d: "ALLOW",
    r: "OK",
    ...o,
  };
}

const W = { now: NOW, windowSeconds: DAY, envelopeId: EID, currency: "HBAR" };

describe("receipt encoding", () => {
  it("round-trips", () => {
    const r = receipt();
    expect(decodeReceipt(encodeReceipt(r))).toEqual(r);
  });

  it("encodes deterministically regardless of key order", () => {
    const a = encodeReceipt(receipt());
    const b = encodeReceipt({ ...receipt(), v: 1 });
    expect(a).toBe(b);
  });

  it("stays inside one HCS chunk for a typical receipt", () => {
    const size = Buffer.byteLength(
      encodeReceipt(
        receipt({
          ev: { perCall: "200000000", spentInWindow: "0", allowlisted: true },
        }),
      ),
    );
    expect(size).toBeLessThan(1024);
  });

  it("rejects junk instead of throwing", () => {
    expect(decodeReceipt("not json")).toBeNull();
    expect(decodeReceipt("{}")).toBeNull();
    expect(decodeReceipt(JSON.stringify({ ...receipt(), v: 99 }))).toBeNull();
    expect(
      decodeReceipt(JSON.stringify({ ...receipt(), d: "MAYBE" })),
    ).toBeNull();
  });
});

describe("windowSpend", () => {
  it("sums allowed payments inside the window", () => {
    expect(windowSpend([receipt(), receipt()], W)).toBe(200_000_000n);
  });

  it("ignores denials — a refused payment moved no money", () => {
    const spend = windowSpend(
      [receipt(), receipt({ d: "DENY", r: Reason.OVER_PER_CALL })],
      W,
    );
    expect(spend).toBe(100_000_000n);
  });

  it("cannot be exhausted by making requests that fail", () => {
    const attack = Array.from({ length: 500 }, () =>
      receipt({ d: "DENY", r: Reason.OVER_PER_CALL, amt: "99999999999" }),
    );
    expect(windowSpend(attack, W)).toBe(0n);
  });

  it("drops receipts older than the window", () => {
    const old = receipt({ ts: Number(NOW - DAY) - 1 });
    expect(windowSpend([old, receipt()], W)).toBe(100_000_000n);
  });

  it("ignores other envelopes and other currencies", () => {
    const spend = windowSpend(
      [receipt(), receipt({ eid: "0xother" }), receipt({ cur: "0.0.1234" })],
      W,
    );
    expect(spend).toBe(100_000_000n);
  });

  it("ignores clock-skewed future receipts and malformed amounts", () => {
    const spend = windowSpend(
      [receipt(), receipt({ ts: Number(NOW) + 9999 }), receipt({ amt: "abc" })],
      W,
    );
    expect(spend).toBe(100_000_000n);
  });
});

describe("SpendTracker", () => {
  const opts = { envelopeId: EID, currency: "HBAR", windowSeconds: DAY };

  it("derives spend from the log", async () => {
    const store = new MemoryReceiptStore();
    await store.write(receipt({ amt: "300000000" }));
    const t = new SpendTracker(store, opts);
    expect(await t.spentInWindow(NOW)).toBe(300_000_000n);
  });

  it("counts a just-allowed payment before its receipt is readable", async () => {
    const store = new MemoryReceiptStore();
    const t = new SpendTracker(store, { ...opts, refreshMs: 60_000 });
    await t.spentInWindow(NOW);
    t.noteAllowed(500_000_000n);
    expect(await t.spentInWindow(NOW)).toBe(500_000_000n);
  });

  it("does not double-count once the receipt lands", async () => {
    let clock = 1000;
    const store = new MemoryReceiptStore();
    const t = new SpendTracker(store, {
      ...opts,
      refreshMs: 5000,
      clock: () => clock,
    });
    await t.spentInWindow(NOW);
    t.noteAllowed(100_000_000n);
    await store.write(receipt()); // the same payment, now on the log
    clock += 6000;
    expect(await t.spentInWindow(NOW)).toBe(100_000_000n);
  });
});

describe("end to end: evaluate, receipt, replay", () => {
  const envelope: Envelope = {
    version: "1",
    envelopeId: EID,
    principal: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
    agent: "0.0.4417542",
    currency: "HBAR",
    perCall: 200_000_000n,
    perWindow: 500_000_000n,
    windowSeconds: DAY,
    counterpartyMode: CounterpartyMode.AllowlistOnly,
    allowlist: ["0.0.5551212"],
    minReputation: 600,
    minFeedbackCount: 5,
    notBefore: NOW - 100n,
    notAfter: NOW + 100n,
    receiptTopic: "0.0.98765",
  };

  const req: PaymentRequest = {
    agent: "0.0.4417542",
    counterparty: "0.0.5551212",
    amount: 200_000_000n,
    currency: "HBAR",
  };

  it("exhausts the window after enough real payments, and records the refusal", async () => {
    const store = new MemoryReceiptStore();
    const tracker = new SpendTracker(store, {
      envelopeId: EID,
      currency: "HBAR",
      windowSeconds: DAY,
      refreshMs: 0,
    });
    const principal = envelope.principal;
    const decisions: string[] = [];

    for (let i = 0; i < 3; i++) {
      const spent = await tracker.spentInWindow(NOW);
      const d = evaluate(envelope, req, {
        now: NOW,
        principal,
        spentInWindow: spent,
      });
      decisions.push(d.reason);
      await store.write(buildReceipt(envelope, req, d, { now: NOW }));
      if (d.decision === "ALLOW") tracker.noteAllowed(req.amount);
    }

    // 2 + 2 HBAR fits under 5; the third would reach 6.
    expect(decisions).toEqual([Reason.OK, Reason.OK, Reason.WINDOW_EXHAUSTED]);

    // All three decisions are on the log — including the one that was refused.
    expect(store.all).toHaveLength(3);
    expect(store.all.filter((r) => r.d === "DENY")).toHaveLength(1);

    // And the refusal did not consume budget.
    expect(await tracker.refresh(NOW)).toBe(400_000_000n);
  });
});

describe("MirrorReceiptReader — empty topic", () => {
  /**
   * A topic that exists but has never been written to returns 404 from the
   * mirror node. Treating that as an error broke the very first payment under
   * a fresh topic: the spend replay threw, the guard threw, and every request
   * was blocked with no receipt and no reason.
   */
  it("treats 404 as an empty log, not a failure", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("Not found", { status: 404 })) as typeof fetch;
    try {
      const reader = new MirrorReceiptReader("0.0.99999", "testnet");
      await expect(reader.read(0)).resolves.toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("still throws on a real error", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    try {
      const reader = new MirrorReceiptReader("0.0.99999", "testnet");
      await expect(reader.read(0)).rejects.toThrow(/500/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
