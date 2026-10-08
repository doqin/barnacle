import type { MemoryRow } from "../db/store.js";
import { getLiveMemories, getSummary, markReferenced } from "../db/store.js";

const STOP = new Set("the a an and or but to of in on at for is are was were be i you he she it we they my your me this that with as so do did not no yes just like".split(" "));

export const tokenize = (s: string): string[] =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Rank memories by importance, recency, and keyword overlap with the current message. */
export function rankMemories(memories: MemoryRow[], query: string, now = Date.now()): MemoryRow[] {
  const q = new Set(tokenize(query));
  const scored = memories.map((m) => {
    const ageDays = (now - new Date(m.created_at).getTime()) / 86_400_000;
    const words = tokenize(m.content);
    const overlap = words.filter((w) => q.has(w)).length;
    const score = m.importance * 1.0 + Math.max(0, 3 - ageDays / 10) + overlap * 2.5;
    return { m, score };
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.m);
}

/** Jaccard similarity on word sets, used to avoid storing near-duplicate memories. */
export function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

const MAX_MEMORY_CHARS = 1100; // ≈ 300 tokens; keeps prompts small for the 8K TPM free tier

/** Compact "what I remember about this person" block, or "" when nothing is known. */
export async function buildMemoryBlock(userId: string, query: string): Promise<string> {
  const [summary, live] = await Promise.all([getSummary(userId), getLiveMemories(userId)]);
  const lines: string[] = [];
  let used = 0;
  if (summary) {
    lines.push(summary);
    used += summary.length;
  }
  const picked: string[] = [];
  for (const m of rankMemories(live, query).slice(0, 8)) {
    const line = `- ${m.content}`;
    if (used + line.length > MAX_MEMORY_CHARS) break;
    lines.push(line);
    picked.push(m.id);
    used += line.length;
  }
  if (picked.length) void markReferenced(picked).catch(() => {});
  return lines.join("\n");
}
