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
    `This server has custom emotes. You may occasionally use one when its name fits the mood, written as :name: ` +
    `(never invent names, never use more than one per message): ${names.join(", ")}.`
  );
}

/** Turn :name: into Discord's <:name:id> syntax for known emotes; unknown ones are left as-is. */
export function applyEmotes(text: string, emotes: EmoteMap): string {
  if (emotes.size === 0) return text;
  return text.replace(/(?<!<a?):([A-Za-z0-9_]{2,32}):/g, (m, name: string) => {
    const e = emotes.get(name);
    return e ? `<${e.animated ? "a" : ""}:${name}:${e.id}>` : m;
  });
}
