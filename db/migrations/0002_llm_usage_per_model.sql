-- Groq applies its free-tier limits per model, so usage is now stored per (day, model).
-- Existing rows keep their totals under model '*' (the bot restores those onto the main chat model).
alter table llm_usage add column if not exists model text not null default '*';
alter table llm_usage drop constraint if exists llm_usage_pkey;
alter table llm_usage add primary key (day, model);
