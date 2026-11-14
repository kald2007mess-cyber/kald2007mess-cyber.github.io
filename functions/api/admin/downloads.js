
import { json } from "../_lib/session.js";
import {
  authorizeAdmin,
  adminAuthResponse
} from "../_lib/admin-auth.js";

const PLATFORMS = ["android", "ios", "beta"];
const UPLOAD_PLATFORMS = ["android", "ios", "beta"];

const MAX_FILE_SIZE = 2.5 * 1024 * 1024 * 1024;
const MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PART_SIZE = 10 * 1024 * 1024;

const R2_PUBLIC_URL =
  "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";

function validPlatform(platform) {
  return PLATFORMS.includes(platform);
}

async function authorizePlatform(initData, env, platform) {
  if (!validPlatform(platform)) {
    return { ok: false, status: 400, error: "INVALID_PLATFORM" };
  }

  return authorizeAdmin(initData, env, platform);
}

async function getAuthorizedPlatforms(initData, env) {
  const allowed = [];
  let lastAuth = null;

  for (const platform of PLATFORMS) {
    const auth = await authorizeAdmin(initData, env, platform);

    if (auth.ok && auth.owner) {
      return { ok: true, owner: true, platforms: PLATFORMS };
    }

    if (auth.ok) {
      allowed.push(platform);
      lastAuth = auth;
    } else {
      if (auth.status >= 500) return auth;
      lastAuth = auth;
    }
  }

  if (allowed.length) {
    return { ok: true, owner: false, platforms: allowed };
  }

  return lastAuth || {
    ok: false,
    status: 403,
    error: "PERMISSION_DENIED"
  };
}

/* جلب الملفات مع عدد المستخدمين الذين نزلوها */
async function getDownloads(env, allowedPlatforms) {
  const result = await env.DB.prepare(`
    SELECT
      pf.id,
      pf.platform,
      pf.title,
      pf.version,
      pf.description,
      pf.file_name,
      pf.file_key,
      pf.download_url,
      pf.file_size,
      pf.enabled,
      pf.created_at,
      pf.updated_at,
      (
        SELECT COUNT(*)
        FROM platform_file_downloads d
        WHERE d.file_id = pf.id
      ) AS downloads_count
    FROM platform_files pf
    ORDER BY pf.platform, pf.created_at DESC
  `).all();

  const files = (result.results || [])
    .filter(item => allowedPlatforms.includes(item.platform))
    .map(item => ({
      ...item,
      downloads_count: Number(item.downloads_count || 0)
    }));

  const legacyResult = await env.DB.prepare(`
    SELECT
      platform,
      title,
      version,
      description,
      file_name,
      file_key,
      download_url,
      file_size,
      enabled,
      updated_at
    FROM platform_downloads
    ORDER BY platform
  `).all();

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
        downloads_count: 0,
        legacy: true
      });
    }
  }

  return files;
}

/* جلب فيديوهات الشرح */
async function getTutorials(env, allowedPlatforms) {
  const result = await env.DB.prepare(`
    SELECT platform, video_url, updated_at
    FROM platform_tutorials
  `).all();

  const tutorials = {
    android: "",
    ios: "",
    beta: ""
  };

  for (const item of result.results || []) {
    if (allowedPlatforms.includes(item.platform)) {
      tutorials[item.platform] = item.video_url || "";
    }
  }

  return tutorials;
}

/* حفظ فيديو شرح المنصة */
async function saveTutorial(env, data) {
  const platform = String(data.platform || "").trim();

  if (!validPlatform(platform)) {
    throw new Error("INVALID_PLATFORM");
  }

  const videoUrl = String(
    data.video_url ??
    data.tutorial_url ??
    data.url ??
    ""
  ).trim();

  if (videoUrl.length > 1000) {
    throw new Error("INVALID_URL");
  }

  if (
    videoUrl &&
    !/^https:\/\/[^\s]+$/i.test(videoUrl)
  ) {
    throw new Error("INVALID_URL");
  }

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(`
    INSERT INTO platform_tutorials (
      platform, video_url, updated_at
    )
    VALUES (?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      video_url = excluded.video_url,
      updated_at = excluded.updated_at
  `).bind(platform, videoUrl, now).run();

  return {
    success: true,
    platform,
    video_url: videoUrl,
    updated_at: now
  };
}

