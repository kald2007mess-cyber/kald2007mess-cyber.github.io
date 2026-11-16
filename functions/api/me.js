import {
  getVisitor,
  createVisitorCookie,
  createVisitorCookieForId,
  json
} from "./_lib/session.js";

function publicId(userId) {
  return "OX-" + String(userId).replace(/-/g, "").slice(0, 8).toUpperCase();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    let userId = await getVisitor(request, env);
    let cookie = null;

    if (!userId) {
      cookie = await createVisitorCookie(env);
      const match = cookie.match(/^oxide_visitor=([^;]+)/);
      if (!match) return json({ error: "COULD_NOT_CREATE_SESSION" }, 500);
      userId = decodeURIComponent(match[1]).split(".")[0];
    }

    const now = Math.floor(Date.now() / 1000);
    const displayId = publicId(userId);

    // The signed visitor UUID is retained as the stable user UUID.
    // No legacy points or balances are overwritten.
    await env.DB.prepare(`
      INSERT OR IGNORE INTO users
        (user_uuid, public_id, legacy_user_id, points, status, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'active', ?, ?)
    `).bind(userId, displayId, userId, now, now).run();

    const row = await env.DB.prepare(`
      SELECT user_uuid, public_id, points, status
      FROM users
      WHERE user_uuid = ?
      LIMIT 1
    `).bind(userId).first();

    if (!row || row.status !== "active") {
      return json({ error: "USER_NOT_AVAILABLE" }, 403);
    }

    cookie = await createVisitorCookieForId(env, row.user_uuid);
    const response = json({
      success: true,
      userId: row.user_uuid,
      displayId: row.public_id,
      points: Number(row.points || 0)
    });

    const headers = new Headers(response.headers);
    headers.set("Set-Cookie", cookie);
    return new Response(response.body, {
      status: response.status,
      headers
    });
  } catch (error) {
    return json({ error: "COULD_NOT_LOAD_USER_PROFILE" }, 500);
  }
}
