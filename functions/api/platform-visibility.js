import { json } from "./_lib/session.js";
import { authorizeAdmin, adminAuthResponse } from "./_lib/admin-auth.js";

const PLATFORMS = ["android", "ios", "beta"];

async function ensureTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS platform_visibility (
      platform TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )
  `).run();
}

async function readVisibility(env) {
  await ensureTable(env);
  const result = await env.DB.prepare(
    "SELECT platform, enabled FROM platform_visibility"
  ).all();
  const visibility = { android: true, ios: true, beta: true };
  for (const row of result.results || []) {
    if (PLATFORMS.includes(row.platform)) {
      visibility[row.platform] = Number(row.enabled) === 1;
    }
  }
  return visibility;
}

export async function onRequestGet({ env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_UNAVAILABLE" }, 500);
    return json({ success: true, visibility: await readVisibility(env) });
  } catch (error) {
    console.error("Platform visibility GET error:", error);
    return json({ success: false, error: "PLATFORM_VISIBILITY_UNAVAILABLE" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_UNAVAILABLE" }, 500);
    const body = await request.json();
    const platform = String(body.platform || "").toLowerCase();
    const enabled = body.enabled === true || Number(body.enabled) === 1 ? 1 : 0;
    if (!PLATFORMS.includes(platform)) {
      return json({ success: false, error: "INVALID_PLATFORM" }, 400);
    }
    const auth = await authorizeAdmin(String(body.initData || ""), env, platform);
    if (!auth.ok) return adminAuthResponse(auth);
    await ensureTable(env);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      INSERT INTO platform_visibility (platform, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(platform) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).bind(platform, enabled, now).run();
    return json({ success: true, platform, enabled: enabled === 1 });
  } catch (error) {
    console.error("Platform visibility POST error:", error);
    return json({ success: false, error: "PLATFORM_VISIBILITY_SAVE_FAILED" }, 500);
  }
}