function readEnabled(value, fallback = 1) {
  if (value === undefined || value === null) return fallback;

  return value === true ||
    value === 1 ||
    value === "1" ||
    value === "true" ? 1 : 0;
}

function validateDetails(title, version, description) {
  if (!title || title.length > 150) {
    throw new Error("INVALID_TITLE");
  }

  if (version.length > 50 || description.length > 1000) {
    throw new Error("INVALID_DETAILS");
  }
}

function safeFileName(name) {
  const cleaned = String(name || "download.apk")
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-120);

  return cleaned || "download.apk";
}

function validateUploadPlatform(platform) {
  if (!UPLOAD_PLATFORMS.includes(platform)) {
    throw new Error("INVALID_UPLOAD_PLATFORM");
  }
}

function validateUploadKey(platform, key) {
  if (
    typeof key !== "string" ||
    !key.startsWith(`${platform}/`) ||
    key.length > 300 ||
    key.includes("..")
  ) {
    throw new Error("INVALID_UPLOAD");
  }
}

/* التحقق من امتداد الملف حسب المنصة */
function validateFileExtension(platform, fileName) {
  const name = fileName.toLowerCase();

  if (platform === "ios" && !name.endsWith(".ipa")) {
    throw new Error("IPA_ONLY");
  }

  if (
    (platform === "android" || platform === "beta") &&
    !name.endsWith(".apk")
  ) {
    throw new Error("APK_ONLY");
  }
}

/* نوع الملف عند التخزين في R2 */
function getContentType(platform) {
  return platform === "ios"
    ? "application/octet-stream"
    : "application/vnd.android.package-archive";
}

/* حفظ بيانات الملف */
async function savePlatform(env, data) {
  const platform = String(data.platform || "");

  if (!validPlatform(platform)) {
    throw new Error("INVALID_PLATFORM");
  }

  const id = String(data.id || "").trim();
  let current = null;

  if (id && !id.startsWith("legacy-")) {
    current = await env.DB.prepare(
      `SELECT * FROM platform_files WHERE id = ? AND platform = ?`
    ).bind(id, platform).first();

    if (!current) throw new Error("FILE_NOT_FOUND");
  }

  if (id.startsWith("legacy-")) {
    current = await env.DB.prepare(
      `SELECT * FROM platform_downloads WHERE platform = ?`
    ).bind(platform).first();

    if (!current) throw new Error("FILE_NOT_FOUND");
  }

  const title = String(
    data.title ?? current?.title ?? ""
  ).trim();

  const version = String(
    data.version ?? current?.version ?? ""
  ).trim();

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

  if (id.startsWith("legacy-")) {
    await env.DB.prepare(`
      UPDATE platform_downloads
      SET title=?, version=?, description=?,
          download_url=?, enabled=?, updated_at=?
      WHERE platform=?
    `).bind(
      title, version, description, downloadUrl,
      enabled, now, platform
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
    await env.DB.prepare(`
      UPDATE platform_files
      SET title=?, version=?, description=?,
          download_url=?, enabled=?, updated_at=?
      WHERE id=? AND platform=?
    `).bind(
      title, version, description, downloadUrl,
      enabled, now, id, platform
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

  const newId = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO platform_files (
      id, platform, title, version, description,
      file_name, file_key, download_url, file_size,
      enabled, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, '', '', ?, 0, ?, ?, ?)
  `).bind(
    newId, platform, title, version, description,
    downloadUrl, enabled, now, now
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

/* إنشاء رفع مجزأ في R2 */
async function createMultipartUpload(env, form) {
  const platform = String(form.get("platform") || "");
  validateUploadPlatform(platform);

  const fileName = safeFileName(form.get("fileName"));
  const fileSize = Number(form.get("fileSize"));

  validateFileExtension(platform, fileName);

  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > MAX_FILE_SIZE
  ) {
    throw new Error("FILE_TOO_LARGE");
  }

  const title = String(form.get("title") || "").trim();
  const version = String(form.get("version") || "").trim();
  const description = String(form.get("description") || "").trim();

  validateDetails(title, version, description);

  const key =
    `${platform}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;

  const upload = await env.DOWNLOADS_BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType: getContentType(platform),
      contentDisposition: `attachment; filename="${fileName}"`
    }
  });

  return {
    success: true,
    uploadId: upload.uploadId,
    key,
    fileName,
    fileSize,
    partSize: MAX_PART_SIZE
  };
}

