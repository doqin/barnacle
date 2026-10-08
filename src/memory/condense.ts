import { config } from "../config.js";
import {
  getLiveMemories,
  getSummary,
  markCondensed,
  purgeOldCondensed,
  upsertSummary,
  usersWithLiveMemories,
  type MemoryRow,
} from "../db/store.js";
import { BudgetExhausted } from "../llm/limiter.js";
import { complete, limiter } from "../llm/groq.js";
import { log } from "../logger.js";

export const OLD_AFTER_DAYS = 30;
export const MAX_LIVE = 60;
const MIN_BATCH = 5;

/** Which memories should be folded into the long-term summary. Important (5) ones stay raw. */
export function selectForCondensing(live: MemoryRow[], now = Date.now()): MemoryRow[] {
  const cutoff = now - OLD_AFTER_DAYS * 86_400_000;
  const candidates = live
    .filter((m) => m.importance < 5)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const overflow = Math.max(0, live.length - MAX_LIVE);
  return candidates.filter((m, i) => new Date(m.created_at).getTime() < cutoff || i < overflow);
}

const SYSTEM = `You maintain a compact long-term profile of one person for a chat companion.
Merge the existing profile with the older notes into ONE updated profile, max 110 words, plain sentences, third person.
Keep stable facts, preferences, relationships, and notable past events; drop stale or trivial details and anything contradicted by newer info.
Output only the profile text.`;

export async function condenseUser(userId: string): Promise<boolean> {
  const live = await getLiveMemories(userId, 500);
  const batch = selectForCondensing(live);
  if (batch.length < MIN_BATCH) return false;

  const existing = await getSummary(userId);
  const notes = batch.map((m) => `- (${m.created_at.slice(0, 10)}) ${m.content}`).join("\n");
  const summary = await complete({
    model: config.MODEL_UTILITY,
    priority: "background",
    maxTokens: 350,
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Existing profile:\n${existing ?? "(none)"}\n\nOlder notes:\n${notes}` },
    ],
  });
  await upsertSummary(userId, summary);
  await markCondensed(batch.map((m) => m.id));
  log.info({ userId, condensed: batch.length }, "condensed memories");
  return true;
}

/** Runs through all users with enough memories; stops early if the daily budget is tight. */
export async function runCondenseJob() {
  try {
    for (const { user_id, n } of await usersWithLiveMemories()) {
      if (n < MIN_BATCH) continue;
      if (limiter.budgetRemaining() < 0.3) return;
      await condenseUser(user_id);
    }
    await purgeOldCondensed(90);
  } catch (err) {
    if (err instanceof BudgetExhausted) return;
    log.error({ err }, "condense job failed");
  }
}
