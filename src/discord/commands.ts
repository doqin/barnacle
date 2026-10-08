import { Events, MessageFlags, REST, Routes, SlashCommandBuilder, type Client } from "discord.js";
import { config } from "../config.js";
import { forgetUser, setOptOut, upsertUser } from "../db/store.js";
import { log } from "../logger.js";
import { dropTurns } from "./events.js";

const commands = [
  new SlashCommandBuilder().setName("forget").setDescription("Make me forget everything I know about you."),
  new SlashCommandBuilder()
    .setName("optout")
    .setDescription("Stop (or resume) me DMing you first.")
    .addBooleanOption((o) => o.setName("stop").setDescription("true = stop DMing you (default), false = allow again")),
].map((c) => c.toJSON());

export async function registerCommands() {
  const rest = new REST().setToken(config.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), { body: commands });
  log.info("slash commands registered");
}

export function registerCommandHandlers(client: Client) {
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand()) return;
    const ephemeral = { flags: MessageFlags.Ephemeral } as const;
    try {
      await upsertUser(i.user.id, i.user.displayName);
      if (i.commandName === "forget") {
        dropTurns(i.user.id);
        await forgetUser(i.user.id);
        await i.reply({ content: "done. wiped everything I remembered about you.", ...ephemeral });
      } else if (i.commandName === "optout") {
        const stop = i.options.getBoolean("stop") ?? true;
        await setOptOut(i.user.id, stop);
        await i.reply({
          content: stop ? "ok, I won't DM you first anymore." : "ok, I might DM you now and then.",
          ...ephemeral,
        });
      }
    } catch (err) {
      log.error({ err }, "command failed");
      if (!i.replied) await i.reply({ content: "something broke, try again later.", ...ephemeral }).catch(() => {});
    }
  });
}
