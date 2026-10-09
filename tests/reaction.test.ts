import { describe, expect, it } from "vitest";
import { likelyReaction } from "../src/discord/events.js";

describe("likelyReaction", () => {
  it.each(["lol", "LMAO", "haha", "hahahaha", "ok", "okay!", "nice", "true fr", "oof", "ừ", "😂😂", "...", ":3", "loool", "ok lol", "bruh"])(
    "treats %s as a reaction",
    (t) => expect(likelyReaction(t)).toBe(true),
  );
  it.each(["hi kako", "good morning", "i'm back", "what's up", "ok?", "lol what", "how are you", "yes", "no", "ok but why"])(
    "treats %s as needing a reply",
    (t) => expect(likelyReaction(t)).toBe(false),
  );
});
