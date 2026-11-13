
import { json } from "../_lib/session.js";

const encoder = new TextEncoder();

const PLATFORMS = ["android", "ios", "beta"];
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const R2_PUBLIC_URL =
  "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";

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

async function authorize(initData, env) {
  if (
    !env.DB ||
    !env.DOWNLOADS_BUCKET ||
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_ADMIN_ID
  ) {
    throw new Error("SERVER_CONFIG");
  }

  if (!initData || initData.length > 10000) {
    return false;
  }

  return verifyTelegram(
    initData,
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_ADMIN_ID
  );
}

function validPlatform(platform) {
  return PLATFORMS.includes(platform);
}

async function getDownloads(env) {
  const result = await env.DB.prepare(
    `SELECT platform, title, version, description,
            file_name, file_key, download_url,
            file_size, enabled, updated_at
     FROM platform_downloads
     ORDER BY platform`
  ).all();

  return result.results || [];
}

async function savePlatform(env, data) {
  const platform = String(data.platform || "");

  if (!validPlatform(platform)) {
    throw new Error("INVALID_PLATFORM");
  }

  const current = await env.DB.prepare(
    "SELECT * FROM platform_downloads WHERE platform = ?"
  ).bind(platform).first();

  if (!current) {
    throw new Error("PLATFORM_NOT_FOUND");
  }

  const title = String(data.title ?? current.title).trim();
  const version = String(data.version ?? current.version).trim();
  const description = String(
    data.description ?? current.description
  ).trim();

  const downloadUrl = String(
    data.download_url ?? current.download_url
  ).trim();

  const enabled =
    data.enabled === undefined
      ? Number(current.enabled)
      : data.enabled === true ? 1 : 0;

  if (!title || title.length > 150) {
    throw new Error("INVALID_TITLE");
  }

  if (version.length > 50 || description.length > 1000) {
    throw new Error("INVALID_DETAILS");
  }

  if (downloadUrl && !/^https:\/\/[^\s]+$/i.test(downloadUrl)) {
    throw new Error("INVALID_URL");
  }

  if (platform === "ios" && enabled === 1 && !downloadUrl) {
    throw new Error("IOS_URL_REQUIRED");
  }

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `UPDATE platform_downloads
     SET title = ?,
         version = ?,
         description = ?,
         download_url = ?,
         enabled = ?,
         updated_at = ?
     WHERE platform = ?`
  ).bind(
    title,
    version,
    description,
    downloadUrl,
    enabled,
    now,
    platform
  ).run();

  return {
    success: true,
    platform,
    title,
    version,
    description,
    download_url: downloadUrl,
    enabled,
    updated_at: now
  };
}

function safeFileName(name) {
  const cleaned = String(name || "download.apk")
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-120);

  return cleaned || "download.apk";
}

async function uploadFile(env, form) {
  const platform = String(form.get("platform") || "");

  if (!["android", "beta"].includes(platform)) {
    throw new Error("INVALID_UPLOAD_PLATFORM");
  }

  const file = form.get("file");

  if (!file || typeof file.size !== "number" || file.size <= 0) {
    throw new Error("FILE_REQUIRED");
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error("FILE_TOO_LARGE");
  }

  const fileName = safeFileName(file.name);

  if (!fileName.toLowerCase().endsWith(".apk")) {
    throw new Error("APK_ONLY");
  }

  const current = await env.DB.prepare(
    "SELECT * FROM platform_downloads WHERE platform = ?"
  ).bind(platform).first();

  if (!current) {
    throw new Error("PLATFORM_NOT_FOUND");
  }

  const key =
    `${platform}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;

  const title = String(
    form.get("title") ?? current.title
  ).trim();

  const version = String(
    form.get("version") ?? current.version
  ).trim();

  const description = String(
    form.get("description") ?? current.description
  ).trim();

  if (!title || title.length > 150) {
    throw new Error("INVALID_TITLE");
  }

  if (version.length > 50 || description.length > 1000) {
    throw new Error("INVALID_DETAILS");
  }

  await env.DOWNLOADS_BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType: "application/vnd.android.package-archive",
      contentDisposition: `attachment; filename="${fileName}"`
    }
  });

  const downloadUrl = `${R2_PUBLIC_URL}/${key}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(
      `UPDATE platform_downloads
       SET title = ?,
           version = ?,
           description = ?,
           file_name = ?,
           file_key = ?,
           download_url = ?,
           file_size = ?,
           enabled = 1,
           updated_at = ?
       WHERE platform = ?`
    ).bind(
      title,
      version,
      description,
      fileName,
      key,
      downloadUrl,
      file.size,
      now,
      platform
    ).run();
  } catch (error) {
    await env.DOWNLOADS_BUCKET.delete(key);
    throw error;
  }

  return {
    success: true,
    platform,
    file_name: fileName,
    file_key: key,
    download_url: downloadUrl,
    file_size: file.size,
    version,
    enabled: true
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const contentType = request.headers.get("Content-Type") || "";

    let body;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();

      const authorized = await authorize(
        String(form.get("initData") || ""),
        env
      );

      if (!authorized) {
        return json({
          success: false,
          error: "UNAUTHORIZED"
        }, 403);
      }

      const action = String(form.get("action") || "");

      if (action !== "upload") {
        return json({
          success: false,
          error: "INVALID_ACTION"
        }, 400);
      }

      return json(await uploadFile(env, form));
    }

    body = await request.json();

    const authorized = await authorize(
      String(body.initData || ""),
      env
    );

    if (!authorized) {
      return json({
        success: false,
        error: "UNAUTHORIZED"
      }, 403);
    }

    if (body.action === "get") {
      return json({
        success: true,
        downloads: await getDownloads(env)
      });
    }

    if (body.action === "save") {
      return json(
        await savePlatform(env, body)
      );
    }

    return json({
      success: false,
      error: "INVALID_ACTION"
    }, 400);

  } catch (error) {
    console.error("Admin downloads error:", error);

    const messages = {
      SERVER_CONFIG: "SERVER_CONFIG",
      INVALID_PLATFORM: "INVALID_PLATFORM",
      PLATFORM_NOT_FOUND: "PLATFORM_NOT_FOUND",
      INVALID_TITLE: "INVALID_TITLE",
      INVALID_DETAILS: "INVALID_DETAILS",
      INVALID_URL: "INVALID_URL",
      IOS_URL_REQUIRED: "IOS_URL_REQUIRED",
      INVALID_UPLOAD_PLATFORM: "INVALID_UPLOAD_PLATFORM",
      FILE_REQUIRED: "FILE_REQUIRED",
      FILE_TOO_LARGE: "FILE_TOO_LARGE",
      APK_ONLY: "APK_ONLY"
    };

    const message = messages[error.message] || "DOWNLOADS_FAILED";

    return json({
      success: false,
      error: message
    }, error.message === "SERVER_CONFIG" ? 500 : 400);
  }
}
