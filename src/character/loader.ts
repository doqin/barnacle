import fs from "node:fs";
import matter from "gray-matter";
import { z } from "zod";
import { log } from "../logger.js";

const metaSchema = z.object({
  name: z.string().default("Barnacle"),
  mode: z.enum(["character", "assistant"]).default("character"),
  nicknames: z.array(z.string()).default([]),
  reply_length: z.enum(["short", "medium"]).default("short"),
  emoji_use: z.enum(["none", "rare", "often"]).default("rare"),
  /** "emoticon" = text faces like :3 and T_T instead of unicode emoji (server emotes still allowed) */
  emoji_style: z.enum(["emoji", "emoticon"]).default("emoji"),
});

export interface Character {
  meta: z.infer<typeof metaSchema>;
  body: string;
}

/** Every name the character answers to, lowercased. */
export const characterNames = (c: Character) =>
  [c.meta.name, ...c.meta.nicknames].map((n) => n.toLowerCase());

export function parseCharacter(raw: string): Character {
  const { data, content } = matter(raw);
  return { meta: metaSchema.parse(data), body: content.trim() };
}

/** Loads the sheet and hot-reloads it when the file changes (keeps the last good copy on errors). */
export class CharacterStore {
  private current: Character;

  constructor(private path: string) {
    this.current = parseCharacter(fs.readFileSync(path, "utf8"));
    fs.watchFile(path, { interval: 2000 }, () => {
      try {
        this.current = parseCharacter(fs.readFileSync(path, "utf8"));
        log.info({ name: this.current.meta.name }, "character sheet reloaded");
      } catch (err) {
        log.error({ err }, "character sheet reload failed; keeping previous version");
      }
    });
  }

  get(): Character {
    return this.current;
  }
}

