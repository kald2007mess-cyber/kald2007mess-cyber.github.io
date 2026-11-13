const encoder = new TextEncoder();

const ALLOWED_PERMISSIONS = [
  "users",
  "news",
  "tasks",
  "android",
  "beta",
  "ios",
  "maintenance",
  "stats"
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

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  );
}

async function verifyOwner(initData, env) {
  if (!initData || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
    return false;
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) return false;

  params.delete("hash");

  const authDate = Number(params.get("auth_date"));

  if (
    !Number.isFinite(authDate) ||
    Math.abs(Date.now() / 1000 - authDate) > 86400
  ) {
    return false;
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmac(
    encoder.encode("WebAppData"),
    env.TELEGRAM_BOT_TOKEN
  );

  const calculatedHash = toHex(
    await hmac(secretKey, dataCheckString)
  );

  if (calculatedHash.length !== receivedHash.length) return false;

  let difference = 0;

  for (let i = 0; i < calculatedHash.length; i++) {
    difference |= calculatedHash.charCodeAt(i) ^ receivedHash.charCodeAt(i);
  }

  if (difference !== 0) return false;

  let user;

  try {
    user = JSON.parse(params.get("user") || "{}");
  } catch {
    return false;
  }

  return String(user.id) === String(env.TELEGRAM_ADMIN_ID);
}

function validTelegramId(value) {
  return /^\d{5,20}$/.test(String(value || ""));
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();

    // المالك فقط يستطيع الوصول إلى هذا API
    const owner = await verifyOwner(body.initData, env);

    if (!owner) {
      return json({ success: false, error: "UNAUTHORIZED" }, 403);
    }

    const action = String(body.action || "");

    if (action === "list") {
      const result = await env.DB.prepare(`
        SELECT telegram_id, added_by, active, created_at
        FROM oxide_admin_deputies
        ORDER BY created_at DESC
      `).all();

      const deputies = [];

      for (const deputy of result.results || []) {
        const permissions = await env.DB.prepare(`
          SELECT permission
          FROM oxide_admin_deputy_permissions
          WHERE telegram_id = ?
          ORDER BY permission
        `).bind(deputy.telegram_id).all();

        deputies.push({
          ...deputy,
          permissions: (permissions.results || []).map(x => x.permission)
        });
      }

      return json({
        success: true,
        deputies,
        availablePermissions: ALLOWED_PERMISSIONS
      });
    }

    if (action === "add") {
      const telegramId = String(body.telegram_id || "").trim();

      if (!validTelegramId(telegramId)) {
        return json({ success: false, error: "INVALID_TELEGRAM_ID" }, 400);
      }

      if (telegramId === String(env.TELEGRAM_ADMIN_ID)) {
        return json({ success: false, error: "OWNER_CANNOT_BE_DEPUTY" }, 400);
      }

      await env.DB.prepare(`
        INSERT INTO oxide_admin_deputies
          (telegram_id, added_by, active)
        VALUES (?, ?, 1)
      `).bind(telegramId, String(env.TELEGRAM_ADMIN_ID)).run();

      return json({ success: true, message: "DEPUTY_ADDED" });
    }

    if (action === "permissions") {
      const telegramId = String(body.telegram_id || "").trim();
      const permissions = body.permissions;

      if (!validTelegramId(telegramId)) {
        return json({ success: false, error: "INVALID_TELEGRAM_ID" }, 400);
      }

      if (telegramId === String(env.TELEGRAM_ADMIN_ID)) {
        return json({ success: false, error: "INVALID_TARGET" }, 400);
      }

      if (
        !Array.isArray(permissions) ||
        permissions.some(p => !ALLOWED_PERMISSIONS.includes(p)) ||
        new Set(permissions).size !== permissions.length
      ) {
        return json({ success: false, error: "INVALID_PERMISSIONS" }, 400);
      }

      const deputy = await env.DB.prepare(`
        SELECT telegram_id
        FROM oxide_admin_deputies
        WHERE telegram_id = ?
      `).bind(telegramId).first();

      if (!deputy) {
        return json({ success: false, error: "DEPUTY_NOT_FOUND" }, 404);
      }

      const statements = [
        env.DB.prepare(`
          DELETE FROM oxide_admin_deputy_permissions
          WHERE telegram_id = ?
        `).bind(telegramId)
      ];

      for (const permission of permissions) {
        statements.push(
          env.DB.prepare(`
            INSERT INTO oxide_admin_deputy_permissions
              (telegram_id, permission)
            VALUES (?, ?)
          `).bind(telegramId, permission)
        );
      }

      await env.DB.batch(statements);

      return json({ success: true, message: "PERMISSIONS_UPDATED" });
    }

    if (action === "toggle") {
      const telegramId = String(body.telegram_id || "").trim();
      const active = Number(body.active);

      if (!validTelegramId(telegramId) || ![0, 1].includes(active)) {
        return json({ success: false, error: "INVALID_DATA" }, 400);
      }

      if (telegramId === String(env.TELEGRAM_ADMIN_ID)) {
        return json({ success: false, error: "INVALID_TARGET" }, 400);
      }

      const result = await env.DB.prepare(`
        UPDATE oxide_admin_deputies
        SET active = ?
        WHERE telegram_id = ?
      `).bind(active, telegramId).run();

      if (!result.meta?.changes) {
        return json({ success: false, error: "DEPUTY_NOT_FOUND" }, 404);
      }

      return json({ success: true, message: "DEPUTY_STATUS_UPDATED" });
    }

    if (action === "delete") {
      const telegramId = String(body.telegram_id || "").trim();

      if (!validTelegramId(telegramId)) {
        return json({ success: false, error: "INVALID_TELEGRAM_ID" }, 400);
      }

      if (telegramId === String(env.TELEGRAM_ADMIN_ID)) {
        return json({ success: false, error: "OWNER_CANNOT_BE_DELETED" }, 400);
      }

      await env.DB.batch([
        env.DB.prepare(`
          DELETE FROM oxide_admin_deputy_permissions
          WHERE telegram_id = ?
        `).bind(telegramId),

        env.DB.prepare(`
          DELETE FROM oxide_admin_deputies
          WHERE telegram_id = ?
        `).bind(telegramId)
      ]);

      return json({ success: true, message: "DEPUTY_DELETED" });
    }

    return json({ success: false, error: "UNKNOWN_ACTION" }, 400);

  } catch (error) {
    return json({
      success: false,
      error: "SERVER_ERROR"
    }, 500);
  }
}
