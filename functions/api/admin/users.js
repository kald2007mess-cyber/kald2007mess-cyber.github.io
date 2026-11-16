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

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    }

    const body = await request.json();
    const auth = await authorizeAdmin(String(body.initData || ""), env, "users");
    if (!auth.ok) return adminAuthResponse(auth);

    const page = Math.max(1, Math.min(100000, Number.parseInt(body.page, 10) || 1));
    const limit = Math.max(1, Math.min(50, Number.parseInt(body.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const query = String(body.query || "").trim().slice(0, 80);

    let totalRow;
    let rows;
    if (query) {
      const pattern = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
      totalRow = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM users
        WHERE public_id LIKE ? ESCAPE '\\'
           OR user_uuid LIKE ? ESCAPE '\\'
      `).bind(pattern, pattern).first();

      rows = await env.DB.prepare(`
        SELECT user_uuid, public_id, points, status, created_at
        FROM users
        WHERE public_id LIKE ? ESCAPE '\\'
           OR user_uuid LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC, user_uuid DESC
        LIMIT ? OFFSET ?
      `).bind(pattern, pattern, limit, offset).all();
    } else {
      totalRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first();
      rows = await env.DB.prepare(`
        SELECT user_uuid, public_id, points, status, created_at
        FROM users
        ORDER BY created_at DESC, user_uuid DESC
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
        id: user.public_id,
        userId: user.user_uuid,
        points: Number(user.points || 0),
        progress: 0,
        status: user.status,
        createdAt: Number(user.created_at || 0)
      }))
    });
  } catch (error) {
    console.error("Admin users failed:", error);
    return json({ success: false, error: "USERS_LOAD_FAILED" }, 500);
  }
}
