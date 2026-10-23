import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const globalForPool = globalThis as unknown as { __pgPool?: Pool };

function createPool() {
  const pool = new Pool({
    // Neon URLs say sslmode=require; verify-full keeps today's checks and skips pg's warning.
    connectionString: process.env.DATABASE_URL!.replace(
      "sslmode=require",
      "sslmode=verify-full",
    ),
    max: 5,
  });
  pool.on("error", (error) => console.error(error));
  return pool;
}

// Reused across dev hot reloads so each reload doesn't leak a pool.
const pool = (globalForPool.__pgPool ??= createPool());

export const db = drizzle(pool, { schema });
