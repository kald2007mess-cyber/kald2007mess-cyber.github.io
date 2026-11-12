
import { json } from "../_lib/session.js";

const encoder = new TextEncoder();

function hex(bytes) {
  return [...bytes]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyTelegram(initData, botToken, adminId) {
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
      return false;
    }

    const authDate = Number(params.get("auth_date"));

    if (
      !Number.isFinite(authDate) ||
      Math.abs(Date.now() / 1000 - authDate) > 300
    ) {
      return false;
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

    const hmacKey = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const calculated = hex(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          hmacKey,
          encoder.encode(dataCheckString)
        )
      )
    );

    if (calculated !== receivedHash.toLowerCase()) {
      return false;
    }

    const user = JSON.parse(params.get("user") || "{}");

    return String(user.id || "") === String(adminId);
  } catch {
    return false;
  }
}

async function authorize(request, env) {
  if (
    !env.DB ||
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_ADMIN_ID
  ) {
    return false;
  }

  const body = await request.clone().json();
  const initData = String(body.initData || "");

  if (!initData || initData.length > 10000) {
    return false;
  }

  return verifyTelegram(
    initData,
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_ADMIN_ID
  );
}

async function readDownloads(env) {
  const result = await env.DB.prepare(
    `SELECT platform, title, version, description,
            file_name, file_key, download_url,
            file_size, enabled, updated_at
     FROM platform_downloads
     ORDER BY platform`
  ).all();

  return result.results || [];
}

export async function onRequestPost({ request, env }) {
  try {
    const authorized = await authorize(request, env);

    if (!authorized) {
      return json({
        success: false,
        error: "UNAUTHORIZED"
      }, 403);
    }

    const body = await request.json();

    if (body.action === "get") {
      const downloads = await readDownloads(env);

      return json({
        success: true,
        downloads
      });
    }

    return json({
      success: false,
      error: "INVALID_ACTION"
    }, 400);

  } catch (error) {
    console.error("Admin downloads error:", error);

    return json({
      success: false,
      error: "DOWNLOADS_FAILED"
    }, 500);
  }
}
