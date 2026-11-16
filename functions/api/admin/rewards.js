import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function publicPrefix(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^OX-/, "")
    .replace(/[^A-F0-9]/g, "")
    .slice(0, 8);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);

    const body = await request.json();
    const auth = await authorizeAdmin(String(body.initData || ""), env, "users");
    if (!auth.ok) return adminAuthResponse(auth);

    const points = Number(body.points);
    const title = String(body.title || "🎁 مكافأة جديدة").trim().slice(0, 120);
    const message = String(body.message || "لديك مكافأة جديدة جاهزة للاستلام.").trim().slice(0, 500);
    const target = String(body.target || "all").trim();

    if (!Number.isSafeInteger(points) || points < 1 || points > 1000000) {
      return json({ success: false, error: "INVALID_REWARD_POINTS" }, 400);
    }
    if (!title) return json({ success: false, error: "INVALID_TITLE" }, 400);

    const now = Math.floor(Date.now() / 1000);
    if (target === "all") {
      const result = await env.DB.prepare(`
        INSERT INTO notifications
          (user_uuid, type, title, body, reward_points, created_at)
        SELECT user_uuid, 'reward', ?, ?, ?, ?
        FROM users
        WHERE status = 'active'
      `).bind(title, message, points, now).run();

      return json({ success: true, sent: Number(result.meta?.changes || 0), target: "all" });
    }

    const prefix = publicPrefix(target);
    if (prefix.length !== 8) return json({ success: false, error: "INVALID_USER_ID" }, 400);

    const matches = await env.DB.prepare(`
      SELECT user_uuid
      FROM users
      WHERE UPPER(SUBSTR(REPLACE(public_id, '-', ''), 1, 8)) = ?
        AND status = 'active'
      LIMIT 2
    `).bind(prefix).all();

    if (!matches.results || matches.results.length !== 1) {
      return json({
        success: false,
        error: matches.results?.length ? "USER_ID_AMBIGUOUS" : "USER_NOT_FOUND"
      }, 404);
    }

    await env.DB.prepare(`
      INSERT INTO notifications
        (user_uuid, type, title, body, reward_points, created_at)
      VALUES (?, 'reward', ?, ?, ?, ?)
    `).bind(matches.results[0].user_uuid, title, message, points, now).run();

    return json({ success: true, sent: 1, target: "user" });
  } catch (error) {
    console.error("Admin reward send failed:", error);
    return json({ success: false, error: "ADMIN_REWARD_SEND_FAILED" }, 500);
  }
}
