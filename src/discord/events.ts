import { Events, type Client, type Message } from "discord.js";
import { config } from "../config.js";
import {
  buildSystemPrompt,
  characterNames,
  dedupeRepeatedReply,
  detectLanguage,
  dropRepeatedEmoticon,
  dropRepeatedTic,
  soundsLikeAssistant,
  stripMetaLeaks,
  stripUnicodeEmoji,
  type CharacterStore,
} from "../character/loader.js";
import {
  getPendingOutreach,
  getState,
  resolveOutreach,
  touchInteraction,
  upsertState,
  upsertUser,
} from "../db/store.js";
import { complete, completeJson, completeWithSearch, limiter, type ChatMessage } from "../llm/groq.js";
import { searchEnabled, searchQuota, webSearch } from "../search/tavily.js";
import { BudgetExhausted } from "../llm/limiter.js";
import { log } from "../logger.js";
import { extractMemories, type Turn } from "../memory/extract.js";
import { buildMemoryBlock } from "../memory/recall.js";
import { applyReplied } from "../outreach/policy.js";
import { applyEmotes, emotePrompt, guildEmotes } from "./emotes.js";
import { decide, type ChannelState } from "./gate.js";

interface Entry {
  authorId: string;
  name: string;
  text: string;
  isBot: boolean;
}

const HISTORY_CAP = 12;
const channelState = new Map<string, ChannelState>();
const history = new Map<string, Entry[]>();
const queues = new Map<string, Promise<void>>();

const gateCfg = {
  followupWindowMs: config.FOLLOWUP_WINDOW_SEC * 1000,
  maxUnpingedStreak: config.MAX_UNPINGED_STREAK,
};

const SEARCH_HINT =
  "You have web_search on your phone. When someone asks about or mentions a specific real thing (a song, band, artist, musician, " +
  "game, show, book, meme, slang, product, place, recent news, or a fact you're not certain of), look it up instead of guessing " +
  "or making something up. Skip it for chit-chat, feelings, and facts about your own life.";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pushHistory(channelId: string, e: Entry) {
  const list = history.get(channelId) ?? [];
  list.push({ ...e, text: e.text.slice(0, 500) });
  if (list.length > HISTORY_CAP) list.shift();
  history.set(channelId, list);
}

/** Serialise replies per channel so bursts don't blow the rate limiter or interleave. */
function enqueue(channelId: string, job: () => Promise<void>) {
  const prev = queues.get(channelId) ?? Promise.resolve();
  const next = prev.then(job).catch((err) => log.error({ err }, "reply job failed"));
  queues.set(channelId, next);
  void next.finally(() => {
    if (queues.get(channelId) === next) queues.delete(channelId);
  });
}

// ---------- per-user memory extraction buffers ----------
const turnBuffers = new Map<string, { username: string; turns: Turn[]; timer?: NodeJS.Timeout }>();

async function flushTurns(userId: string) {
  const buf = turnBuffers.get(userId);
  if (!buf || buf.turns.length === 0) return;
  clearTimeout(buf.timer);
  const turns = buf.turns.splice(0);
  try {
    const n = await extractMemories(userId, buf.username, turns);
    if (n) log.info({ userId, n }, "stored memories");
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) log.error({ err }, "memory extraction failed");
  }
}

function recordTurns(userId: string, username: string, ...turns: Turn[]) {
  const buf = turnBuffers.get(userId) ?? { username, turns: [] };
  buf.username = username;
  buf.turns.push(...turns);
  clearTimeout(buf.timer);
  turnBuffers.set(userId, buf);
  if (buf.turns.length >= 8) void flushTurns(userId);
  else buf.timer = setTimeout(() => void flushTurns(userId), 120_000); // quiet for 2 min → extract
}

export function dropTurns(userId: string) {
  const buf = turnBuffers.get(userId);
  if (buf) clearTimeout(buf.timer);
  turnBuffers.delete(userId);
}

export async function flushAllTurns() {
  await Promise.all([...turnBuffers.keys()].map(flushTurns));
}

