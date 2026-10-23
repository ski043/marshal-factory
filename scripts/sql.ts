import { Client } from "pg";

process.loadEnvFile(".env.local");

const client = new Client({
  connectionString: process.env.DATABASE_URL_UNPOOLED!.replace(
    "sslmode=require",
    "sslmode=verify-full",
  ),
});
await client.connect();
try {
  const result = await client.query(process.argv[2]!);
  console.table(result.rows);
} finally {
  await client.end();
}
