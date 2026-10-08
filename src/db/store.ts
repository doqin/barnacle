import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

export const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export type MemoryKind = "fact" | "preference" | "event" | "relationship";

export interface UserRow {
  discord_id: string;
  username: string;
  first_seen: string;
  last_seen: string;
  last_interacted_at: string | null;
  dm_open: boolean;
  opted_out: boolean;
}
export interface MemoryRow {
  id: string;
  user_id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  created_at: string;
  last_referenced_at: string | null;
  condensed: boolean;
}
export interface OutreachRow {
  id: string;
  user_id: string;
  sent_at: string;
  status: "pending" | "replied" | "ignored";
  replied_at: string | null;
}
export interface OutreachStateRow {
  user_id: string;
  consecutive_ignored: number;
  next_eligible_at: string | null;
  paused: boolean;
}

function ok<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}
function okVoid(res: { error: { message: string } | null }, what: string) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
}

const iso = (d = new Date()) => d.toISOString();

// ---------- users ----------
export async function upsertUser(id: string, username: string) {
  okVoid(
    await db.from("users").upsert({ discord_id: id, username, last_seen: iso() }, { onConflict: "discord_id" }),
    "upsertUser",
  );
}

export async function getUser(id: string): Promise<UserRow | null> {
  return ok(await db.from("users").select("*").eq("discord_id", id).maybeSingle(), "getUser");
}

/** The user addressed the bot. Un-pauses outreach if they had been ghosted-out. */
export async function touchInteraction(id: string) {
  okVoid(await db.from("users").update({ last_interacted_at: iso(), dm_open: true }).eq("discord_id", id), "touchInteraction");
  okVoid(
    await db
      .from("outreach_state")
      .update({ paused: false, consecutive_ignored: 0 })
      .eq("user_id", id)
      .eq("paused", true),
    "unpause",
  );
}

export async function setOptOut(id: string, optedOut: boolean) {
  okVoid(await db.from("users").update({ opted_out: optedOut }).eq("discord_id", id), "setOptOut");
}
export async function setDmOpen(id: string, open: boolean) {
  okVoid(await db.from("users").update({ dm_open: open }).eq("discord_id", id), "setDmOpen");
}

/** /forget: wipe everything the bot knows and reset it to "never interacted". */
export async function forgetUser(id: string) {
  okVoid(await db.from("memories").delete().eq("user_id", id), "forget memories");
  okVoid(await db.from("memory_summaries").delete().eq("user_id", id), "forget summary");
  okVoid(await db.from("outreach").delete().eq("user_id", id), "forget outreach");
  okVoid(await db.from("outreach_state").delete().eq("user_id", id), "forget state");
  okVoid(await db.from("users").update({ last_interacted_at: null }).eq("discord_id", id), "forget user");
}

// ---------- memories ----------
export async function getLiveMemories(userId: string, limit = 80): Promise<MemoryRow[]> {
  return ok(
    await db
      .from("memories")
      .select("*")
      .eq("user_id", userId)
      .eq("condensed", false)
      .order("created_at", { ascending: false })
      .limit(limit),
    "getLiveMemories",
  );
}

export async function addMemories(
  userId: string,
  items: { kind: MemoryKind; content: string; importance: number }[],
) {
  if (!items.length) return;
  okVoid(await db.from("memories").insert(items.map((m) => ({ ...m, user_id: userId }))), "addMemories");
}

export async function markReferenced(ids: string[]) {
  if (!ids.length) return;
  okVoid(await db.from("memories").update({ last_referenced_at: iso() }).in("id", ids), "markReferenced");
}

export async function getSummary(userId: string): Promise<string | null> {
  const row = ok(await db.from("memory_summaries").select("summary").eq("user_id", userId).maybeSingle(), "getSummary");
  return (row as { summary: string } | null)?.summary ?? null;
}

export async function upsertSummary(userId: string, summary: string) {
  okVoid(
    await db.from("memory_summaries").upsert({ user_id: userId, summary, updated_at: iso() }, { onConflict: "user_id" }),
    "upsertSummary",
  );
}

