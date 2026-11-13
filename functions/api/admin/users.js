
import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

// OXIDE HUB - Admin users API

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function publicUserId(value) {
  const compact = String(value || "").replace(/-/g, "");
  return "OX-" + compact.slice(0, 8).toUpperCase();
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({
        success: false,
        error: "SERVER_CONFIGURATION_MISSING"
      }, 500);
    }

    const body = await request.json();

    const auth = await authorizeAdmin(
      String(body.initData || ""),
      env,
      "users"
    );

    if (!auth.ok) {
      return adminAuthResponse(auth);
    }

    const page = Math.max(
      1,
      Math.min(100000, Number.parseInt(body.page, 10) || 1)
    );

    const limit = Math.max(
      1,
      Math.min(50, Number.parseInt(body.limit, 10) || 20)
    );

    const offset = (page - 1) * limit;
    const query = String(body.query || "").trim().slice(0, 80);

    let totalRow;
    let rows;

    if (query) {
      const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;

      totalRow = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM visitors
        WHERE user_id LIKE ? ESCAPE '\\'
      `).bind(pattern).first();

      rows = await env.DB.prepare(`
        SELECT user_id, progress, points, created_at
        FROM visitors
        WHERE user_id LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC, user_id DESC
        LIMIT ? OFFSET ?
      `).bind(pattern, limit, offset).all();

    } else {
      totalRow = await env.DB.prepare(`
        SELECT COUNT(*) AS total FROM visitors
      `).first();

      rows = await env.DB.prepare(`
        SELECT user_id, progress, points, created_at
        FROM visitors
        ORDER BY created_at DESC, user_id DESC
        LIMIT ? OFFSET ?
      `).bind(limit, offset).all();
    }

    const total = Number(totalRow?.total || 0);

    return json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),

      users: (rows.results || []).map(user => ({
        id: publicUserId(user.user_id),
        points: Number(user.points || 0),
        progress: Number(user.progress || 0),
        createdAt: Number(user.created_at || 0)
      }))
    });

  } catch (error) {
    return json({
      success: false,
      error: "USERS_LOAD_FAILED"
    }, 500);
  }
}
