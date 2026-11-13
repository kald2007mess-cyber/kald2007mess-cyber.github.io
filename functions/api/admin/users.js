
// OXIDE HUB - Admin users API
// Path: functions/api/admin/users.js

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

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(message)
    )
  );
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function verifyAdmin(initData, env) {
  if (!initData || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
    return false;
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date") || 0);
  const userRaw = params.get("user");

  if (!receivedHash || !authDate || !userRaw) return false;

  const now = Math.floor(Date.now() / 1000);

  if (authDate > now + 60 || now - authDate > 86400) {
    return false;
  }

  let telegramUser;

  try {
    telegramUser = JSON.parse(userRaw);
  } catch {
    return false;
  }

  if (String(telegramUser.id) !== String(env.TELEGRAM_ADMIN_ID)) {
    return false;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmacSha256(
    new TextEncoder().encode("WebAppData"),
    env.TELEGRAM_BOT_TOKEN
  );

  const calculatedHash = toHex(
    await hmacSha256(secretKey, dataCheckString)
  );

  return safeEqual(calculatedHash, receivedHash.toLowerCase());
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

    const authorized = await verifyAdmin(
      String(body.initData || ""),
      env
    );

    if (!authorized) {
      return json({
        success: false,
        error: "UNAUTHORIZED"
      }, 403);
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