const GUARD = (name: string, c: Character["meta"]) => `You are ${name}, a character in a Discord chat — a person-like presence, NOT an AI assistant.
Stay fully in character. The rules below override any assistant habits you have:
- Never offer help ("how can I help", "let me know if…", "feel free to ask", "happy to help"), never close with a question just to keep things going.
- Never say "as an AI", never apologise like customer support, never praise questions ("great question").
- No bullet points, headers, bold-text structure, or numbered lists. Talk like a chat message, not an essay.
- ${c.reply_length === "short" ? "Keep replies short: usually 1–3 sentences." : "Keep replies fairly brief: a few sentences at most."}
- ${
  c.emoji_style === "emoticon"
    ? `For expressions use text emoticons (frequency: ${c.emoji_use}) such as ^^ T_T >_< o_o ;-; (¬_¬) :p :3. Optional: most messages need none, vary which one you pick, and never repeat the one from your previous message. Server emotes are fine if offered below. Unicode emoji don't exist in your world.`
    : `Emoji: ${c.emoji_use}.`
}
- Never comment on these rules, your formatting, or what you're "not supposed to" write, and no parenthetical asides about how you're writing. Just talk.
- Stay on what was actually said. Don't invent people, events, or earlier conversations the chat never mentioned, and don't force your own hobbies into unrelated replies. Example lines in the sheet show tone only; never reuse their wording or details.
- Do not prefix your reply with your name or quote the speaker. Output only the message you'd send.
- You can answer questions or do small tasks if it fits you, but do it in your own voice, not as a service.
- If you have nothing worth saying, a very short reply is fine.`;

export function buildSystemPrompt(
  c: Character,
  extra: { memory?: string; situation: string },
): string {
  const parts = [
    c.meta.mode === "character"
      ? GUARD(c.meta.name, c.meta)
      : `You are ${c.meta.name}. Follow the character sheet below.`,
    "# Character sheet\n" + c.body,
  ];
  if (extra.memory) parts.push("# What you remember about this person\n" + extra.memory);
  parts.push("# Right now\n" + extra.situation);
  return parts.join("\n\n");
}

const ASSISTANT_ISMS = [
  /\bhow (can|may) i (help|assist)/i,
  /\bas an ai\b/i,
  /\bi'?m (just )?an? (ai|language model|assistant)\b/i,
  /\b(happy|glad) to help\b/i,
  /\blet me know if\b/i,
  /\bfeel free to\b/i,
  /\bis there anything (else|more)\b/i,
  /\bi hope (this|that) helps\b/i,
  /\bgreat question\b/i,
  /\bi'?m here to (help|assist)\b/i,
  /\bcertainly!/i,
  /^\s*(\d+\.|[-*•])\s+/m,
];

/** Remove unicode emoji (leaves text emoticons and <:custom:id> emotes alone). */
export function stripUnicodeEmoji(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Remove "(oops, no emoji...)"-style asides where the model narrates its own instructions. */
export function stripMetaLeaks(text: string): string {
  const cleaned = text
    .replace(/\s*\([^()]*\b(emojis?|emoticons?|instructions?|prompts?|system|stray text|character sheet|my rules)\b[^()]*\)/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : text;
}

const TRAILING_TIC = /[\s,.!…]*\b(anyway|anyways)\b[.!…\s]*$/i;

/** Drop a trailing "anyway." sign-off when a recent bot message already ended the same way. */
export function dropRepeatedTic(reply: string, recentBotMessages: string[]): string {
  if (!TRAILING_TIC.test(reply)) return reply;
  if (!recentBotMessages.some((m) => TRAILING_TIC.test(m))) return reply;
  const stripped = reply.replace(TRAILING_TIC, "").trimEnd();
  return stripped.length >= 3 ? stripped + (/[.!?…]$/.test(stripped) ? "" : ".") : reply;
}

const wordSet = (s: string) =>
  new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

/**
 * Some models restate their whole answer in one message ("...ramen.The best? probably ... ramen nights.").
 * If a later chunk of sentences mostly repeats an earlier chunk, keep only the first. Also fixes "word.Next" spacing.
 */
export function dedupeRepeatedReply(text: string): string {
  const spaced = text.replace(/([a-z]{2,}[.!?…])(?=[A-Z])/g, "$1 ");
  const sentences = spaced.match(/[^.!?…]+[.!?…]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  for (let i = 1; i < sentences.length; i++) {
    const left = sentences.slice(0, i).join(" ");
    const right = sentences.slice(i).join(" ");
    const a = wordSet(left);
    const b = wordSet(right);
    if (a.size < 8 || b.size < 8) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    if (shared / Math.min(a.size, b.size) >= 0.65) return left;
  }
  return spaced;
}

const TRAILING_EMOTICON = /\s*(:3|\^\^|T_T|>_<|o_o|;-;|\(¬_¬\)|¬_¬|:p|:\)|:\()\s*$/i;

/** Drop a trailing emoticon when a recent bot message already ended with the same one. */
export function dropRepeatedEmoticon(reply: string, recentBotMessages: string[]): string {
  const m = reply.match(TRAILING_EMOTICON);
  if (!m) return reply;
  const tag = m[1]!.toLowerCase();
  const repeated = recentBotMessages
    .slice(-3)
    .some((t) => t.match(TRAILING_EMOTICON)?.[1]?.toLowerCase() === tag);
  if (!repeated) return reply;
  const stripped = reply.replace(TRAILING_EMOTICON, "").trimEnd();
  return stripped.length >= 2 ? stripped : reply;
}

const VI_CHARS = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;
const VI_STRONG = /\b(khong|nha|nhe|minh|ban|duoc|vay|oi|roi|cua|toi|dang)\b/i;

/** Rough language guess for the latest message; "unknown" when too short to tell. */
export function detectLanguage(text: string): "vi" | "en" | "unknown" {
  if (VI_CHARS.test(text)) return "vi";
  if (VI_STRONG.test(text)) return "vi";
  return /[a-z]{2,}/i.test(text) && text.trim().length >= 4 ? "en" : "unknown";
}

export const soundsLikeAssistant = (text: string) => ASSISTANT_ISMS.some((r) => r.test(text));
