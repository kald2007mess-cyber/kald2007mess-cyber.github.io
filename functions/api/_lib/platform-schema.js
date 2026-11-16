export async function ensurePlatformTables(DB) {
  await DB.batch([
    DB.prepare(`
      CREATE TABLE IF NOT EXISTS platform_files (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        slot INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL DEFAULT '',
        file_key TEXT NOT NULL DEFAULT '',
        download_url TEXT NOT NULL DEFAULT '',
        file_size INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `),
    DB.prepare(`
      CREATE TABLE IF NOT EXISTS platform_downloads (
        platform TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL DEFAULT '',
        file_key TEXT NOT NULL DEFAULT '',
        download_url TEXT NOT NULL DEFAULT '',
        file_size INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      )
    `),
    DB.prepare(`
      CREATE TABLE IF NOT EXISTS platform_file_downloads (
        file_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        downloaded_at INTEGER NOT NULL,
        PRIMARY KEY (file_id, user_id)
      )
    `),
    DB.prepare(`
      CREATE TABLE IF NOT EXISTS platform_tutorials (
        platform TEXT PRIMARY KEY,
        video_url TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      )
    `),
    DB.prepare(`
      CREATE TABLE IF NOT EXISTS upload_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        upload_id TEXT NOT NULL,
        object_key TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        admin_id TEXT NOT NULL
      )
    `),
    DB.prepare(`
      CREATE TABLE IF NOT EXISTS upload_parts (
        session_id TEXT NOT NULL,
        part_number INTEGER NOT NULL,
        etag TEXT NOT NULL,
        PRIMARY KEY (session_id, part_number)
      )
    `)
  ]);
}
