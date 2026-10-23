import { defineConfig } from "drizzle-kit";

try {
  process.loadEnvFile(".env.local");
} catch {
  // CI or a shell that already exports DATABASE_URL_UNPOOLED
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./drizzle",
  // Migrations use the direct connection; the pooler can't hold session state.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED! },
});
