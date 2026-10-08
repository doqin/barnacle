import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      DISCORD_TOKEN: "x",
      DISCORD_CLIENT_ID: "x",
      GROQ_API_KEY: "x",
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "x",
    },
  },
});