/** Users with enough live memories to be worth condensing. */
export async function usersWithLiveMemories(): Promise<{ user_id: string; n: number }[]> {
  const rows: { user_id: string }[] = ok(
    await db.from("memories").select("user_id").eq("condensed", false).limit(5000),
    "usersWithLiveMemories",
  );
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
  return [...counts].map(([user_id, n]) => ({ user_id, n }));
}

export async function markCondensed(ids: string[]) {
  if (!ids.length) return;
  okVoid(await db.from("memories").update({ condensed: true, condensed_at: iso() }).in("id", ids), "markCondensed");
}

export async function purgeOldCondensed(olderThanDays: number) {
  const cutoff = iso(new Date(Date.now() - olderThanDays * 86_400_000));
  okVoid(await db.from("memories").delete().eq("condensed", true).lt("condensed_at", cutoff), "purgeOldCondensed");
}

// ---------- outreach ----------
export async function getState(userId: string): Promise<OutreachStateRow | null> {
  return ok(await db.from("outreach_state").select("*").eq("user_id", userId).maybeSingle(), "getState");
}

export async function upsertState(s: OutreachStateRow) {
  okVoid(await db.from("outreach_state").upsert(s, { onConflict: "user_id" }), "upsertState");
}

export async function listOutreachCandidates(): Promise<{ user: UserRow; state: OutreachStateRow | null }[]> {
  const users: UserRow[] = ok(
    await db
      .from("users")
      .select("*")
      .not("last_interacted_at", "is", null)
      .eq("opted_out", false)
      .eq("dm_open", true),
    "listCandidates",
  );
  if (!users.length) return [];
  const states: OutreachStateRow[] = ok(
    await db.from("outreach_state").select("*").in("user_id", users.map((u) => u.discord_id)),
    "listStates",
  );
  const byId = new Map(states.map((s) => [s.user_id, s]));
  return users.map((user) => ({ user, state: byId.get(user.discord_id) ?? null }));
}

export async function createOutreach(userId: string, content: string): Promise<OutreachRow> {
  return ok(
    await db.from("outreach").insert({ user_id: userId, content }).select("*").single(),
    "createOutreach",
  );
}

export async function getPendingOutreach(userId: string): Promise<OutreachRow | null> {
  return ok(
    await db
      .from("outreach")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "getPendingOutreach",
  );
}

export async function listPendingOlderThan(cutoff: Date): Promise<OutreachRow[]> {
  return ok(
    await db.from("outreach").select("*").eq("status", "pending").lt("sent_at", iso(cutoff)),
    "listPendingOlderThan",
  );
}

export async function resolveOutreach(id: string, status: "replied" | "ignored") {
  okVoid(
    await db
      .from("outreach")
      .update({ status, replied_at: status === "replied" ? iso() : null })
      .eq("id", id),
    "resolveOutreach",
  );
}

export async function countOutreachSince(since: Date): Promise<number> {
  const res = await db.from("outreach").select("id", { count: "exact", head: true }).gte("sent_at", iso(since));
  if (res.error) throw new Error(`countOutreachSince: ${res.error.message}`);
  return res.count ?? 0;
}

export async function lastOutreachAt(userId: string): Promise<Date | null> {
  const row = ok(
    await db.from("outreach").select("sent_at").eq("user_id", userId).order("sent_at", { ascending: false }).limit(1).maybeSingle(),
    "lastOutreachAt",
  ) as { sent_at: string } | null;
  return row ? new Date(row.sent_at) : null;
}

// ---------- LLM usage ----------
export async function loadUsage(day: string): Promise<{ requests: number; tokens: number } | null> {
  return ok(await db.from("llm_usage").select("requests,tokens").eq("day", day).maybeSingle(), "loadUsage");
}
export async function saveUsage(u: { day: string; requests: number; tokens: number }) {
  okVoid(await db.from("llm_usage").upsert(u, { onConflict: "day" }), "saveUsage");
}
