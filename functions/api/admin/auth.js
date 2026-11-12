
import { json } from "../_lib/session.js";

const encoder = new TextEncoder();

function hex(bytes) {
  return [...bytes]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(key, data) {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, data)
  );
}

async function verifyTelegram(initData, botToken) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));

  if (
    !Number.isFinite(authDate) ||
    Math.abs(Date.now() / 1000 - authDate) > 300
  ) {
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const secret = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      secretKey,
      encoder.encode(botToken)
    )
  );

  const calculatedHash = hex(
    await hmac(secret, encoder.encode(dataCheckString))
  );

  if (calculatedHash !== receivedHash.toLowerCase()) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") || "{}");
    return String(user.id || "");
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({ success: false, error: "SERVER_CONFIG" }, 500);
    }

    const body = await request.json();
    const initData = String(body.initData || "");

    if (!initData || initData.length > 10000) {
      return json({ success: false, error: "INVALID_DATA" }, 400);
    }

    const userId = await verifyTelegram(
      initData,
      env.TELEGRAM_BOT_TOKEN
    );

    if (!userId || userId !== String(env.TELEGRAM_ADMIN_ID)) {
      return json({ success: false, error: "UNAUTHORIZED" }, 403);
    }

    return json({
      success: true,
      admin: true
    });

  } catch {
    return json({ success: false, error: "AUTH_FAILED" }, 500);
  }
}
