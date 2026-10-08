import { describe, expect, it } from "vitest";
import type { MemoryRow, OutreachStateRow, UserRow } from "../src/db/store.js";
import {
  applyIgnored, applyReplied, backoffMs, DAY, HOUR, inActiveHours, isEligible, pickHook, type PolicyConfig,
} from "../src/outreach/policy.js";

const cfg: PolicyConfig = { minGapMs: 48 * HOUR, quietAfterChatMs: 12 * HOUR, maxStrikes: 3, startHour: 10, endHour: 22 };
const now = new Date("2026-03-10T15:00:00Z");
const user = (over: Partial<UserRow> = {}): UserRow => ({
  discord_id: "u", username: "u", first_seen: "", last_seen: "",
  last_interacted_at: new Date(now.getTime() - 3 * DAY).toISOString(), dm_open: true, opted_out: false, ...over,
});

describe("ghost backoff", () => {
  it("escalates 1d → 3d → 7d → 14d", () => {
    expect([1, 2, 3, 4, 9].map((n) => backoffMs(n) / DAY)).toEqual([1, 3, 7, 14, 14]);
  });
  it("pauses on the third consecutive ignore", () => {
    let s: OutreachStateRow | null = null;
    s = applyIgnored(s, "u", now, cfg);
    expect(s.paused).toBe(false);
    expect(new Date(s.next_eligible_at!).getTime() - now.getTime()).toBe(2 * DAY); // min gap wins over 1d
    s = applyIgnored(s, "u", now, cfg);
    expect(s.consecutive_ignored).toBe(2);
    expect(new Date(s.next_eligible_at!).getTime() - now.getTime()).toBe(3 * DAY);
    s = applyIgnored(s, "u", now, cfg);
    expect(s.paused).toBe(true);
  });
  it("a reply resets strikes", () => {
    const s = applyReplied("u", now, cfg);
    expect(s).toMatchObject({ consecutive_ignored: 0, paused: false });
  });
});

describe("isEligible", () => {
  it("allows a normal returning user", () => {
    expect(isEligible(user(), null, null, now, cfg)).toBe(true);
  });
  it("blocks never-interacted, opted-out, closed-DM and paused users", () => {
    expect(isEligible(user({ last_interacted_at: null }), null, null, now, cfg)).toBe(false);
    expect(isEligible(user({ opted_out: true }), null, null, now, cfg)).toBe(false);
    expect(isEligible(user({ dm_open: false }), null, null, now, cfg)).toBe(false);
    expect(isEligible(user(), { user_id: "u", consecutive_ignored: 3, next_eligible_at: null, paused: true }, null, now, cfg)).toBe(false);
  });
  it("respects cooldown, min gap, and recent-chat quiet period", () => {
    const future = new Date(now.getTime() + HOUR).toISOString();
    expect(isEligible(user(), { user_id: "u", consecutive_ignored: 1, next_eligible_at: future, paused: false }, null, now, cfg)).toBe(false);
    expect(isEligible(user(), null, new Date(now.getTime() - 10 * HOUR), now, cfg)).toBe(false);
    expect(isEligible(user({ last_interacted_at: new Date(now.getTime() - 2 * HOUR).toISOString() }), null, null, now, cfg)).toBe(false);
  });
});

describe("helpers", () => {
  it("handles active-hours windows incl. overnight", () => {
    expect(inActiveHours(12, 10, 22)).toBe(true);
    expect(inActiveHours(23, 10, 22)).toBe(false);
    expect(inActiveHours(2, 20, 4)).toBe(true);
  });
  it("picks an important, not-recently-referenced memory and skips otherwise", () => {
    const mem = (over: Partial<MemoryRow>): MemoryRow => ({
      id: "m", user_id: "u", kind: "fact", content: "x", importance: 2, created_at: "", last_referenced_at: null, condensed: false, ...over,
    });
    expect(pickHook([mem({ importance: 2 })], now)).toBeNull();
    expect(pickHook([mem({ importance: 4, id: "a" }), mem({ kind: "event", importance: 3, id: "b" })], now)?.id).toBe("b");
    expect(pickHook([mem({ importance: 5, last_referenced_at: now.toISOString() })], now)).toBeNull();
  });
});
