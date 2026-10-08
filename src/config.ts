import "dotenv/config";
import { z } from "zod";

/** The only models this bot may ever call (Groq free tier). */
export const FREE_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
] as const;

const freeModel = z.enum(FREE_MODELS);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  GROQ_API_KEY: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  MODEL_CHAT: freeModel.default("openai/gpt-oss-120b"),
  MODEL_UTILITY: freeModel.default("openai/gpt-oss-20b"),
  MODEL_FALLBACK: freeModel.default("qwen/qwen3.8-27b"),

  /** Optional. Without it web search is simply off. */
  TAVILY_API_KEY: z.string().optional().transform((v) => v || undefined),
  SEARCH_MAX_PER_DAY: z.coerce.number().default(40),
  SEARCH_MAX_PER_USER_HOUR: z.coerce.number().default(4),

  TZ: z.string().default("UTC"),
  CHARACTER_PATH: z.string().default("character/character.md"),
  FOLLOWUP_WINDOW_SEC: z.coerce.number().default(180),
  MAX_UNPINGED_STREAK: z.coerce.number().default(4),

  OUTREACH_ENABLED: bool.default(true),
  OUTREACH_TICK_MIN: z.coerce.number().default(10),
  OUTREACH_START_HOUR: z.coerce.number().min(0).max(23).default(10),
  OUTREACH_END_HOUR: z.coerce.number().min(1).max(24).default(22),
  OUTREACH_MIN_GAP_HOURS: z.coerce.number().default(48),
  OUTREACH_QUIET_AFTER_CHAT_HOURS: z.coerce.number().default(12),
  OUTREACH_IGNORE_AFTER_HOURS: z.coerce.number().default(24),
  OUTREACH_MAX_PER_DAY: z.coerce.number().default(2),
  OUTREACH_MAX_STRIKES: z.coerce.number().default(3),
  OUTREACH_FIRE_PROBABILITY: z.coerce.number().min(0).max(1).default(0.25),

  LOG_LEVEL: z.string().default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:\n" + z.prettifyError(parsed.error));
  console.error(`Models must be one of the free-tier set: ${FREE_MODELS.join(", ")}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
