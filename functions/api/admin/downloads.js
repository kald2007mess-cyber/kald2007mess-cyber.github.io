
import { json } from "../_lib/session.js";
import {
  authorizeAdmin,
  adminAuthResponse
} from "../_lib/admin-auth.js";

const PLATFORMS = ["android", "ios", "beta"];
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const R2_PUBLIC_URL =
  "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";

function validPlatform(platform) {
  return PLATFORMS.includes(platform);
}

function permissionForPlatform(platform) {
  if (!validPlatform(platform)) return null;
  return platform;
}

async function authorizePlatform(initData, env, platform) {
  const permission = permissionForPlatform(platform);

  if (!permission) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_PLATFORM"
    };
  }

  return authorizeAdmin(initData, env, permission);
}

async function getAuthorizedPlatforms(initData, env) {
  const allowed = [];
  let lastAuth = null;

  for (const platform of PLATFORMS) {
    const auth = await authorizeAdmin(
      initData,
      env,
      platform
    );

    if (auth.ok && auth.owner) {
      return {
        ok: true,
        owner: true,
        platforms: PLATFORMS
      };
    }

    if (auth.ok) {
      allowed.push(platform);
      lastAuth = auth;
      continue;
    }

    if (auth.status >= 500) {
      return auth;
    }

    lastAuth = auth;
  }

  if (allowed.length > 0) {
    return {
      ok: true,
      owner: false,
      platforms: allowed
    };
  }

  return lastAuth || {
    ok: false,
    status: 403,
    error: "PERMISSION_DENIED"
  };
}

async function getDownloads(env, allowedPlatforms) {
  const result = await env.DB.prepare(
    `SELECT platform, title, version, description,
            file_name, file_key, download_url,
            file_size, enabled, updated_at
     FROM platform_downloads
     ORDER BY platform`
  ).all();

  return (result.results || []).filter(item =>
    allowedPlatforms.includes(item.platform)
  );
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
    if (!env.DB || !env.DOWNLOADS_BUCKET) {
      return json({
        success: false,
        error: "SERVER_CONFIG"
      }, 500);
    }

    const contentType =
      request.headers.get("Content-Type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();

      const platform = String(form.get("platform") || "");

      if (!["android", "beta"].includes(platform)) {
        return json({
          success: false,
          error: "INVALID_UPLOAD_PLATFORM"
        }, 400);
      }

      const auth = await authorizePlatform(
        String(form.get("initData") || ""),
        env,
        platform
      );

      if (!auth.ok) {
        return adminAuthResponse(auth);
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

    const body = await request.json();
    const initData = String(body.initData || "");

    if (body.action === "get") {
      const access = await getAuthorizedPlatforms(
        initData,
        env
      );

      if (!access.ok) {
        return adminAuthResponse(access);
      }

      return json({
        success: true,
        downloads: await getDownloads(
          env,
          access.platforms
        )
      });
    }

    if (body.action === "save") {
      const platform = String(body.platform || "");

      const auth = await authorizePlatform(
        initData,
        env,
        platform
      );

      if (!auth.ok) {
        return adminAuthResponse(auth);
      }

      return json(await savePlatform(env, body));
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

    const message =
      messages[error.message] || "DOWNLOADS_FAILED";

    return json({
      success: false,
      error: message
    }, error.message === "SERVER_CONFIG" ? 500 : 400);
  }
}
