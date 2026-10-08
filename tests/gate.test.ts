import { describe, expect, it } from "vitest";
import { decide, type GateInput } from "../src/discord/gate.js";

const cfg = { followupWindowMs: 180_000, maxUnpingedStreak: 4 };
const now = 1_000_000_000;
const base: GateInput = {
  isDM: false, mentioned: false, isReplyToBot: false, addressesOthers: false,
  nameMentioned: false, authorId: "u1", content: "hello there", now,
};
const state = (over = {}) => ({ lastBotAt: now - 30_000, lastAddressedId: "u1", unpingedStreak: 0, ...over });

describe("gate.decide", () => {
  it("always replies to DMs, pings, and replies", () => {
    expect(decide({ ...base, isDM: true }, undefined, cfg)).toBe("reply");
    expect(decide({ ...base, mentioned: true }, undefined, cfg)).toBe("reply");
    expect(decide({ ...base, isReplyToBot: true }, undefined, cfg)).toBe("reply");
  });
  it("ignores chatter with no recent bot activity", () => {
    expect(decide(base, undefined, cfg)).toBe("ignore");
    expect(decide(base, state({ lastBotAt: now - 600_000 }), cfg)).toBe("ignore");
  });
  it("ignores messages aimed at other people", () => {
    expect(decide({ ...base, addressesOthers: true, content: "you ok?" }, state(), cfg)).toBe("ignore");
  });
  it("follow-up from the same user: question replies, plain statement asks", () => {
    expect(decide({ ...base, content: "what about you?" }, state(), cfg)).toBe("reply");
    expect(decide({ ...base, content: "lol ok" }, state(), cfg)).toBe("ask");
  });
  it("other users in the window only trigger a check when directed-looking", () => {
    expect(decide({ ...base, authorId: "u2", content: "random chatter" }, state(), cfg)).toBe("ignore");
    expect(decide({ ...base, authorId: "u2", content: "do you like it?" }, state(), cfg)).toBe("ask");
  });
  it("respects the un-pinged streak cap", () => {
    expect(decide({ ...base, content: "what about you?" }, state({ unpingedStreak: 4 }), cfg)).toBe("ignore");
  });
  it("name mention outside the window asks", () => {
    expect(decide({ ...base, nameMentioned: true }, undefined, cfg)).toBe("ask");
  });
});
