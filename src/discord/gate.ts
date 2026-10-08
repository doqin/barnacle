export interface ChannelState {
  lastBotAt: number;
  lastAddressedId: string | null;
  unpingedStreak: number;
}

export interface GateInput {
  isDM: boolean;
  mentioned: boolean;
  isReplyToBot: boolean;
  /** message pings someone other than the bot, or replies to someone other than the bot */
  addressesOthers: boolean;
  /** content contains the character's name/nickname as a word */
  nameMentioned: boolean;
  authorId: string;
  content: string;
  now: number;
}

export type GateDecision = "reply" | "ask" | "ignore";

export interface GateConfig {
  followupWindowMs: number;
  maxUnpingedStreak: number;
}

const SECOND_PERSON = /\b(you|your|youre|you're|u|ur|ya)\b/i;

/**
 * Free heuristics for "should the bot answer this?". "ask" means ambiguous: let the cheap
 * LLM check decide (the caller skips it when the daily budget is low).
 */
export function decide(input: GateInput, state: ChannelState | undefined, cfg: GateConfig): GateDecision {
  if (input.isDM || input.mentioned || input.isReplyToBot) return "reply";
  if (input.addressesOthers) return "ignore";
  if (input.content.trim().length < 2) return "ignore";

  const inWindow = !!state && input.now - state.lastBotAt <= cfg.followupWindowMs;
  if (!inWindow || !state) return input.nameMentioned ? "ask" : "ignore";
  if (state.unpingedStreak >= cfg.maxUnpingedStreak) return input.nameMentioned ? "ask" : "ignore";

  const looksDirected = input.content.includes("?") || SECOND_PERSON.test(input.content);
  if (state.lastAddressedId === input.authorId) return looksDirected || input.nameMentioned ? "reply" : "ask";
  return looksDirected || input.nameMentioned ? "ask" : "ignore";
}