/* رفع جزء واحد */
async function uploadPart(env, form) {
  const platform = String(form.get("platform") || "");
  validateUploadPlatform(platform);

  const key = String(form.get("key") || "");
  const uploadId = String(form.get("uploadId") || "");
  const partNumber = Number(form.get("partNumber"));
  const chunk = form.get("chunk");

  validateUploadKey(platform, key);

  if (!uploadId || uploadId.length > 500) {
    throw new Error("INVALID_UPLOAD");
  }

  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > 10000
  ) {
    throw new Error("INVALID_PART");
  }

  if (
    !chunk ||
    typeof chunk.size !== "number" ||
    chunk.size <= 0 ||
    chunk.size > MAX_PART_SIZE
  ) {
    throw new Error("INVALID_PART_SIZE");
  }

  const upload = env.DOWNLOADS_BUCKET.resumeMultipartUpload(
    key,
    uploadId
  );

  const result = await upload.uploadPart(
    partNumber,
    chunk.stream()
  );

  return {
    success: true,
    partNumber,
    etag: result.etag
  };
}

/* إكمال الرفع وتسجيل الملف في D1 */
async function completeMultipartUpload(env, form) {
  const platform = String(form.get("platform") || "");
  validateUploadPlatform(platform);

  const key = String(form.get("key") || "");
  const uploadId = String(form.get("uploadId") || "");
  const fileName = safeFileName(form.get("fileName"));
  const fileSize = Number(form.get("fileSize"));

  validateUploadKey(platform, key);
  validateFileExtension(platform, fileName);

  if (
    !uploadId ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > MAX_FILE_SIZE
  ) {
    throw new Error("INVALID_UPLOAD");
  }

  const title = String(form.get("title") || "").trim();
  const version = String(form.get("version") || "").trim();
  const description = String(form.get("description") || "").trim();

  validateDetails(title, version, description);

  let parts;

  try {
    parts = JSON.parse(String(form.get("parts") || "[]"));
  } catch {
    throw new Error("INVALID_PARTS");
  }

  if (
    !Array.isArray(parts) ||
    parts.length < 1 ||
    parts.length > 10000
  ) {
    throw new Error("INVALID_PARTS");
  }

  parts = parts.map(part => ({
    partNumber: Number(part.partNumber),
    etag: String(part.etag || "")
  }));

  for (let i = 0; i < parts.length; i++) {
    if (
      parts[i].partNumber !== i + 1 ||
      !parts[i].etag
    ) {
      throw new Error("INVALID_PARTS");
    }
  }

  const expectedParts = Math.ceil(fileSize / MAX_PART_SIZE);

  if (parts.length !== expectedParts) {
    throw new Error("INVALID_PARTS");
  }

  const upload = env.DOWNLOADS_BUCKET.resumeMultipartUpload(
    key,
    uploadId
  );

  await upload.complete(parts);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const downloadUrl = `${R2_PUBLIC_URL}/${key}`;

  try {
    await env.DB.prepare(`
      INSERT INTO platform_files (
        id, platform, title, version, description,
        file_name, file_key, download_url, file_size,
        enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      id, platform, title, version, description,
      fileName, key, downloadUrl, fileSize, now, now
    ).run();
  } catch (error) {
    try {
      await env.DOWNLOADS_BUCKET.delete(key);
    } catch (deleteError) {
      console.error("R2 cleanup error:", deleteError);
    }

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
    file_size: fileSize,
    enabled: true,
    downloads_count: 0,
    created_at: now
  };
}

/* إلغاء رفع لم يكتمل */
async function abortMultipartUpload(env, form) {
  const platform = String(form.get("platform") || "");
  validateUploadPlatform(platform);

  const key = String(form.get("key") || "");
  const uploadId = String(form.get("uploadId") || "");

  validateUploadKey(platform, key);

  if (!uploadId || uploadId.length > 500) {
    throw new Error("INVALID_UPLOAD");
  }

  const upload = env.DOWNLOADS_BUCKET.resumeMultipartUpload(
    key,
    uploadId
  );

  await upload.abort();

  return { success: true };
}

/* حذف ملف */
async function deleteFile(env, data) {
  const id = String(data.id || "").trim();
  const platform = String(data.platform || "");

  if (!id || id.startsWith("legacy-")) {
    throw new Error("INVALID_FILE_ID");
  }

  if (!validPlatform(platform)) {
    throw new Error("INVALID_PLATFORM");
  }

  const file = await env.DB.prepare(`
    SELECT id, file_key
    FROM platform_files
    WHERE id=? AND platform=?
  `).bind(id, platform).first();

  if (!file) throw new Error("FILE_NOT_FOUND");

  await env.DB.prepare(`
    DELETE FROM platform_file_downloads
    WHERE file_id=?
  `).bind(id).run();

  await env.DB.prepare(`
    DELETE FROM platform_files
    WHERE id=? AND platform=?
  `).bind(id, platform).run();

  if (file.file_key) {
    try {
      await env.DOWNLOADS_BUCKET.delete(file.file_key);
    } catch (error) {
      console.error("R2 delete error:", error);
    }
  }

  return { success: true, id, platform };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.DOWNLOADS_BUCKET) {
      return json({ success: false, error: "SERVER_CONFIG" }, 500);
    }

    const contentType = request.headers.get("Content-Type") || "";

    /* عمليات رفع الملفات */
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const platform = String(form.get("platform") || "");

      const auth = await authorizePlatform(
        String(form.get("initData") || ""),
        env,
        platform
      );

      if (!auth.ok) return adminAuthResponse(auth);

      const action = String(form.get("action") || "");

      if (action === "create") {
        return json(await createMultipartUpload(env, form));
      }

      if (action === "part") {
        return json(await uploadPart(env, form));
      }

      if (action === "complete") {
        return json(await completeMultipartUpload(env, form));
      }

      if (action === "abort") {
        return json(await abortMultipartUpload(env, form));
      }

      return json({
        success: false,
        error: "INVALID_ACTION"
      }, 400);
    }

    const body = await request.json();
    const initData = String(body.initData || "");

    /* جلب الملفات والفيديوهات */
    if (body.action === "get") {
      const access = await getAuthorizedPlatforms(initData, env);

      if (!access.ok) return adminAuthResponse(access);

      return json({
        success: true,
        downloads: await getDownloads(env, access.platforms),
        tutorials: await getTutorials(env, access.platforms),
        platforms: access.platforms
      });
    }

    /* حفظ بيانات الملف */
    if (body.action === "save") {
      const auth = await authorizePlatform(
        initData,
        env,
        String(body.platform || "")
      );

      if (!auth.ok) return adminAuthResponse(auth);

      return json(await savePlatform(env, body));
    }

    /* حفظ فيديو شرح المنصة */
    if (
      body.action === "tutorial_save" ||
      body.action === "save_tutorial" ||
      body.action === "saveTutorial"
    ) {
      const auth = await authorizePlatform(
        initData,
        env,
        String(body.platform || "")
      );

      if (!auth.ok) return adminAuthResponse(auth);

      return json(await saveTutorial(env, body));
    }

    /* حذف ملف */
    if (body.action === "delete") {
      const auth = await authorizePlatform(
        initData,
        env,
        String(body.platform || "")
      );

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
      APK_ONLY: "APK_ONLY",
      IPA_ONLY: "IPA_ONLY",
      FILE_NOT_FOUND: "FILE_NOT_FOUND",
      INVALID_FILE_ID: "INVALID_FILE_ID",
      INVALID_UPLOAD: "INVALID_UPLOAD",
      INVALID_PART: "INVALID_PART",
      INVALID_PART_SIZE: "INVALID_PART_SIZE",
      INVALID_PARTS: "INVALID_PARTS",
      FILE_TOO_LARGE: "FILE_TOO_LARGE"
    };

    const message = messages[error.message] || "DOWNLOADS_FAILED";

    const status =
      error.message === "SERVER_CONFIG" ? 500 :
      error.message === "FILE_NOT_FOUND" ? 404 : 400;

    return json({
      success: false,
      error: message
    }, status);
  }
}
