import { describe, expect, it } from "vitest";
import { asksWhatDoing, dayPart, pickActivity } from "../src/character/activities.js";

describe("activities", () => {
  it("detects what-are-you-doing questions", () => {
    for (const t of ["what are you doing rn", "wyd", "what r u doing", "kako đang làm gì đó", "what's up"]) expect(asksWhatDoing(t)).toBe(true);
    for (const t of ["what are you reading", "how was your day"]) expect(asksWhatDoing(t)).toBe(false);
  });
  it("maps hours to day parts", () => {
    expect([6, 13, 19, 23, 2].map(dayPart)).toEqual(["morning", "afternoon", "evening", "night", "night"]);
  });
  it("doesn't repeat the same seed back to back", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(pickActivity(14, () => 0));
    expect(seen.size).toBe(8);
  });
});
