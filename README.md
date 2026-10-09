# Barnacle

A Discord bot with an LLM brain (Groq free tier), a character sheet, per-user persistent memory (Supabase), and limited autonomous DMs.

## Setup
1. **Discord**: create an app + bot in the developer portal, enable the **Message Content Intent**, invite with `bot` + `applications.commands` scopes (permissions: read/send messages, add reactions).
2. **Supabase**: create a project, run `db/migrations/0001_init.sql` and then `db/migrations/0002_llm_usage_per_model.sql` in the SQL editor.
3. **Groq**: create an API key (free tier).
4. `cp .env.example .env` and fill in the secrets.
5. Run: `docker compose up -d --build` (or `npm i && npm run dev` locally).

## Character
Edit `character/character.md` — it hot-reloads (mounted as a volume in compose). With `mode: character` a guard prompt plus an output filter keep it from sounding like an assistant; set `mode: assistant` to opt out.

## Behaviour
- **Replies**: always to DMs, @mentions and replies to its messages. After it speaks, it may answer follow-ups without a ping: heuristics first (same author, question/"you", name used, nobody else addressed), then a tiny `gpt-oss-20b` yes/no check when ambiguous. Capped at `MAX_UNPINGED_STREAK` in a row.
- **Memory**: facts are extracted after a conversation goes quiet, recalled by importance/recency/keyword overlap, and memories older than 30 days (or beyond 60 live) are folded into a rolling profile. `/forget` wipes it all.
- **Outreach** (DM only): only to users who've addressed the bot before, not opted out (`/optout`), during `OUTREACH_START_HOUR`–`END_HOUR` in `TZ`, ≥48h between DMs, not within 12h of chatting, and only when there's a memory worth following up on. Unanswered after 24h = ignored → cooldown 1d → 3d → 7d; after 3 consecutive ignores it stops until the user talks to it first. A reply resets everything.
- **Web search** (optional): set `TAVILY_API_KEY` (free key at tavily.com) and she can google things she doesn't recognise (slang, memes, songs, news) via a `web_search` tool. One search per reply, ~4 short snippets fed back as a hint, capped by `SEARCH_MAX_PER_DAY` / `SEARCH_MAX_PER_USER_HOUR`, and skipped when the Groq daily budget is low. Only the search query leaves the bot. Leave the key empty to disable.
- **Free tier only**: models are validated against `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`; a client-side limiter stays under 30 RPM / 8K TPM / 1K RPD / 200K TPD, and background jobs yield when the daily budget is low.

## Dev
`npm test` · `npm run typecheck` · `npm run build`
