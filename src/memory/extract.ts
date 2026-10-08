import { z } from "zod";
import { config } from "../config.js";
import { addMemories, getLiveMemories, type MemoryKind } from "../db/store.js";
import { completeJson } from "../llm/groq.js";
import { log } from "../logger.js";
import { similarity } from "./recall.js";

const outSchema = z.object({
  memories: z
    .array(
      z.object({
        kind: z.enum(["fact", "preference", "event", "relationship"]),
        content: z.string().min(3).max(200),
        importance: z.coerce.number().int().min(1).max(5),
      }),
    )
    .max(3),
});

export interface Turn {
  who: "user" | "bot";
  text: string;
}

const SYSTEM = `You extract durable memories about a person from a chat transcript so a chat companion can remember them later.
Only store things worth remembering weeks from now: stable facts (job, pets, location), preferences, upcoming/past life events (exam Friday, trip), and relationship info.
Skip small talk, jokes, and anything about the companion itself. Never store secrets like passwords or payment info.
Write each memory as one short third-person sentence, e.g. "Has a cat named Miso." Importance 1-5 (5 = core identity or big upcoming event).
Respond with JSON only: {"memories":[{"kind":"fact|preference|event|relationship","content":"...","importance":3}]}. Return {"memories":[]} if nothing qualifies.`;

/** Pull 0–3 durable facts out of a user's recent turns and store the non-duplicates. */
export async function extractMemories(userId: string, username: string, turns: Turn[]): Promise<number> {
  const userTurns = turns.filter((t) => t.who === "user");
  if (userTurns.length === 0) return 0;

  const existing = await getLiveMemories(userId, 40);
  const transcript = turns
    .slice(-14)
    .map((t) => `${t.who === "user" ? username : "companion"}: ${t.text.slice(0, 300)}`)
    .join("\n");
  const known = existing.slice(0, 12).map((m) => `- ${m.content}`).join("\n") || "(nothing yet)";

  const raw = await completeJson({
    model: config.MODEL_UTILITY,
    priority: "background",
    maxTokens: 300,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Already known about ${username}:\n${known}\n\nTranscript:\n${transcript}` },
    ],
  });
  const parsed = outSchema.safeParse(raw);
  if (!parsed.success) {
    log.debug({ userId }, "memory extraction returned unusable output");
    return 0;
  }

  const fresh: { kind: MemoryKind; content: string; importance: number }[] = [];
  for (const m of parsed.data.memories) {
    const dup = [...existing.map((e) => e.content), ...fresh.map((f) => f.content)].some(
      (c) => similarity(c, m.content) > 0.6,
    );
    if (!dup) fresh.push(m);
  }
  await addMemories(userId, fresh);
  return fresh.length;
}
