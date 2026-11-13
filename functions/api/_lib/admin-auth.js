
const encoder = new TextEncoder();

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message))
  );
}

function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function authorizeAdmin(request, env, permission = null) {
  const body = await request.clone().json().catch(() => ({}));
  const initData = body.initData;

  if (!initData || !env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, status: 401, error: "UNAUTHORIZED" };
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  params.delete("hash");

  if (!receivedHash) {
    return { ok: false, status: 401, error: "INVALID_AUTH" };
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmac(
    encoder.encode("WebAppData"),
    env.TELEGRAM_BOT_TOKEN
  );

  const calculatedHash = hex(await hmac(secretKey, dataCheckString));

  if (calculatedHash !== receivedHash.toLowerCase()) {
    return { ok: false, status: 401, error: "INVALID_AUTH" };
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "{}");
  } catch {
    return { ok: false, status: 401, error: "INVALID_USER" };
  }

  const telegramId = String(user.id || "");

  if (telegramId === String(env.TELEGRAM_ADMIN_ID)) {
    return { ok: true, owner: true, telegramId };
  }

  if (!permission || permission === "security") {
    return { ok: false, status: 403, error: "FORBIDDEN" };
  }

  const deputy = await env.DB.prepare(
    "SELECT active FROM oxide_admin_deputies WHERE telegram_id = ?"
  ).bind(telegramId).first();

  if (!deputy || Number(deputy.active) !== 1) {
    return { ok: false, status: 403, error: "FORBIDDEN" };
  }

  const allowed = await env.DB.prepare(
    "SELECT 1 FROM oxide_admin_deputy_permissions WHERE telegram_id = ? AND permission = ?"
  ).bind(telegramId, permission).first();

  if (!allowed) {
    return { ok: false, status: 403, error: "FORBIDDEN" };
  }

  return { ok: true, owner: false, telegramId };
}
