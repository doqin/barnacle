import { describe, expect, it } from "vitest";
import { BudgetExhausted, GroqLimiter, LIMITS } from "../src/llm/limiter.js";

describe("per-model limiter", () => {
  const mk = () => new GroqLimiter(undefined, Date.now, undefined, ["main", "fallback"]);

  it("spending one model leaves the others untouched", async () => {
    const l = mk();
    l.record(100, LIMITS.tpd, "main");
    expect(l.budgetRemaining("main")).toBe(0);
    expect(l.budgetRemaining("fallback")).toBe(1);
    expect(l.budgetRemaining()).toBe(1); // best-off model
    await expect(l.acquire(100, "user", "main")).rejects.toBeInstanceOf(BudgetExhausted);
    await expect(l.acquire(100, "user", "fallback")).resolves.toBeUndefined();
  });

  it("snapshot sums every model and restore lands on the first", () => {
    const l = mk();
    l.record(10, 100, "main");
    l.record(10, 50, "fallback");
    expect(l.snapshot()).toMatchObject({ requests: 2, tokens: 150 });
    const r = mk();
    r.restore([{ model: "*", requests: 3, tokens: 500 }]); // legacy row
    expect(r.budgetRemaining("main")).toBeLessThan(1);
    expect(r.budgetRemaining("fallback")).toBe(1);
  });

  it("restores per-model rows and takeDirty returns them", () => {
    const l = mk();
    l.restore([
      { model: "main", requests: 1, tokens: LIMITS.tpd },
      { model: "fallback", requests: 1, tokens: 10 },
      { model: "gone", requests: 9, tokens: 9 },
    ]);
    expect(l.budgetRemaining("main")).toBe(0);
    expect(l.budgetRemaining("fallback")).toBeGreaterThan(0.9);
    l.record(10, 5, "fallback");
    const rows = l.takeDirty();
    expect(rows?.map((r) => r.model).sort()).toEqual(["fallback", "main"]);
    expect(l.takeDirty()).toBeNull();
  });
});
