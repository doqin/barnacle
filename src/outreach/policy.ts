import type { MemoryRow, OutreachStateRow, UserRow } from "../db/store.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Cooldown after the nth consecutive ignored outreach: 1d → 3d → 7d → 14d. */
export const BACKOFF_DAYS = [1, 3, 7, 14];

export interface PolicyConfig {
  minGapMs: number;
  quietAfterChatMs: number;
  maxStrikes: number;
  startHour: number;
  endHour: number;
}

export const backoffMs = (consecutiveIgnored: number) =>
  (BACKOFF_DAYS[Math.min(Math.max(consecutiveIgnored, 1), BACKOFF_DAYS.length) - 1] ?? 14) * DAY;

/** New state after an outreach went unanswered. Pauses once max strikes is reached. */
export function applyIgnored(
  state: OutreachStateRow | null,
  userId: string,
  ignoredAt: Date,
  cfg: Pick<PolicyConfig, "maxStrikes" | "minGapMs">,
): OutreachStateRow {
  const n = (state?.consecutive_ignored ?? 0) + 1;
  const wait = Math.max(backoffMs(n), cfg.minGapMs);
  return {
    user_id: userId,
    consecutive_ignored: n,
    next_eligible_at: new Date(ignoredAt.getTime() + wait).toISOString(),
    paused: n >= cfg.maxStrikes,
  };
}

/** New state after the user answered an outreach DM: counters reset, base gap applies. */
export function applyReplied(userId: string, sentAt: Date, cfg: Pick<PolicyConfig, "minGapMs">): OutreachStateRow {
  return {
    user_id: userId,
    consecutive_ignored: 0,
    next_eligible_at: new Date(sentAt.getTime() + cfg.minGapMs).toISOString(),
    paused: false,
  };
}

/** Hour of day in the given IANA timezone. */
export function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now);
  return Number(h);
}

export function inActiveHours(hour: number, start: number, end: number): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function isEligible(
  user: UserRow,
  state: OutreachStateRow | null,
  lastOutreach: Date | null,
  now: Date,
  cfg: PolicyConfig,
): boolean {
  if (user.opted_out || !user.dm_open || !user.last_interacted_at) return false;
  if (state?.paused) return false;
  if (state?.next_eligible_at && new Date(state.next_eligible_at) > now) return false;
  if (lastOutreach && now.getTime() - lastOutreach.getTime() < cfg.minGapMs) return false;
  // don't pester someone who is actively chatting with the bot
  if (now.getTime() - new Date(user.last_interacted_at).getTime() < cfg.quietAfterChatMs) return false;
  return true;
}

/** Best memory to open with: unresolved/important and not recently brought up. Null = nothing to say. */
export function pickHook(memories: MemoryRow[], now: Date): MemoryRow | null {
  const fresh = memories.filter(
    (m) => !m.last_referenced_at || now.getTime() - new Date(m.last_referenced_at).getTime() > 3 * DAY,
  );
  const score = (m: MemoryRow) =>
    m.importance + (m.kind === "event" ? 2 : 0) + (m.kind === "relationship" ? 1 : 0);
  return fresh.filter((m) => m.importance >= 3 || m.kind === "event").sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Higher = better reason to reach out (silence for a while, but not forgotten). */
export function reasonToTalk(user: UserRow, now: Date, hook: MemoryRow | null): number {
  const idleDays = (now.getTime() - new Date(user.last_interacted_at ?? now).getTime()) / DAY;
  return Math.min(idleDays, 14) + (hook ? hook.importance : 0) + (hook?.kind === "event" ? 2 : 0);
}

export { DAY, HOUR };
