export async function ensureMissionColumns(DB) {
  const result = await DB.prepare("PRAGMA table_info(missions)").all();
  const columns = new Set((result.results || []).map(column => String(column.name)));

  if (!columns.has("target_url")) {
    await DB.prepare("ALTER TABLE missions ADD COLUMN target_url TEXT NOT NULL DEFAULT ''").run();
  }
  if (!columns.has("sort_order")) {
    await DB.prepare("ALTER TABLE missions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0").run();
  }
}
