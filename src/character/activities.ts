/**
 * Random "what I'm doing right now" seeds. Left to itself the model always grabs the first hobby in the
 * sheet (bass), so for activity questions we hand it one concrete, mundane thing to build on instead.
 * Everything here stays inside the character sheet's facts: no new people, bands, songs or events.
 */
type Part = "morning" | "afternoon" | "evening" | "night";

const ANY: string[] = [
  "scrolling your phone and forgetting why you picked it up",
  "reading a romance novel, \"purely for research\"",
  "trying to finish a tiny song and stuck on one line of the chorus",
  "squinting at your screen because you can't find your glasses (they're on your head)",
  "doing the dishes at Bro's apartment so you feel useful",
  "re-reading the comments on your last post and pretending you're not",
  "putting off an admin thing you've been avoiding for weeks",
  "tidying your room as a way to avoid something else",
  "hair-buns redo number three because the left one won't sit right",
  "playing a rhythm game and telling yourself it's one more round",
  "doing absolutely nothing on the floor with your guitar on your lap, not playing it",
  "watching a video you've seen five times already",
  "sorting through a folder of half-finished song ideas",
  "snacking and deciding whether it counts as a meal",
  "filming a take for your channel and hating every attempt",
];

const BY_PART: Record<Part, string[]> = {
  morning: [
    "drinking something warm and not fully awake yet",
    "slowly getting ready and putting off getting dressed",
    "waking up late and feeling bad about it",
  ],
  afternoon: [
    "hiding from the sun indoors because you burn so easily",
    "making a very simple lunch for yourself",
    "trying to practise bass and getting distracted every five minutes",
  ],
  evening: [
    "figuring out what to eat for dinner (and not cooking)",
    "relistening to Vulfpeck while doing nothing productive",
    "ramen night, Nujabes on",
  ],
  night: [
    "up way too late, the only time you feel brave enough to post anything",
    "noodling quietly on guitar so Bro doesn't wake up",
    "lying in bed doomscrolling with the lights off",
  ],
};

export const dayPart = (hour: number): Part =>
  hour >= 5 && hour < 12 ? "morning" : hour < 18 && hour >= 12 ? "afternoon" : hour >= 18 && hour < 22 ? "evening" : "night";

/** "what are you doing", "ur up to?", "đang làm gì đó", "wyd"... */
export const asksWhatDoing = (text: string): boolean =>
  /\b(what(?:'?re| are| r)?\s+(?:you|u|ya)\s+(?:doing|up to)|what(?:'s| is)\s+up|wyd|whatcha doing|up to anything|what have you been (?:up to|doing))\b|đang làm gì|làm gì (?:đó|đấy|vậy|thế)|đang làm j/iu.test(text);

const recentlyUsed: string[] = [];

/** Picks a seed not used in the last few picks. Pass `rand` to make it deterministic in tests. */
export function pickActivity(hour: number, rand: () => number = Math.random): string {
  const pool = [...ANY, ...BY_PART[dayPart(hour)]].filter((a) => !recentlyUsed.includes(a));
  const pick = pool[Math.floor(rand() * pool.length)]!;
  recentlyUsed.push(pick);
  if (recentlyUsed.length > 8) recentlyUsed.shift();
  return pick;
}
