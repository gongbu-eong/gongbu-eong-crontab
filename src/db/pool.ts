import { Pool } from "pg";

import { env } from "../config";

export const pool = new Pool({
  connectionString: env.databaseUrl,
  application_name: "gongbu-eong-alio-cron",
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

export async function closePool(): Promise<void> {
  await pool.end();
}
