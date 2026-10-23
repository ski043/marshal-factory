import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  preview: { realtime: { allowedOrigins: ["http://localhost:3000"] } },
  functions: {
    ingest: {
      name: "factory ingest",
      source: "functions/ingest/index.ts",
      env: { FACTORY_INGEST_SECRET: process.env.FACTORY_INGEST_SECRET! },
    },
  },
});
