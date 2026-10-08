import { describe, expect, it } from "vitest";
import { buildSystemPrompt, parseCharacter, soundsLikeAssistant } from "../src/character/loader.js";
import { GroqLimiter, BudgetExhausted } from "../src/llm/limiter.js";
import { stripReasoning } from "../src/llm/groq.js";
import { rankMemories, similarity } from "../src/memory/recall.js";
import { selectForCondensing } from "../src/memory/condense.js";
import type { MemoryRow } from "../src/db/store.js";

const mem = (over: Partial<MemoryRow>): MemoryRow => ({
  id: Math.random().toString(), user_id: "u", kind: "fact", content: "x", importance: 2,
  created_at: new Date().toISOString(), last_referenced_at: null, condensed: false, ...over,
});

describe("character", () => {
  const sheet = parseCharacter("---\nname: Bo\nnicknames: [bobo]\n---\n## Persona\nA crab.");
  it("parses frontmatter with defaults", () => {
    expect(sheet.meta).toMatchObject({ name: "Bo", mode: "character", nicknames: ["bobo"] });
  });
  it("adds the anti-assistant guard only in character mode", () => {
    expect(buildSystemPrompt(sheet, { situation: "s" })).toMatch(/NOT an AI assistant/);
    const asst = parseCharacter("---\nmode: assistant\n---\nbody");
    expect(buildSystemPrompt(asst, { situation: "s" })).not.toMatch(/NOT an AI assistant/);
  });
  it("detects assistant-isms", () => {
    expect(soundsLikeAssistant("Sure! How can I help you today?")).toBe(true);
    expect(soundsLikeAssistant("1. do this\n2. do that")).toBe(true);
    expect(soundsLikeAssistant("ugh fine. plants eat sunlight.")).toBe(false);
  });
});

describe("limiter", () => {
  it("tracks daily budget and refuses background work when low", async () => {
    const l = new GroqLimiter({ requests: 0, tokens: 150_000 });
    expect(l.budgetRemaining()).toBeLessThan(0.3);
    await expect(l.acquire(100, "background")).rejects.toBeInstanceOf(BudgetExhausted);
    await expect(l.acquire(100, "user")).resolves.toBeUndefined();
  });
  it("waits when the per-minute window is full", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const l = new GroqLimiter(undefined, () => t, async (ms) => { sleeps.push(ms); t += ms; });
    await l.acquire(6000, "user");
    await l.acquire(6000, "user"); // exceeds 7000 TPM → must sleep until the first expires
    expect(sleeps.length).toBeGreaterThan(0);
    expect(t).toBeGreaterThanOrEqual(60_000);
  });
});

describe("memory", () => {
  it("ranks relevant + important memories first", () => {
    const ranked = rankMemories([mem({ content: "Likes sour candy", importance: 2 }), mem({ content: "Has a cat named Miso", importance: 2 }), mem({ content: "Works as a nurse", importance: 4 })], "how is my cat doing");
    expect(ranked[0]!.content).toMatch(/cat/);
  });
  it("detects near-duplicates", () => {
    expect(similarity("Has a cat named Miso", "has a cat called Miso")).toBeGreaterThan(0.5);
    expect(similarity("Likes pizza", "Works as a nurse")).toBe(0);
  });
  it("condenses only old, non-core memories", () => {
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const batch = selectForCondensing([mem({ created_at: old }), mem({ created_at: old, importance: 5 }), mem({})]);
    expect(batch).toHaveLength(1);
  });
});

describe("llm helpers", () => {
  it("strips reasoning blocks", () => {
    expect(stripReasoning("<think>hmm</think>hello")).toBe("hello");
  });
});

import { applyEmotes } from "../src/discord/emotes.js";
describe("emotes", () => {
  const emotes = new Map([["kekw", { id: "1", animated: false }], ["dance", { id: "2", animated: true }]]);
  it("expands known emotes and leaves unknown ones", () => {
    expect(applyEmotes("lol :kekw: and :dance: but :nope:", emotes)).toBe("lol <:kekw:1> and <a:dance:2> but :nope:");
    expect(applyEmotes("already <:kekw:1>", emotes)).toBe("already <:kekw:1>");
  });
});

import { dropRepeatedTic } from "../src/character/loader.js";
describe("dropRepeatedTic", () => {
  it("strips a repeated trailing anyway but allows the first one", () => {
    expect(dropRepeatedTic("so good. anyway.", [])).toBe("so good. anyway.");
    expect(dropRepeatedTic("so good. anyway.", ["nah. anyway."])).toBe("so good.");
    expect(dropRepeatedTic("so good", ["nah. anyway."])).toBe("so good");
  });
});

import { stripUnicodeEmoji } from "../src/character/loader.js";
describe("stripUnicodeEmoji", () => {
  it("removes emoji but keeps emoticons and custom emotes", () => {
    expect(stripUnicodeEmoji("hii 😭 ok :3 <:kekw:1> T_T 👍🏽")).toBe("hii ok :3 <:kekw:1> T_T");
  });
});

import { SearchQuota, formatResults } from "../src/search/tavily.js";
describe("search", () => {
  it("enforces daily and per-user hourly caps", () => {
    let t = Date.parse("2026-03-10T10:00:00Z");
    const q = new SearchQuota({ perDay: 3, perUserHour: 2 }, () => t);
    q.record("a"); q.record("a");
    expect(q.canSearch("a")).toBe(false);
    expect(q.canSearch("b")).toBe(true);
    t += 3_600_001;
    expect(q.canSearch("a")).toBe(true);
    q.record("b");
    expect(q.canSearch("c")).toBe(false); // daily cap of 3 reached
  });
  it("formats compact link-free results", () => {
    const out = formatResults("rizz meaning", [{ title: "Rizz", url: "https://www.example.com/x", content: "charisma ".repeat(100) }]);
    expect(out).toContain("example.com");
    expect(out).not.toContain("https://");
    expect(out.length).toBeLessThan(400);
    expect(formatResults("zzz", [])).toMatch(/No useful results/);
  });
});

import { stripMetaLeaks } from "../src/character/loader.js";
describe("stripMetaLeaks", () => {
  it("removes asides narrating instructions but keeps normal parentheses", () => {
    expect(stripMetaLeaks("yeah epic. (oops, no emoji—just a stray text) maybe later")).toBe("yeah epic. maybe later");
    expect(stripMetaLeaks("it was fine (kinda) lol")).toBe("it was fine (kinda) lol");
  });
});
