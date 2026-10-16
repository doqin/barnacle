import type { Client } from "discord.js";
import { config } from "../config.js";
import {
  countOutreachSince,
  createOutreach,
  getLiveMemories,
  getState,
  lastOutreachAt,
  listOutreachCandidates,
  listPendingOlderThan,
  markReferenced,
  resolveOutreach,
  setDmOpen,
  upsertState,
} from "../db/store.js";
import { buildSystemPrompt, soundsLikeAssistant, stripMetaLeaks, stripUnicodeEmoji, type CharacterStore } from "../character/loader.js";
import { complete, limiter } from "../llm/groq.js";
import { BudgetExhausted } from "../llm/limiter.js";
import { log } from "../logger.js";
import {
  applyIgnored,
  DAY,
  HOUR,
  inActiveHours,
  isEligible,
  localHour,
  pickHook,
  pickInterest,
  reasonToTalk,
  type PolicyConfig,
} from "./policy.js";

const policyCfg: PolicyConfig = {
  minGapMs: config.OUTREACH_MIN_GAP_HOURS * HOUR,
  quietAfterChatMs: config.OUTREACH_QUIET_AFTER_CHAT_HOURS * HOUR,
  maxStrikes: config.OUTREACH_MAX_STRIKES,
  startHour: config.OUTREACH_START_HOUR,
  endHour: config.OUTREACH_END_HOUR,
};

/** Outreach DMs nobody answered within the window count as ghosted. */
async function resolveExpired() {
  const cutoff = new Date(Date.now() - config.OUTREACH_IGNORE_AFTER_HOURS * HOUR);
  for (const o of await listPendingOlderThan(cutoff)) {
    await resolveOutreach(o.id, "ignored");
    const next = applyIgnored(await getState(o.user_id), o.user_id, new Date(), policyCfg);
    await upsertState(next);
    log.info({ userId: o.user_id, strikes: next.consecutive_ignored, paused: next.paused }, "outreach ignored");
  }
}

async function compose(store: CharacterStore, userId: string, username: string, hook: string | null) {
  const character = store.get();
  const rules =
    `Don't announce you're checking in, don't offer help, and don't invent anything: no new events, ` +
    `objects, plans or "you mentioned…" that isn't written in this prompt. If it doesn't feel natural, reply with exactly SKIP.`;
  const situation = hook
    ? `You're starting a DM with ${username} on your own — they haven't messaged you lately. ` +
      `The one thing you remember that's worth following up on is: "${hook}". ` +
      `Open with ONE short message about exactly that (ask how it went, or react to it), the way a friend who remembered would. ` +
      `Stay strictly within what that memory says; add no extra details, and don't tie it to your own stuff. ${rules}`
    : `You're starting a DM with ${username} on your own — they haven't messaged you lately. ` +
      `You have nothing specific to follow up on, so share something small about YOUR day or interests: ${pickInterest()}. ` +
      `Say it like a random text to a friend, optionally ending with a light question. Don't reference anything ${username} said before. ${rules}`;
  const system = buildSystemPrompt(character, { situation });
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: "(write your opening message now)" },
  ];
  let text = await complete({ messages, priority: "background", maxTokens: 250 });
  if (character.meta.mode === "character" && soundsLikeAssistant(text)) {
    text = await complete({
      messages: [...messages, { role: "assistant", content: text }, { role: "user", content: "too assistant-y. redo it in character, casual, no offers of help." }],
      priority: "background",
      maxTokens: 250,
    });
  }
  text = stripMetaLeaks(text);
  if (character.meta.emoji_style === "emoticon") text = stripUnicodeEmoji(text) || text;
  return text.trim() === "SKIP" || text.length > 500 ? null : text;
}

export async function outreachTick(client: Client, store: CharacterStore) {
  try {
    await resolveExpired();

    const now = new Date();
    if (!inActiveHours(localHour(now, config.TZ), config.OUTREACH_START_HOUR, config.OUTREACH_END_HOUR)) return;
    if (limiter.budgetRemaining() < 0.5) return;
    if ((await countOutreachSince(new Date(now.getTime() - DAY))) >= config.OUTREACH_MAX_PER_DAY) return;
    if (Math.random() > config.OUTREACH_FIRE_PROBABILITY) return; // jitter: don't fire on a clock

    const ranked: { id: string; username: string; score: number; hookId: string | null; hook: string | null }[] = [];
    for (const { user, state } of await listOutreachCandidates()) {
      const last = await lastOutreachAt(user.discord_id);
      if (!isEligible(user, state, last, now, policyCfg)) continue;
      const hook = pickHook(await getLiveMemories(user.discord_id, 60), now);
      // no memory worth following up → fall back to sharing one of Kako's own interests
      ranked.push({
        id: user.discord_id,
        username: user.username,
        score: reasonToTalk(user, now, hook),
        hookId: hook?.id ?? null,
        hook: hook?.content ?? null,
      });
    }
    const pick = ranked.sort((a, b) => b.score - a.score)[0];
    if (!pick) return;

    const text = await compose(store, pick.id, pick.username, pick.hook);
    if (!text) return;

    try {
      const discordUser = await client.users.fetch(pick.id);
      await discordUser.send({ content: text, allowedMentions: { parse: [] } });
    } catch (err) {
      // closed DMs / blocked: remember so we stop trying, and count it as a strike
      log.warn({ userId: pick.id, err: (err as Error).message }, "outreach DM failed");
      await setDmOpen(pick.id, false);
      return;
    }
    await createOutreach(pick.id, text);
    if (pick.hookId) await markReferenced([pick.hookId]);
    log.info({ userId: pick.id }, "outreach sent");
  } catch (err) {
    if (err instanceof BudgetExhausted) return;
    log.error({ err }, "outreach tick failed");
  }
}

export function startOutreach(client: Client, store: CharacterStore) {
  if (!config.OUTREACH_ENABLED) {
    log.info("outreach disabled");
    return;
  }
  setInterval(() => void outreachTick(client, store), config.OUTREACH_TICK_MIN * 60_000);
}
