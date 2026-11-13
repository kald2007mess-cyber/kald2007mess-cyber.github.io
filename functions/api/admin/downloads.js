
import { json } from "../_lib/session.js";
import {
  authorizeAdmin,
  adminAuthResponse
} from "../_lib/admin-auth.js";

const PLATFORMS = ["android", "ios", "beta"];
const UPLOAD_PLATFORMS = ["android", "beta"];
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const R2_PUBLIC_URL =
  "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";

function validPlatform(platform) {
  return PLATFORMS.includes(platform);
}

async function authorizePlatform(initData, env, platform) {
  if (!validPlatform(platform)) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_PLATFORM"
    };
  }

  return authorizeAdmin(initData, env, platform);
}

async function getAuthorizedPlatforms(initData, env) {
  const allowed = [];
  let lastAuth = null;

  for (const platform of PLATFORMS) {
    const auth = await authorizeAdmin(initData, env, platform);

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

    if (auth.status >= 500) return auth;
    lastAuth = auth;
  }

  if (allowed.length) {
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
    `SELECT id, platform, title, version, description,
            file_name, file_key, download_url,
            file_size, enabled, created_at, updated_at
     FROM platform_files
     ORDER BY platform, created_at DESC`
  ).all();

  const files = (result.results || []).filter(item =>
    allowedPlatforms.includes(item.platform)
  );

  // إظهار البيانات القديمة فقط إذا لم توجد ملفات جديدة للمنصة.
  const legacyResult = await env.DB.prepare(
    `SELECT platform, title, version, description,
            file_name, file_key, download_url,
            file_size, enabled, updated_at
     FROM platform_downloads
     ORDER BY platform`
  ).all();

  const platformsWithFiles = new Set(
    files.map(item => item.platform)
  );

  for (const item of legacyResult.results || []) {
    if (
      allowedPlatforms.includes(item.platform) &&
      !platformsWithFiles.has(item.platform)
    ) {
      files.push({
        ...item,
        id: `legacy-${item.platform}`,
        created_at: item.updated_at || 0,
        legacy: true
      });
    }
  }

  return files;
}

function readEnabled(value, fallback = 1) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1 || value === "1" || value === "true") {
    return 1;
  }
  return 0;
}

function validateDetails(title, version, description) {
  if (!title || title.length > 150) {
    throw new Error("INVALID_TITLE");
  }

  if (version.length > 50 || description.length > 1000) {
    throw new Error("INVALID_DETAILS");
  }
}

