
import { json } from "../_lib/session.js";

const encoder = new TextEncoder();
const DEFAULT_MESSAGE =
  "نعتذر عن الإزعاج، الموقع تحت الصيانة حالياً. سنعود قريباً.";

function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTelegram(initData, botToken, adminId) {
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return false;

    const authDate = Number(params.get("auth_date"));
    if (!Number.isFinite(authDate) ||
        Math.abs(Date.now() / 1000 - authDate) > 300) return false;

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

    const secret = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      secretKey,
      encoder.encode(botToken)
    ));

    const hmacKey = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const calculated = hex(new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      hmacKey,
      encoder.encode(dataCheckString)
    )));

    if (calculated !== receivedHash.toLowerCase()) return false;

    const user = JSON.parse(params.get("user") || "{}");
    return String(user.id || "") === String(adminId);
  } catch {
    return false;
  }
}

async function readSettings(env) {
  const result = await env.DB.prepare(
    "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN (?, ?)"
  ).bind("maintenance_enabled", "maintenance_message").all();

  const settings = {};
  for (const row of result.results || []) {
    settings[row.setting_key] = row.setting_value;
  }

  return {
    maintenance: settings.maintenance_enabled === "1",
    message: settings.maintenance_message || DEFAULT_MESSAGE
  };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({ success: false, error: "SERVER_CONFIG" }, 500);
    }

    const body = await request.json();
    const initData = String(body.initData || "");

    if (!initData || initData.length > 10000) {
      return json({ success: false, error: "INVALID_DATA" }, 400);
    }

    const authorized = await verifyTelegram(
      initData,
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_ADMIN_ID
    );

    if (!authorized) {
      return json({ success: false, error: "UNAUTHORIZED" }, 403);
    }

    if (body.action === "get") {
      return json({ success: true, ...(await readSettings(env)) });
    }

    if (body.action !== "save") {
      return json({ success: false, error: "INVALID_ACTION" }, 400);
    }

    if (typeof body.maintenance !== "boolean") {
      return json({ success: false, error: "INVALID_STATUS" }, 400);
    }

    const message = String(body.message || "").trim();

    if (!message || message.length > 1000) {
      return json({ success: false, error: "INVALID_MESSAGE" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO site_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at`
      ).bind("maintenance_enabled", body.maintenance ? "1" : "0", now),

      env.DB.prepare(
        `INSERT INTO site_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at`
      ).bind("maintenance_message", message, now)
    ]);

    return json({
      success: true,
      maintenance: body.maintenance,
      message
    });
  } catch (error) {
    console.error("Admin maintenance error:", error);
    return json({ success: false, error: "MAINTENANCE_FAILED" }, 500);
  }
}
