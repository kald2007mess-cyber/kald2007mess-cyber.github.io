
// OXIDE HUB - Shared admin/deputy authorization

const encoder = new TextEncoder();

const ALLOWED_PERMISSIONS = new Set([
  "users",
  "news",
  "tasks",
  "android",
  "beta",
  "ios",
  "maintenance",
  "stats"
]);

function toHex(bytes) {
  return Array.from(bytes, byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
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
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(message)
    )
  );
}

function safeEqual(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    a.length !== b.length
  ) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return difference === 0;
}

async function getTelegramUserId(initData, env) {
  if (
    typeof initData !== "string" ||
    !initData ||
    initData.length > 10000 ||
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_ADMIN_ID
  ) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    const authDate = Number(params.get("auth_date"));
    const userText = params.get("user");

    if (
      !receivedHash ||
      !/^[a-f0-9]{64}$/i.test(receivedHash) ||
      !authDate ||
      !userText
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);

    if (authDate > now + 60 || now - authDate > 86400) {
      return null;
    }

    let user;

    try {
      user = JSON.parse(userText);
    } catch {
      return null;
    }

    if (!user || !/^\d{5,20}$/.test(String(user.id || ""))) {
      return null;
    }

    params.delete("hash");

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

    if (!safeEqual(calculatedHash, receivedHash.toLowerCase())) {
      return null;
    }

    return String(user.id);
  } catch {
    return null;
  }
}

export async function authorizeAdmin(
  initData,
  env,
  requiredPermission = null
) {
  if (
    !env.DB ||
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_ADMIN_ID
  ) {
    return {
      ok: false,
      status: 500,
      error: "SERVER_CONFIG"
    };
  }

  const telegramId = await getTelegramUserId(initData, env);

  if (!telegramId) {
    return {
      ok: false,
      status: 403,
      error: "UNAUTHORIZED"
    };
  }

  const ownerId = String(env.TELEGRAM_ADMIN_ID);

  // Owner has full access.
  if (telegramId === ownerId) {
    return {
      ok: true,
      owner: true,
      telegramId,
      permissions: [
        "users",
        "news",
        "tasks",
        "android",
        "beta",
        "ios",
        "maintenance",
        "stats",
        "security"
      ]
    };
  }

  // Security management is owner-only.
  if (requiredPermission === "security") {
    return {
      ok: false,
      status: 403,
      error: "OWNER_ONLY"
    };
  }

  let deputy;

  try {
    deputy = await env.DB.prepare(`
      SELECT telegram_id, active
      FROM oxide_admin_deputies
      WHERE telegram_id = ?
      LIMIT 1
    `).bind(telegramId).first();
  } catch {
    return {
      ok: false,
      status: 500,
      error: "DEPUTY_LOOKUP_FAILED"
    };
  }

  if (!deputy || Number(deputy.active) !== 1) {
    return {
      ok: false,
      status: 403,
      error: "DEPUTY_INACTIVE_OR_NOT_FOUND"
    };
  }

  let permissions = [];

  try {
    const result = await env.DB.prepare(`
      SELECT permission
      FROM oxide_admin_deputy_permissions
      WHERE telegram_id = ?
      ORDER BY permission
    `).bind(telegramId).all();

    permissions = (result.results || [])
      .map(row => String(row.permission || ""))
      .filter(permission =>
        ALLOWED_PERMISSIONS.has(permission)
      );
  } catch {
    return {
      ok: false,
      status: 500,
      error: "PERMISSIONS_LOOKUP_FAILED"
    };
  }

  if (
    requiredPermission &&
    !permissions.includes(requiredPermission)
  ) {
    return {
      ok: false,
      status: 403,
      error: "PERMISSION_DENIED"
    };
  }

  return {
    ok: true,
    owner: false,
    telegramId,
    permissions
  };
}

export function adminAuthResponse(auth) {
  return new Response(
    JSON.stringify({
      success: false,
      error: auth?.error || "UNAUTHORIZED"
    }),
    {
      status: auth?.status || 403,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