async function savePlatform(env, data) {
  const platform = String(data.platform || "");

  if (!validPlatform(platform)) {
    throw new Error("INVALID_PLATFORM");
  }

  const id = String(data.id || "").trim();

  let current = null;

  if (id && !id.startsWith("legacy-")) {
    current = await env.DB.prepare(
      `SELECT * FROM platform_files
       WHERE id = ? AND platform = ?`
    ).bind(id, platform).first();

    if (!current) throw new Error("FILE_NOT_FOUND");
  }

  if (id.startsWith("legacy-")) {
    current = await env.DB.prepare(
      `SELECT * FROM platform_downloads
       WHERE platform = ?`
    ).bind(platform).first();

    if (!current) throw new Error("FILE_NOT_FOUND");
  }

  const title = String(data.title ?? current?.title ?? "").trim();
  const version = String(data.version ?? current?.version ?? "").trim();
  const description = String(
    data.description ?? current?.description ?? ""
  ).trim();

  const downloadUrl = String(
    data.download_url ?? current?.download_url ?? ""
  ).trim();

  const enabled = readEnabled(
    data.enabled,
    Number(current?.enabled ?? 1)
  );

  validateDetails(title, version, description);

  if (downloadUrl && !/^https:\/\/[^\s]+$/i.test(downloadUrl)) {
    throw new Error("INVALID_URL");
  }

  if (platform === "ios" && enabled === 1 && !downloadUrl) {
    throw new Error("IOS_URL_REQUIRED");
  }

  const now = Math.floor(Date.now() / 1000);

  // تحديث سجل قديم للمحافظة على التوافق.
  if (id.startsWith("legacy-")) {
    await env.DB.prepare(
      `UPDATE platform_downloads
       SET title = ?, version = ?, description = ?,
           download_url = ?, enabled = ?, updated_at = ?
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
      id,
      platform,
      title,
      version,
      description,
      download_url: downloadUrl,
      enabled,
      updated_at: now,
      legacy: true
    };
  }

  if (current) {
    await env.DB.prepare(
      `UPDATE platform_files
       SET title = ?, version = ?, description = ?,
           download_url = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND platform = ?`
    ).bind(
      title,
      version,
      description,
      downloadUrl,
      enabled,
      now,
      id,
      platform
    ).run();

    return {
      success: true,
      id,
      platform,
      title,
      version,
      description,
      download_url: downloadUrl,
      enabled,
      updated_at: now
    };
  }

  // إنشاء سجل جديد، مثل إضافة رابط iOS جديد.
  const newId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO platform_files (
       id, platform, title, version, description,
       file_name, file_key, download_url, file_size,
       enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, '', '', ?, 0, ?, ?, ?)`
  ).bind(
    newId,
    platform,
    title,
    version,
    description,
    downloadUrl,
    enabled,
    now,
    now
  ).run();

  return {
    success: true,
    id: newId,
    platform,
    title,
    version,
    description,
    download_url: downloadUrl,
    enabled,
    created_at: now,
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

  if (!UPLOAD_PLATFORMS.includes(platform)) {
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

  const title = String(form.get("title") || "").trim();
  const version = String(form.get("version") || "").trim();
  const description = String(form.get("description") || "").trim();

  validateDetails(title, version, description);

  const key =
    `${platform}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await env.DOWNLOADS_BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType: "application/vnd.android.package-archive",
      contentDisposition: `attachment; filename="${fileName}"`
    }
  });

  const downloadUrl = `${R2_PUBLIC_URL}/${key}`;

  try {
    await env.DB.prepare(
      `INSERT INTO platform_files (
         id, platform, title, version, description,
         file_name, file_key, download_url, file_size,
         enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(
      id,
      platform,
      title,
      version,
      description,
      fileName,
      key,
      downloadUrl,
      file.size,
      now,
      now
    ).run();

  } catch (error) {
    await env.DOWNLOADS_BUCKET.delete(key);
    throw error;
  }

  return {
    success: true,
    id,
    platform,
    title,
    version,
    file_name: fileName,
    file_key: key,
    download_url: downloadUrl,
    file_size: file.size,
    enabled: true,
    created_at: now
  };
}

async function deleteFile(env, data) {
  const id = String(data.id || "").trim();
  const platform = String(data.platform || "");

  if (!id || id.startsWith("legacy-")) {
    throw new Error("INVALID_FILE_ID");
  }

  if (!validPlatform(platform)) {
    throw new Error("INVALID_PLATFORM");
  }

  const file = await env.DB.prepare(
    `SELECT id, file_key
     FROM platform_files
     WHERE id = ? AND platform = ?`
  ).bind(id, platform).first();

  if (!file) throw new Error("FILE_NOT_FOUND");

  await env.DB.prepare(
    `DELETE FROM platform_files
     WHERE id = ? AND platform = ?`
  ).bind(id, platform).run();

  if (file.file_key) {
    try {
      await env.DOWNLOADS_BUCKET.delete(file.file_key);
    } catch (error) {
      console.error("R2 delete error:", error);
    }
  }

  return {
    success: true,
    id,
    platform
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

      if (!UPLOAD_PLATFORMS.includes(platform)) {
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

      if (!auth.ok) return adminAuthResponse(auth);

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
      const access = await getAuthorizedPlatforms(initData, env);

      if (!access.ok) return adminAuthResponse(access);

      return json({
        success: true,
        downloads: await getDownloads(env, access.platforms),
        platforms: access.platforms
      });
    }

    if (body.action === "save") {
      const platform = String(body.platform || "");
      const auth = await authorizePlatform(initData, env, platform);

      if (!auth.ok) return adminAuthResponse(auth);

      return json(await savePlatform(env, body));
    }

    if (body.action === "delete") {
      const platform = String(body.platform || "");
      const auth = await authorizePlatform(initData, env, platform);

      if (!auth.ok) return adminAuthResponse(auth);

      return json(await deleteFile(env, body));
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
      INVALID_UPLOAD_PLATFORM: "INVALID_UPLOAD_PLATFORM",
      INVALID_TITLE: "INVALID_TITLE",
      INVALID_DETAILS: "INVALID_DETAILS",
      INVALID_URL: "INVALID_URL",
      IOS_URL_REQUIRED: "IOS_URL_REQUIRED",
      FILE_REQUIRED: "FILE_REQUIRED",
      FILE_TOO_LARGE: "FILE_TOO_LARGE",
      APK_ONLY: "APK_ONLY",
      FILE_NOT_FOUND: "FILE_NOT_FOUND",
      INVALID_FILE_ID: "INVALID_FILE_ID"
    };

    const message =
      messages[error.message] || "DOWNLOADS_FAILED";

    const status =
      error.message === "SERVER_CONFIG" ? 500 :
      error.message === "FILE_NOT_FOUND" ? 404 : 400;

    return json({
      success: false,
      error: message
    }, status);
  }
}
