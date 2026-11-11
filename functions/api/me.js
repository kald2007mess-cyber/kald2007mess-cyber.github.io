
import {
  getVisitor,
  createVisitorCookie,
  json
} from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    let userId = await getVisitor(request, env);
    let cookie = null;

    if (!userId) {
      cookie = await createVisitorCookie(env);
      const match = cookie.match(/^oxide_visitor=([^;]+)/);

      if (!match) {
        return json({ error: "Could not create visitor session" }, 500);
      }

      userId = decodeURIComponent(match[1]).split(".")[0];
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
      (user_id, progress, cycle_started_at, created_at)
      VALUES (?, 0, ?, ?)
    `).bind(userId, now, now).run();

    const row = await env.DB.prepare(`
      SELECT user_id, points
      FROM visitors
      WHERE user_id = ?
    `).bind(userId).first();

    if (!row) {
      return json({ error: "Visitor not found" }, 500);
    }

    const shortId = "OX-" + userId.replace(/-/g, "").slice(0, 8).toUpperCase();

    const response = json({
      success: true,
      userId: row.user_id,
      displayId: shortId,
      points: Number(row.points || 0)
    });

    if (cookie) {
      const headers = new Headers(response.headers);
      headers.set("Set-Cookie", cookie);

      return new Response(response.body, {
        status: response.status,
        headers
      });
    }

    return response;

  } catch (error) {
    return json({ error: "Could not load user profile" }, 500);
  }
}