// ---------- gate LLM check ----------
async function directedAtBot(name: string, channelId: string): Promise<boolean> {
  const lines = (history.get(channelId) ?? [])
    .slice(-5)
    .map((e) => `${e.isBot ? `${name} (bot)` : e.name}: ${e.text.slice(0, 200)}`)
    .join("\n");
  const res = await completeJson<{ directed_at_bot?: boolean }>({
    model: config.MODEL_UTILITY,
    priority: "background",
    maxTokens: 60,
    messages: [
      {
        role: "system",
        content: `You judge group chat. ${name} is a chat participant who spoke recently. Decide if the LAST message is directed at ${name} (a reply to them, a follow-up to what they said, or addressing them), versus talking to someone else or nobody. Respond JSON only: {"directed_at_bot": true|false}`,
      },
      { role: "user", content: lines },
    ],
  });
  return res?.directed_at_bot === true;
}

// ---------- reply pipeline ----------
function splitMessage(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function situation(msg: Message, username: string, emotes: string): string {
  const where = msg.guild
    ? `the #${"name" in msg.channel ? msg.channel.name : "channel"} channel of the server "${msg.guild.name}", where several people may be talking`
    : `a private DM with ${username}`;
  const now = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone: config.TZ,
  }).format(new Date());
  const lang = detectLanguage(msg.content);
  const langNote =
    lang === "en"
      ? "Their latest message is in English, so reply in English only, even if earlier messages were Vietnamese."
      : lang === "vi"
        ? "Their latest message is in Vietnamese, so reply in Vietnamese."
        : "";
  return [`You're in ${where}. Reply to ${username}'s latest message. It's ${now} for you.`, langNote, emotes]
    .filter(Boolean)
    .join(" ");
}

function toChat(channelId: string, botId: string): ChatMessage[] {
  const entries = (history.get(channelId) ?? []).slice(-10);
  return entries.map((e) =>
    e.authorId === botId
      ? { role: "assistant" as const, content: e.text }
      : { role: "user" as const, content: `${e.name}: ${e.text}` },
  );
}

/** Discord's typing indicator lasts ~10s, so re-send it every 8s. Returns a function that stops it. */
function keepTyping(msg: Message): () => void {
  if (!("sendTyping" in msg.channel)) return () => {};
  const channel = msg.channel;
  const ping = () => void channel.sendTyping().catch(() => {});
  ping();
  const timer = setInterval(ping, 8_000);
  return () => clearInterval(timer);
}

/** Shows "typing…" for as long as the reply takes, including generation, search and the human-ish pause. */
async function respond(client: Client, store: CharacterStore, msg: Message, username: string, pinged: boolean) {
  const stopTyping = keepTyping(msg);
  try {
    await respondInner(client, store, msg, username, pinged);
  } finally {
    stopTyping();
  }
}

