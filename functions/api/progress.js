
import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({
        progress: 0,
        required: 3,
        unlocked: false
      });
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
      (user_id, progress, cycle_started_at)
      VALUES (?, 0, ?)
    `).bind(userId, now).run();

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

    return json({
      progress,
      required: 3,
      unlocked: progress >= 3
    });

  } catch (error) {
    return json({ error: "Could not load progress" }, 500);
  }
}
