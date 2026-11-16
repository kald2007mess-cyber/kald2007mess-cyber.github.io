import {
  getVisitor,
  json,
  createVisitorCookie,
  createVisitorCookieForId
} from "./_lib/session.js";

function shortId(id) {
  return "OX-" + String(id).replace(/-/g, "").slice(0, 8).toUpperCase();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    let userUuid = await getVisitor(request, env);
    let cookie = null;
    if (!userUuid) {
      cookie = await createVisitorCookie(env);
      const match = cookie.match(/^oxide_visitor=([^;]+)/);
      if (!match) return json({ error: "SESSION_CREATE_FAILED" }, 500);
      userUuid = decodeURIComponent(match[1]).split(".")[0];
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO users
        (user_uuid, public_id, legacy_user_id, points, status, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'active', ?, ?)
    `).bind(userUuid, shortId(userUuid), userUuid, now, now).run();

    const user = await env.DB.prepare(`
      SELECT status FROM users WHERE user_uuid = ? LIMIT 1
    `).bind(userUuid).first();

    if (!user || user.status !== "active") {
      return json({ error: "USER_NOT_AVAILABLE" }, 403);
    }

    const response = json({ progress: 0, required: 3, unlocked: false });
    const headers = new Headers(response.headers);
    if (cookie) headers.set("Set-Cookie", cookie);
    else headers.set("Set-Cookie", await createVisitorCookieForId(env, userUuid));

    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    console.error("Progress load failed:", error);
    return json({ error: "PROGRESS_LOAD_FAILED" }, 500);
  }
}
