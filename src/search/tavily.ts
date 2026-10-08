import { config } from "../config.js";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

const MAX_RESULTS = 4;
const SNIPPET_CHARS = 240; // ≈ 70 tokens each; keeps a search under ~350 tokens total

const domain = (url = "") => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Compact, link-free text block for the model. Pure so it can be tested. */
export function formatResults(query: string, results: TavilyResult[]): string {
  const lines = results.slice(0, MAX_RESULTS).map((r, i) => {
    const text = (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
    return `${i + 1}. ${r.title ?? "untitled"} (${domain(r.url)}): ${text}`;
  });
  return lines.length ? `Results for "${query}":\n${lines.join("\n")}` : `No useful results for "${query}".`;
}

/** One Tavily search. Only the query leaves the bot, never user identities or memories. */
export async function webSearch(query: string): Promise<string> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query: query.slice(0, 200),
      search_depth: "basic",
      max_results: MAX_RESULTS,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const data = (await res.json()) as { results?: TavilyResult[] };
  return formatResults(query, data.results ?? []);
}

/** Daily and per-user-per-hour caps so searches (and their extra LLM call) stay cheap. */
export class SearchQuota {
  private day = "";
  private today = 0;
  private perUser = new Map<string, number[]>();

  constructor(
    private cfg: { perDay: number; perUserHour: number },
    private now: () => number = Date.now,
  ) {}

  private roll() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.today = 0;
    }
  }

  private recent(userId: string): number[] {
    const cutoff = this.now() - 3_600_000;
    const list = (this.perUser.get(userId) ?? []).filter((t) => t > cutoff);
    this.perUser.set(userId, list);
    return list;
  }

  canSearch(userId: string): boolean {
    this.roll();
    return this.today < this.cfg.perDay && this.recent(userId).length < this.cfg.perUserHour;
  }

  record(userId: string) {
    this.roll();
    this.today += 1;
    this.recent(userId).push(this.now());
  }
}

export const searchQuota = new SearchQuota({
  perDay: config.SEARCH_MAX_PER_DAY,
  perUserHour: config.SEARCH_MAX_PER_USER_HOUR,
});

export const searchEnabled = () => !!config.TAVILY_API_KEY;
