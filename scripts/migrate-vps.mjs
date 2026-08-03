import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: "oneui-firmware-worker-vps-migrate"
});
try {
  const sql = await readFile(new URL("../migrations/001_vps_runtime.sql", import.meta.url), "utf8");
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log("VPS database migration completed: 001_vps_runtime");
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
