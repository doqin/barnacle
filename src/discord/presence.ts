import { ActivityType, type Activity, type Client } from "discord.js";
import { config } from "../config.js";

/** Activity text is user-controlled, so keep it short and single-line before it goes near a prompt. */
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").replace(/["\\]/g, "'").trim().slice(0, 80);

function describe(a: Activity): string | null {
  const name = clean(a.name);
  if (!name) return null;
  switch (a.type) {
    case ActivityType.Listening: {
      const song = clean(a.details);
      const artist = clean(a.state);
      return song ? `listening to "${song}"${artist ? ` by ${artist}` : ""} on ${name}` : `listening to ${name}`;
    }
    case ActivityType.Playing:
      return `playing ${name}`;
    case ActivityType.Watching:
      return `watching ${name}`;
    case ActivityType.Competing:
      return `competing in ${name}`;
    default:
      return null; // custom statuses and streams are skipped: too personal / not an "activity"
  }
}

/** What the user is doing right now according to their Discord rich presence, e.g. `playing Hades`. Null if nothing visible. */
export function currentActivity(client: Client, userId: string): string | null {
  if (!config.PRESENCE_ENABLED) return null;
  for (const guild of client.guilds.cache.values()) {
    const presence = guild.presences.cache.get(userId);
    if (!presence || presence.status === "offline") continue;
    const found = presence.activities.map(describe).find((d): d is string => !!d);
    if (found) return found;
  }
  return null;
}
