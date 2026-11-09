
import {
  getVisitor,
  json,
  createVisitorCookie
} from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    let userId = await getVisitor(request, env);
    let cookie = null;

    // Create visitor session on first visit
    if (!userId) {
      cookie = await createVisitorCookie(env);
      const match = cookie.match(/^oxide_visitor=([^;]+)/);

      if (!match) {
        return json({ error: "Could not create visitor session" }, 500);
      }

      userId = decodeURIComponent(match[1]).split(".")[0];
    }

    const now = Math.floor(Date.now() / 1000);

    // Register visitor and save first recorded date
    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
      (user_id, progress, cycle_started_at, created_at)
      VALUES (?, 0, ?, ?)
    `).bind(userId, now, now).run();

    // Fill date for existing visitors that do not have one
    await env.DB.prepare(`
      UPDATE visitors
      SET created_at = ?
      WHERE user_id = ?
      AND created_at IS NULL
    `).bind(now, userId).run();

    let row = await env.DB.prepare(`
      SELECT progress, cycle_started_at
      FROM visitors
      WHERE user_id = ?
    `).bind(userId).first();

    let startedAt = Number(row?.cycle_started_at) || 0;

    if (!startedAt) {
      await env.DB.prepare(`
        UPDATE visitors
        SET cycle_started_at = ?
        WHERE user_id = ?
      `).bind(now, userId).run();

      startedAt = now;
    }

    // Reset progress every 2 hours
    if (now - startedAt >= 7200) {
      await env.DB.prepare(`
        UPDATE visitors
        SET progress = 0,
            cycle_started_at = ?
        WHERE user_id = ?
      `).bind(now, userId).run();

      row = { progress: 0 };
    }

    const progress = Math.max(
      0,
      Math.min(3, Number(row?.progress || 0))
    );

    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    };

    if (cookie) {
      headers["Set-Cookie"] = cookie;
    }

    return new Response(JSON.stringify({
      progress,
      required: 3,
      unlocked: progress >= 3
    }), {
      status: 200,
      headers
    });

  } catch (error) {
    return json({ error: "Could not load progress" }, 500);
  }
}
