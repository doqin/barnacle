import Groq from "groq-sdk";
import { config, FREE_MODELS } from "../config.js";
import { log } from "../logger.js";
import { BudgetExhausted, GroqLimiter, type Priority } from "./limiter.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOpts {
  model?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  priority?: Priority;
  json?: boolean;
}

const client = new Groq({ apiKey: config.GROQ_API_KEY, maxRetries: 0 });
export const limiter = new GroqLimiter();

export const approxTokens = (s: string) => Math.ceil(s.length / 3.5);

/** Remove reasoning blocks some models leak into content. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

function assertFree(model: string) {
  if (!(FREE_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Refusing to call non-free model: ${model}`);
  }
}

type ToolDef = Groq.Chat.Completions.ChatCompletionTool;

interface Attempt {
  text: string;
  toolCalls: { name: string; args: string }[];
}

/** One completion with limiter, model fallback, and 429 handling. */
async function attempt(opts: CompleteOpts, tools?: ToolDef[], extraTokens = 0): Promise<Attempt> {
  const primary = opts.model ?? config.MODEL_CHAT;
  const chain = [...new Set([primary, config.MODEL_FALLBACK, config.MODEL_UTILITY, config.MODEL_CHAT])];
  const maxTokens = opts.maxTokens ?? 400;
  const priority = opts.priority ?? "user";
  const promptTokens = opts.messages.reduce((s, m) => s + approxTokens(m.content) + 4, 0);
  const est = promptTokens + maxTokens + extraTokens;

  let lastErr: unknown;
  for (const model of chain) {
    assertFree(model);
    await limiter.acquire(est, priority);
    try {
      const isOss = model.startsWith("openai/gpt-oss");
      const res = await client.chat.completions.create({
        model,
        messages: opts.messages,
        max_completion_tokens: maxTokens,
        temperature: opts.temperature ?? 0.75,
        ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
        ...(tools ? { tools, tool_choice: "auto" as const } : {}),
        ...(isOss ? { reasoning_effort: "low" as const, include_reasoning: false } : {}),
      } as Parameters<typeof client.chat.completions.create>[0]);
      const completion = res as Groq.Chat.Completions.ChatCompletion;
      limiter.record(est, completion.usage?.total_tokens ?? est);
      const msg = completion.choices[0]?.message;
      const text = stripReasoning(msg?.content ?? "");
      const toolCalls = (msg?.tool_calls ?? []).map((t) => ({ name: t.function.name, args: t.function.arguments }));
      if (text || toolCalls.length) return { text, toolCalls };
      lastErr = new Error(`empty completion from ${model}`);
      log.warn({ model }, "empty completion, trying next model");
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      lastErr = err;
      const status = (err as { status?: number }).status;
      log.warn({ model, status, msg: (err as Error).message }, "groq call failed");
      limiter.record(est, 0);
      if (status === 429) limiter.penalize();
      else if (status === 401 || status === 403) throw err;
      // 429 / 404 (model gone) / 5xx → try next model in chain
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all models failed");
}

/** One completion returning cleaned text. */
export async function complete(opts: CompleteOpts): Promise<string> {
  return (await attempt(opts)).text;
}

const SEARCH_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Look something up online. Use it whenever someone mentions or asks about a specific real-world thing you aren't sure about: " +
      "songs, albums, bands, artists, bassists/musicians, games, shows, books, memes, slang, products, places, recent events, or facts. " +
      "Prefer searching over guessing. Not for chit-chat, feelings, or facts about your own life.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Short plain search query. No personal info." } },
      required: ["query"],
    },
  },
};

export interface ToolReply {
  text: string;
  /** The conversation to continue from (includes any search results as a plain note). */
  messages: ChatMessage[];
  searched: boolean;
}

/**
 * Completion where the model may call `web_search` once. Results are fed back as a plain note
 * (not a tool message) so later regenerations can reuse the same conversation.
 */
export async function completeWithSearch(
  opts: CompleteOpts,
  search: (query: string) => Promise<string>,
): Promise<ToolReply> {
  let first: Attempt;
  try {
    first = await attempt(opts, [SEARCH_TOOL], 150);
  } catch (err) {
    if (err instanceof BudgetExhausted) throw err;
    log.warn({ msg: (err as Error).message }, "tool-enabled call failed, retrying without search");
    return { text: await complete(opts), messages: opts.messages, searched: false };
  }

  const call = first.toolCalls.find((c) => c.name === "web_search");
  if (!call) {
    if (first.text) return { text: first.text, messages: opts.messages, searched: false };
    return { text: await complete(opts), messages: opts.messages, searched: false };
  }

  let query = "";
  try {
    query = String((JSON.parse(call.args) as { query?: unknown }).query ?? "").trim();
  } catch {
    /* fall through to empty query */
  }
  let note: string;
  if (!query) {
    note = "(you tried to look something up but it didn't work; answer from what you know and be honest that you're unsure)";
  } else {
    try {
      log.info({ query }, "web search");
      const results = await search(query);
      note =
        `(you just looked this up on your phone. ${results}\n` +
        `Treat results as rough hints, may be wrong. Reply to the chat as yourself in your own voice: no links, no quoting, ` +
        `never mention searching tools or sources by name.)`;
    } catch (err) {
      log.warn({ query, msg: (err as Error).message }, "search failed");
      note = "(you tried to look it up but your phone/internet failed; answer from what you know and be honest that you're unsure)";
    }
  }
  const messages: ChatMessage[] = [...opts.messages, { role: "user", content: note }];
  return { text: await complete({ ...opts, messages }), messages, searched: true };
}

/** JSON-mode completion parsed leniently; returns null when the output is unusable. */
export async function completeJson<T = unknown>(opts: Omit<CompleteOpts, "json">): Promise<T | null> {
  const text = await complete({ ...opts, json: true, temperature: opts.temperature ?? 0.2 });
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}
