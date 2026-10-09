/**
 * Client-side limiter for Groq's free tier. Limits are conservative versions of
 * 30 RPM / 8K TPM / 1K RPD / 200K TPD. Groq applies them per model, so every model gets its own copy.
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

/**
 * Usage and the per-minute window are tracked per model. A model whose daily budget is spent makes `acquire` throw
 * BudgetExhausted; callers with a fallback chain catch that and move on to the next model.
 */
export class GroqLimiter {
  private windows = new Map<string, { t: number; tokens: number }[]>();
  private day: string;
  private usage = new Map<string, { requests: number; tokens: number }>();
  private dirty = false;

  /**
   * @param models every model the bot may call. Persisted totals (which aren't split by model) are restored onto the
   *   first one, and `budgetRemaining()` with no argument reports the best-off model.
   */
  constructor(
    initial?: { requests: number; tokens: number },
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private models: string[] = ["*"],
  ) {
    this.day = utcDay(this.now());
    if (initial) this.usage.set(this.models[0]!, { ...initial });
  }

  private rollDay() {
    const d = utcDay(this.now());
    if (d !== this.day) {
      this.day = d;
      this.usage.clear();
    }
  }

  private use(model: string) {
    let u = this.usage.get(model);
    if (!u) this.usage.set(model, (u = { requests: 0, tokens: 0 }));
    return u;
  }

  /** Fraction (0..1) of the scarcer daily budget still available for `model`, or for the best-off model if omitted. */
  budgetRemaining(model?: string): number {
    this.rollDay();
    if (!model) return Math.max(...this.models.map((m) => this.budgetRemaining(m)));
    const u = this.use(model);
    return Math.max(0, Math.min(1 - u.requests / LIMITS.rpd, 1 - u.tokens / LIMITS.tpd));
  }

  /** Per-model remaining fractions, for logging. */
  breakdown(): Record<string, number> {
    return Object.fromEntries(this.models.map((m) => [m, Number(this.budgetRemaining(m).toFixed(2))]));
  }

  /**
   * Restore today's persisted rows after a restart. A legacy row (model "*", from before usage was stored per model)
   * lands on the first model; rows for models that are no longer configured are ignored.
   */
  restore(rows: { model: string; requests: number; tokens: number }[]) {
    this.rollDay();
    for (const r of rows) {
      const model = r.model === "*" ? this.models[0]! : r.model;
      if (!this.models.includes(model)) continue;
      const cur = this.use(model);
      cur.requests = Math.max(cur.requests, r.requests);
      cur.tokens = Math.max(cur.tokens, r.tokens);
    }
  }

  /** Today's totals across all models. */
  snapshot(): Usage {
    this.rollDay();
    let requests = 0;
    let tokens = 0;
    for (const u of this.usage.values()) {
      requests += u.requests;
      tokens += u.tokens;
    }
    return { day: this.day, requests, tokens };
  }

  /** Returns today's per-model rows to persist if something changed since the last call. */
  takeDirty(): (Usage & { model: string })[] | null {
    if (!this.dirty) return null;
    this.dirty = false;
    return [...this.usage].map(([model, u]) => ({ day: this.day, model, ...u }));
  }

  /**
   * Wait until a request estimated at `estTokens` fits in `model`'s per-minute window.
   * Throws BudgetExhausted if that model's daily budget is spent (background work also yields when it is low).
   */
  async acquire(estTokens: number, priority: Priority, model: string = this.models[0]!): Promise<void> {
    const est = Math.min(estTokens, LIMITS.tpm);
    for (;;) {
      this.rollDay();
      const remaining = this.budgetRemaining(model);
      if (remaining <= 0) throw new BudgetExhausted();
      if (priority === "background" && remaining < 0.3) throw new BudgetExhausted("budget reserved for replies");

      const t = this.now();
      const window = (this.windows.get(model) ?? []).filter((w) => t - w.t < 60_000);
      this.windows.set(model, window);
      const used = window.reduce((s, w) => s + w.tokens, 0);
      if (window.length < LIMITS.rpm && used + est <= LIMITS.tpm) {
        window.push({ t, tokens: est });
        return;
      }
      const oldest = window[0];
      await this.sleep(oldest ? Math.max(250, 60_000 - (t - oldest.t) + 50) : 1000);
    }
  }

  /** Replace the reservation with what the API actually charged and update daily totals. */
  record(estTokens: number, actualTokens: number, model: string = this.models[0]!) {
    this.rollDay();
    const last = [...(this.windows.get(model) ?? [])].reverse().find((w) => w.tokens === Math.min(estTokens, LIMITS.tpm));
    if (last) last.tokens = actualTokens;
    const u = this.use(model);
    u.requests += 1;
    u.tokens += actualTokens;
    this.dirty = true;
  }

  /** Called on a 429 so we back off on that model for the rest of the minute. */
  penalize(model: string = this.models[0]!) {
    const window = this.windows.get(model) ?? [];
    window.push({ t: this.now(), tokens: LIMITS.tpm });
    this.windows.set(model, window);
  }
}
