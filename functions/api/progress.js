
import {
  getVisitor,
  json,
  createVisitorCookie
} from "./_lib/session.js";

const CYCLE_SECONDS = 1800;

async function notifyTelegram(env, message) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) return;

    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_ADMIN_ID,
          text: message
        })
      }
    );
  } catch {}
}

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

    const inserted = await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
      (user_id, progress, cycle_started_at, created_at)
      VALUES (?, 0, ?, ?)
    `).bind(userId, now, now).run();

    if (inserted.meta?.changes > 0) {
      await notifyTelegram(
        env,
        "🆕 New OXIDE HUB visitor!\nVisitor ID: " + userId
      );
    }

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

    if (now - startedAt >= CYCLE_SECONDS) {
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

  } catch {
    return json({ error: "Could not load progress" }, 500);
  }
}
