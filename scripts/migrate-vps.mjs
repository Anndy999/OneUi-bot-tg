import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: "oneui-firmware-worker-vps-migrate"
});
try {
  const client = await pool.connect();
  try {
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const files = (await readdir(directory))
      .filter((file) => /^\d+_.+\.sql$/i.test(file))
      .sort();
    for (const file of files) {
      await client.query(await readFile(join(directory, file), "utf8"));
      console.log(`VPS database migration completed: ${file}`);
    }
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
