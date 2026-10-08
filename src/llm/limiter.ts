/**
 * Client-side limiter for Groq's free tier. Limits are conservative versions of
 * 30 RPM / 8K TPM / 1K RPD / 200K TPD (all free chat models share the same numbers).
 */
export const LIMITS = { rpm: 28, tpm: 7000, rpd: 950, tpd: 190_000 };

export type Priority = "user" | "background";

export class BudgetExhausted extends Error {
  constructor(msg = "LLM daily budget exhausted") {
    super(msg);
  }
}

interface Usage {
  day: string;
  requests: number;
  tokens: number;
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export class GroqLimiter {
  private window: { t: number; tokens: number }[] = [];
  private usage: Usage;
  private dirty = false;

  constructor(
    initial?: { requests: number; tokens: number },
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.usage = { day: utcDay(this.now()), requests: initial?.requests ?? 0, tokens: initial?.tokens ?? 0 };
  }

  private rollDay() {
    const d = utcDay(this.now());
    if (d !== this.usage.day) this.usage = { day: d, requests: 0, tokens: 0 };
  }

  /** Fraction (0..1) of the scarcer daily budget that is still available. */
  budgetRemaining(): number {
    this.rollDay();
    return Math.max(
      0,
      Math.min(1 - this.usage.requests / LIMITS.rpd, 1 - this.usage.tokens / LIMITS.tpd),
    );
  }

  /** Restore today's persisted counters after a restart. */
  restore(u: { requests: number; tokens: number }) {
    this.rollDay();
    this.usage.requests = Math.max(this.usage.requests, u.requests);
    this.usage.tokens = Math.max(this.usage.tokens, u.tokens);
  }

  snapshot() {
    this.rollDay();
    return { ...this.usage };
  }

  /** Returns the snapshot to persist if something changed since the last call. */
  takeDirty(): Usage | null {
    if (!this.dirty) return null;
    this.dirty = false;
    return this.snapshot();
  }

  /**
   * Wait until a request estimated at `estTokens` fits in the per-minute window.
   * Background work yields to user traffic by refusing when the daily budget is low.
   */
  async acquire(estTokens: number, priority: Priority): Promise<void> {
    const est = Math.min(estTokens, LIMITS.tpm);
    for (;;) {
      this.rollDay();
      const remaining = this.budgetRemaining();
      if (remaining <= 0) throw new BudgetExhausted();
      if (priority === "background" && remaining < 0.3) throw new BudgetExhausted("budget reserved for replies");

      const t = this.now();
      this.window = this.window.filter((w) => t - w.t < 60_000);
      const used = this.window.reduce((s, w) => s + w.tokens, 0);
      if (this.window.length < LIMITS.rpm && used + est <= LIMITS.tpm) {
        this.window.push({ t, tokens: est });
        return;
      }
      const oldest = this.window[0];
      await this.sleep(oldest ? Math.max(250, 60_000 - (t - oldest.t) + 50) : 1000);
    }
  }

  /** Replace the reservation with what the API actually charged and update daily totals. */
  record(estTokens: number, actualTokens: number) {
    this.rollDay();
    const last = [...this.window].reverse().find((w) => w.tokens === Math.min(estTokens, LIMITS.tpm));
    if (last) last.tokens = actualTokens;
    this.usage.requests += 1;
    this.usage.tokens += actualTokens;
    this.dirty = true;
  }

  /** Called on a 429 so we back off for the rest of the minute. */
  penalize() {
    this.window.push({ t: this.now(), tokens: LIMITS.tpm });
  }
}
