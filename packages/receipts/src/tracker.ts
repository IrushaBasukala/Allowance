import type { Receipt, ReceiptReader, ReceiptSink } from "./receipt.js";
import { windowSpend, windowStart } from "./window.js";

/** In-memory sink and reader. Used in tests and offline development. */
export class MemoryReceiptStore implements ReceiptSink, ReceiptReader {
  readonly kind = "memory";
  private readonly items: Receipt[] = [];
  private seq = 0;

  async write(receipt: Receipt): Promise<string> {
    this.items.push(receipt);
    return `memory@${++this.seq}`;
  }

  async read(sinceTs: number): Promise<Receipt[]> {
    return this.items
      .filter((r) => r.ts >= sinceTs)
      .sort((a, b) => a.ts - b.ts);
  }

  get all(): readonly Receipt[] {
    return this.items;
  }
}

/**
 * Tracks window spend, backed by the receipt log.
 *
 * The log is the source of truth; this is a cache in front of it. On start (and
 * whenever the cache goes stale) we replay from the mirror node and recompute.
 * Locally-written receipts are folded in immediately so a burst of payments
 * inside one refresh interval still sees its own spending.
 *
 * That last detail matters: without it, an agent making ten rapid payments
 * would evaluate all ten against a stale total of zero and blow through the
 * window limit before the first receipt was ever read back.
 */
export class SpendTracker {
  private cached: bigint = 0n;
  private cachedAt = 0;
  private pending: bigint = 0n;

  constructor(
    private readonly reader: ReceiptReader,
    private readonly opts: {
      envelopeId: string;
      currency: string;
      windowSeconds: bigint;
      refreshMs?: number;
      clock?: () => number;
    },
  ) {}

  private get clock() {
    return this.opts.clock ?? Date.now;
  }

  /** Current spend in the trailing window, refreshing from the log when stale. */
  async spentInWindow(now: bigint): Promise<bigint> {
    const refreshMs = this.opts.refreshMs ?? 10_000;
    if (this.clock() - this.cachedAt > refreshMs) {
      await this.refresh(now);
    }
    return this.cached + this.pending;
  }

  /** Force a replay from the log. */
  async refresh(now: bigint): Promise<bigint> {
    const receipts = await this.reader.read(
      windowStart(now, this.opts.windowSeconds),
    );
    this.cached = windowSpend(receipts, {
      now,
      windowSeconds: this.opts.windowSeconds,
      envelopeId: this.opts.envelopeId,
      currency: this.opts.currency,
    });
    this.cachedAt = this.clock();
    // Anything we optimistically added is now reflected in the replay.
    this.pending = 0n;
    return this.cached;
  }

  /**
   * Record a payment we just allowed, before its receipt is readable.
   *
   * HCS finality is roughly three seconds. Between allowing a payment and
   * being able to read its receipt back, this is the only thing preventing
   * the same budget being spent twice.
   */
  noteAllowed(amount: bigint): void {
    this.pending += amount;
  }
}
