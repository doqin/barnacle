import type { Guild } from "discord.js";

export type EmoteMap = Map<string, { id: string; animated: boolean }>;

const MAX_LISTED = 40; // keeps the prompt small for the 8K TPM free tier

export function guildEmotes(guild: Guild | null): EmoteMap {
  const map: EmoteMap = new Map();
  if (!guild) return map;
  for (const e of guild.emojis.cache.values()) {
    if (e.name && e.available !== false) map.set(e.name, { id: e.id, animated: !!e.animated });
  }
  return map;
}

/** Prompt line telling the model which server emotes exist (a random sample if there are many). */
export function emotePrompt(emotes: EmoteMap): string {
  if (emotes.size === 0) return "";
  const names = [...emotes.keys()].sort(() => Math.random() - 0.5).slice(0, MAX_LISTED);
  return (
    `This server has custom emotes. You may occasionally use one when its name fits the mood, written exactly as :name: with a colon on BOTH sides ` +
    `(never invent names, never use more than one per message): ${names.join(", ")}.`
  );
}

/** Turn :name: into Discord's <:name:id> syntax for known emotes; unknown ones are left as-is. */
export function applyEmotes(text: string, emotes: EmoteMap): string {
  if (emotes.size === 0) return text;
  const byLower = new Map([...emotes].map(([name, e]) => [name.toLowerCase(), { name, ...e }]));
  const names = [...emotes.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Models often botch the closing colon (":name]", ":name)", ":name"), so for names we know about
  // accept a closer of ":", "]", ")", or just a word boundary. Unknown :words: are left untouched.
  const re = new RegExp(`(?<!<a?|[A-Za-z0-9]):(${names.join("|")})(?::|\\]|\\)|(?![A-Za-z0-9_]))`, "gi");
  return text.replace(re, (_m, name: string) => {
    const e = byLower.get(name.toLowerCase());
    return e ? `<${e.animated ? "a" : ""}:${e.name}:${e.id}>` : _m;
  });
}