async function respondInner(client: Client, store: CharacterStore, msg: Message, username: string, pinged: boolean) {
  const botId = client.user!.id;
  const channelId = msg.channelId;
  const character = store.get();

  await touchInteraction(msg.author.id);

  if (!msg.guild) {
    const pending = await getPendingOutreach(msg.author.id);
    if (pending) {
      await resolveOutreach(pending.id, "replied");
      await upsertState(applyReplied(msg.author.id, new Date(pending.sent_at), { minGapMs: config.OUTREACH_MIN_GAP_HOURS * 3_600_000 }));
    }
  }

  const memory = await buildMemoryBlock(msg.author.id, msg.content).catch(() => "");
  const emoteMap = character.meta.emoji_use === "none" ? new Map() : guildEmotes(msg.guild);
  const canSearch =
    searchEnabled() && searchQuota.canSearch(msg.author.id) && limiter.budgetRemaining() > 0.4;
  const extras = [emotePrompt(emoteMap), canSearch ? SEARCH_HINT : ""].filter(Boolean).join(" ");
  const system = buildSystemPrompt(character, {
    memory,
    situation: situation(msg, username, extras),
  });
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...toChat(channelId, botId)];

  const started = Date.now();
  let reply: string;
  try {
    let convo = messages;
    if (canSearch) {
      const out = await completeWithSearch({ messages, maxTokens: 400, priority: "user" }, async (q) => {
        searchQuota.record(msg.author.id);
        return webSearch(q);
      });
      reply = out.text;
      convo = out.messages;
    } else {
      reply = await complete({ messages, maxTokens: 400, priority: "user" });
    }
    if (character.meta.mode === "character" && soundsLikeAssistant(reply)) {
      reply = await complete({
        messages: [
          ...convo,
          { role: "assistant", content: reply },
          { role: "user", content: "(that sounded like a customer-service assistant. say it again as yourself: casual, in character, no offers of help, no lists.)" },
        ],
        maxTokens: 400,
        priority: "user",
      });
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) await msg.react("💤").catch(() => {});
    else log.error({ err }, "reply generation failed");
    return;
  }

  const recentBot = (history.get(channelId) ?? []).filter((e) => e.isBot).slice(-4).map((e) => e.text);
  reply = stripMetaLeaks(dropRepeatedEmoticon(dropRepeatedTic(dedupeRepeatedReply(reply), recentBot), recentBot));

  // small human-ish pause proportional to length, net of LLM latency
  await sleep(Math.max(0, Math.min(2500, reply.length * 25) - (Date.now() - started)));

  if (character.meta.emoji_style === "emoticon") reply = stripUnicodeEmoji(reply) || reply;
  const chunks = splitMessage(applyEmotes(reply, emoteMap));
  const allowedMentions = { parse: [], repliedUser: false } as const;
  for (const [i, chunk] of chunks.entries()) {
    if (i === 0 && pinged && msg.guild) await msg.reply({ content: chunk, allowedMentions });
    else if ("send" in msg.channel) await msg.channel.send({ content: chunk, allowedMentions });
  }

  const state = channelState.get(channelId) ?? { lastBotAt: 0, lastAddressedId: null, unpingedStreak: 0 };
  state.lastBotAt = Date.now();
  state.lastAddressedId = msg.author.id;
  state.unpingedStreak = pinged ? 0 : state.unpingedStreak + 1;
  channelState.set(channelId, state);

  pushHistory(channelId, { authorId: botId, name: character.meta.name, text: reply, isBot: true });
  recordTurns(msg.author.id, username, { who: "user", text: msg.content }, { who: "bot", text: reply });
}

async function handleMessage(client: Client, store: CharacterStore, msg: Message) {
  if (msg.author.bot || msg.system) return;
  const botId = client.user!.id;
  const character = store.get();
  const username = msg.member?.displayName ?? msg.author.displayName ?? msg.author.username;

  // normalise text: drop the bot's own mention, resolve others to @names
  let text = msg.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
  for (const u of msg.mentions.users.values()) {
    text = text.replace(new RegExp(`<@!?${u.id}>`, "g"), `@${u.displayName}`);
  }
  if (!text && msg.attachments.size) text = "[sent an attachment]";
  if (!text) return;
  msg.content = text; // used downstream for recall/extraction

  const isDM = !msg.guild;
  const mentioned = msg.mentions.users.has(botId);

  let isReplyToBot = false;
  let replyToOther = false;
  if (msg.reference?.messageId && !mentioned) {
    const ref = await msg.fetchReference().catch(() => null);
    if (ref) {
      isReplyToBot = ref.author.id === botId;
      replyToOther = !isReplyToBot;
    }
  } else if (msg.reference?.messageId) {
    isReplyToBot = msg.mentions.repliedUser?.id === botId;
  }

  const addressesOthers = replyToOther || msg.mentions.users.some((u) => u.id !== botId && !u.bot);
  const names = characterNames(character);
  const nameMentioned = names.some((n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "iu").test(text));

  pushHistory(msg.channelId, { authorId: msg.author.id, name: username, text, isBot: false });

  let decision = decide(
    {
      isDM,
      mentioned,
      isReplyToBot,
      addressesOthers,
      nameMentioned,
      authorId: msg.author.id,
      content: text,
      now: Date.now(),
    },
    channelState.get(msg.channelId),
    gateCfg,
  );

  if (decision === "ask") {
    if (limiter.budgetRemaining() < 0.3) return;
    try {
      decision = (await directedAtBot(character.meta.name, msg.channelId)) ? "reply" : "ignore";
    } catch {
      return;
    }
  }
  if (decision !== "reply") return;

  const pinged = mentioned || isReplyToBot;
  await upsertUser(msg.author.id, username);
  enqueue(msg.channelId, () => respond(client, store, msg, username, pinged));
}

export function registerMessageEvents(client: Client, store: CharacterStore) {
  client.on(Events.MessageCreate, (msg) => {
    void handleMessage(client, store, msg).catch((err) => log.error({ err }, "message handler failed"));
  });
}
