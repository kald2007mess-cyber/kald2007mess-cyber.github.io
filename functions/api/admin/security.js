import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

const ALLOWED_PERMISSIONS = [
  "users", "news", "tasks", "android", "beta", "ios", "maintenance", "stats"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function validTelegramId(value) {
  return /^\d{5,20}$/.test(String(value || ""));
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const auth = await authorizeAdmin(String(body.initData || ""), env, "security");
    if (!auth.ok) return adminAuthResponse(auth);
    const action = String(body.action || "");

    if (action === "list") {
      const rows = await env.DB.prepare(`
        SELECT telegram_user_id, permission, active, created_at
        FROM admin_permissions
        ORDER BY telegram_user_id, permission
      `).all();

      const grouped = new Map();
      for (const row of rows.results || []) {
        const id = String(row.telegram_user_id);
        if (!grouped.has(id)) {
          grouped.set(id, {
            telegram_id: id,
            added_by: String(env.TELEGRAM_ADMIN_ID),
            active: Number(row.active) === 1 ? 1 : 0,
            created_at: Number(row.created_at || 0),
            permissions: []
          });
        }
        if (ALLOWED_PERMISSIONS.includes(row.permission)) {
          grouped.get(id).permissions.push(row.permission);
        }
        if (Number(row.active) !== 1) grouped.get(id).active = 0;
      }

      return json({
        success: true,
        deputies: [...grouped.values()],
        availablePermissions: ALLOWED_PERMISSIONS
      });
    }

    const telegramId = String(body.telegram_id || "").trim();
    if (action !== "list" && !validTelegramId(telegramId)) {
      return json({ success: false, error: "INVALID_TELEGRAM_ID" }, 400);
    }
    if (telegramId === String(env.TELEGRAM_ADMIN_ID)) {
      return json({ success: false, error: "INVALID_TARGET" }, 400);
    }

    if (action === "add") {
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(`
        INSERT OR IGNORE INTO admin_permissions
          (telegram_user_id, permission, active, created_at)
        VALUES (?, 'pending', 0, ?)
      `).bind(telegramId, now).run();
      return json({ success: true, message: "DEPUTY_ADDED" });
    }

    if (action === "permissions") {
      const permissions = body.permissions;
      if (
        !Array.isArray(permissions) ||
        permissions.some(p => !ALLOWED_PERMISSIONS.includes(p)) ||
        new Set(permissions).size !== permissions.length
      ) {
        return json({ success: false, error: "INVALID_PERMISSIONS" }, 400);
      }

      const statements = [
        env.DB.prepare("DELETE FROM admin_permissions WHERE telegram_user_id = ?")
          .bind(telegramId)
      ];
      const now = Math.floor(Date.now() / 1000);

      if (permissions.length === 0) {
        statements.push(env.DB.prepare(`
          INSERT INTO admin_permissions
            (telegram_user_id, permission, active, created_at)
          VALUES (?, 'pending', 0, ?)
        `).bind(telegramId, now));
      } else {
        for (const permission of permissions) {
          statements.push(env.DB.prepare(`
            INSERT INTO admin_permissions
              (telegram_user_id, permission, active, created_at)
            VALUES (?, ?, 1, ?)
          `).bind(telegramId, permission, now));
        }
      }

      await env.DB.batch(statements);
      return json({ success: true, message: "PERMISSIONS_UPDATED" });
    }

    if (action === "toggle") {
      const active = Number(body.active);
      if (![0, 1].includes(active)) return json({ success: false, error: "INVALID_DATA" }, 400);

      const result = await env.DB.prepare(`
        UPDATE admin_permissions SET active = ?
        WHERE telegram_user_id = ?
      `).bind(active, telegramId).run();

      if (Number(result.meta?.changes || 0) === 0) {
        return json({ success: false, error: "DEPUTY_NOT_FOUND" }, 404);
      }
      return json({ success: true, message: "DEPUTY_STATUS_UPDATED" });
    }

    if (action === "delete") {
      await env.DB.prepare("DELETE FROM admin_permissions WHERE telegram_user_id = ?")
        .bind(telegramId).run();
      return json({ success: true, message: "DEPUTY_DELETED" });
    }

    return json({ success: false, error: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    console.error("Admin security failed:", error);
    return json({ success: false, error: "SERVER_ERROR" }, 500);
  }
}
