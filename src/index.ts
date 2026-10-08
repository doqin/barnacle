import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { CharacterStore } from "./character/loader.js";
import { config } from "./config.js";
import { loadUsage, saveUsage } from "./db/store.js";
import { registerCommandHandlers, registerCommands } from "./discord/commands.js";
import { flushAllTurns, registerMessageEvents } from "./discord/events.js";
import { limiter } from "./llm/groq.js";
import { log } from "./logger.js";
import { runCondenseJob } from "./memory/condense.js";
import { startOutreach } from "./outreach/scheduler.js";

const store = new CharacterStore(path.resolve(config.CHARACTER_PATH));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable in the Discord developer portal
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

registerMessageEvents(client, store);
registerCommandHandlers(client);

async function flushUsage() {
  const u = limiter.takeDirty();
  if (u) await saveUsage(u).catch((err) => log.warn({ err }, "usage save failed"));
}

client.once(Events.ClientReady, async (c) => {
  log.info({ tag: c.user.tag, character: store.get().meta.name }, "online");

  const today = limiter.snapshot();
  const saved = await loadUsage(today.day).catch(() => null);
  if (saved) limiter.restore(saved);

  await registerCommands(c.application.id).catch((err) => log.error({ err }, "command registration failed"));

  setInterval(() => void flushUsage(), 30_000);
  setInterval(() => void runCondenseJob(), 6 * 3_600_000);
  setTimeout(() => void runCondenseJob(), 5 * 60_000);
  startOutreach(client, store);

  const beat = path.join(os.tmpdir(), "heartbeat");
  const touch = () => fs.writeFileSync(beat, String(Date.now()));
  touch();
  setInterval(touch, 30_000);
});

async function shutdown() {
  log.info("shutting down");
  await flushAllTurns().catch(() => {});
  await flushUsage();
  await client.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await client.login(config.DISCORD_TOKEN);
