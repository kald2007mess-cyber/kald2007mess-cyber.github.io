import { getVisitor, json } from "./_lib/session.js";

const LANGUAGES = ["ar", "en", "fr", "es", "de"];

async function ensurePreferencesTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_uuid TEXT PRIMARY KEY,
      language TEXT NOT NULL DEFAULT 'ar',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_uuid) REFERENCES users(user_uuid)
    )
  `).run();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "USER_NOT_FOUND" }, 401);

    await ensurePreferencesTable(env.DB);
    const user = await env.DB.prepare(`
      SELECT user_uuid FROM users WHERE user_uuid = ? AND status = 'active'
    `).bind(userUuid).first();
    if (!user) return json({ success: false, error: "USER_NOT_AVAILABLE" }, 404);

    const row = await env.DB.prepare(`
      SELECT language FROM user_preferences WHERE user_uuid = ?
    `).bind(userUuid).first();

    const language = LANGUAGES.includes(row?.language) ? row.language : "ar";
    return json({ success: true, language });
  } catch (error) {
    console.error("Preferences GET failed:", error);
    return json({ success: false, error: "PREFERENCES_LOAD_FAILED" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "USER_NOT_FOUND" }, 401);

    const body = await request.json();
    const language = String(body.language || "").trim();
    if (!LANGUAGES.includes(language)) {
      return json({ success: false, error: "INVALID_LANGUAGE" }, 400);
    }

    await ensurePreferencesTable(env.DB);
    const user = await env.DB.prepare(`
      SELECT user_uuid FROM users WHERE user_uuid = ? AND status = 'active'
    `).bind(userUuid).first();
    if (!user) return json({ success: false, error: "USER_NOT_AVAILABLE" }, 404);

    await env.DB.prepare(`
      INSERT INTO user_preferences (user_uuid, language, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_uuid) DO UPDATE SET
        language = excluded.language,
        updated_at = excluded.updated_at
    `).bind(userUuid, language, Math.floor(Date.now() / 1000)).run();

    return json({ success: true, language });
  } catch (error) {
    console.error("Preferences POST failed:", error);
    return json({ success: false, error: "PREFERENCES_SAVE_FAILED" }, 500);
  }
}
