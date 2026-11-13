
import {
  authorizeAdmin,
  adminAuthResponse
} from "../_lib/admin-auth.js";

const MAX_FILE_SIZE = 2.5 * 1024 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;
const ALLOWED_PLATFORMS = ["android", "beta"];

const R2_PUBLIC_URL =
  "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function cleanFileName(name) {
  return String(name || "OXIDE.apk")
    .replace(/[\/\\]/g, "_")
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 180);
}

function validPlatform(platform) {
  return ALLOWED_PLATFORMS.includes(platform);
}

async function getSession(env, id, adminId, platform) {
  return env.DB.prepare(`
    SELECT *
    FROM upload_sessions
    WHERE id = ?
      AND admin_id = ?
      AND platform = ?
    LIMIT 1
  `).bind(id, adminId, platform).first();
}

// START MULTIPART UPLOAD
async function startUpload(request, env) {
  const data = await request.json();

  const platform = String(data.platform || "").toLowerCase();
  const fileName = cleanFileName(data.file_name);
  const fileSize = Number(data.file_size);

  if (!validPlatform(platform)) {
    return json({ success: false, error: "INVALID_PLATFORM" }, 400);
  }

  const auth = await authorizeAdmin(
    String(data.initData || ""),
    env,
    platform
  );

  if (!auth.ok) return adminAuthResponse(auth);

  const adminId = String(auth.telegramId || "");

  if (!adminId) {
    return json({ success: false, error: "ADMIN_ID_MISSING" }, 403);
  }

  if (
    !fileName.toLowerCase().endsWith(".apk") ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > MAX_FILE_SIZE
  ) {
    return json({ success: false, error: "INVALID_FILE" }, 400);
  }

  const platformRow = await env.DB.prepare(`
    SELECT platform
    FROM platform_downloads
    WHERE platform = ?
    LIMIT 1
  `).bind(platform).first();

  if (!platformRow) {
    return json({
      success: false,
      error: "PLATFORM_NOT_CONFIGURED"
    }, 409);
  }

  const sessionId = crypto.randomUUID();

  const key =
    platform + "/" +
    Date.now() + "-" +
    crypto.randomUUID() + "-" +
    fileName;

  let upload;

  try {
    upload = await env.DOWNLOADS_BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType: "application/vnd.android.package-archive",
        contentDisposition:
          'attachment; filename="' + fileName.replace(/"/g, "") + '"',
        cacheControl: "public, max-age=31536000, immutable"
      }
    });

    await env.DB.prepare(`
      INSERT INTO upload_sessions (
        id, platform, upload_id, object_key,
        file_name, file_size, title, version,
        description, created_at, admin_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId,
      platform,
      upload.uploadId,
      key,
      fileName,
      fileSize,
      String(data.title || "").slice(0, 150),
      String(data.version || "").slice(0, 50),
      String(data.description || "").slice(0, 1000),
      Math.floor(Date.now() / 1000),
      adminId
    ).run();

    return json({
      success: true,
      session_id: sessionId,
      part_size: PART_SIZE,
      total_parts: Math.ceil(fileSize / PART_SIZE)
    });

  } catch (error) {
    if (upload) {
      try {
        await upload.abort();
      } catch {}
    }

    return json({
      success: false,
      error: "UPLOAD_START_FAILED"
    }, 500);
  }
}

// UPLOAD ONE PART
async function uploadPart(request, env) {
  const sessionId = request.headers.get("x-session-id") || "";
  const partNumber = Number(request.headers.get("x-part-number"));

  if (
    !sessionId ||
    !Number.isInteger(partNumber) ||
    partNumber < 1
  ) {
    return json({ success: false, error: "INVALID_PART" }, 400);
  }

  const session = await env.DB.prepare(`
    SELECT *
    FROM upload_sessions
    WHERE id = ?
    LIMIT 1
  `).bind(sessionId).first();

  if (!session) {
    return json({ success: false, error: "SESSION_NOT_FOUND" }, 404);
  }

  if (!validPlatform(session.platform)) {
    return json({ success: false, error: "INVALID_PLATFORM" }, 400);
  }

  const auth = await authorizeAdmin(
    request.headers.get("x-init-data") || "",
    env,
    session.platform
  );

  if (!auth.ok) return adminAuthResponse(auth);

  if (
    !auth.telegramId ||
    String(session.admin_id) !== String(auth.telegramId)
  ) {
    return json({ success: false, error: "SESSION_OWNER_MISMATCH" }, 403);
  }

  const fileSize = Number(session.file_size);
  const totalParts = Math.ceil(fileSize / PART_SIZE);

  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > MAX_FILE_SIZE ||
    partNumber > totalParts
  ) {
    return json({ success: false, error: "INVALID_PART_NUMBER" }, 400);
  }

  const expectedSize =
    partNumber === totalParts
      ? fileSize - PART_SIZE * (totalParts - 1)
      : PART_SIZE;

  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const length = Number(declaredLength);

    if (!Number.isSafeInteger(length) || length !== expectedSize) {
      return json({ success: false, error: "INVALID_PART_SIZE" }, 400);
    }
  }

  try {
    const bytes = await request.arrayBuffer();

    if (bytes.byteLength !== expectedSize) {
      return json({ success: false, error: "INVALID_PART_SIZE" }, 400);
    }

    const upload = env.DOWNLOADS_BUCKET.resumeMultipartUpload(
      session.object_key,
      session.upload_id
    );

    const result = await upload.uploadPart(partNumber, bytes);

    if (!result || !result.etag) {
      return json({ success: false, error: "PART_ETAG_MISSING" }, 500);
    }

    await env.DB.prepare(`
      INSERT INTO upload_parts (session_id, part_number, etag)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, part_number)
      DO UPDATE SET etag = excluded.etag
    `).bind(
      sessionId,
      partNumber,
      String(result.etag)
    ).run();

    return json({
      success: true,
      part_number: partNumber
    });

  } catch (error) {
    return json({
      success: false,
      error: "PART_UPLOAD_FAILED"
    }, 500);
  }
}

// COMPLETE UPLOAD
async function completeUpload(request, env) {
  const data = await request.json();

  const platform = String(data.platform || "").toLowerCase();
  const sessionId = String(data.session_id || "");

  if (!validPlatform(platform) || !sessionId) {
    return json({ success: false, error: "INVALID_REQUEST" }, 400);
  }

  const auth = await authorizeAdmin(
    String(data.initData || ""),
    env,
    platform
  );

  if (!auth.ok) return adminAuthResponse(auth);

  const adminId = String(auth.telegramId || "");

  if (!adminId) {
    return json({ success: false, error: "ADMIN_ID_MISSING" }, 403);
  }

  const session = await getSession(
    env,
    sessionId,
    adminId,
    platform
  );

  if (!session) {
    return json({ success: false, error: "SESSION_NOT_FOUND" }, 404);
  }

  try {
    const rows = await env.DB.prepare(`
      SELECT part_number, etag
      FROM upload_parts
      WHERE session_id = ?
      ORDER BY part_number ASC
    `).bind(sessionId).all();

    const totalParts = Math.ceil(Number(session.file_size) / PART_SIZE);
    const savedParts = rows.results || [];

    if (savedParts.length !== totalParts) {
      return json({
        success: false,
        error: "PARTS_INCOMPLETE",
        uploaded_parts: savedParts.length,
        total_parts: totalParts
      }, 400);
    }

    const parts = [];

    for (let i = 0; i < savedParts.length; i++) {
      const part = savedParts[i];

      if (
        Number(part.part_number) !== i + 1 ||
        !part.etag
      ) {
        return json({
          success: false,
          error: "INVALID_PART_SEQUENCE"
        }, 400);
      }

      parts.push({
        partNumber: Number(part.part_number),
        etag: String(part.etag)
      });
    }

    const upload = env.DOWNLOADS_BUCKET.resumeMultipartUpload(
      session.object_key,
      session.upload_id
    );

    const object = await upload.complete(parts);

    const downloadUrl =
      R2_PUBLIC_URL + "/" + session.object_key;

    await env.DB.prepare(`
      UPDATE platform_downloads
      SET
        title = ?,
        version = ?,
        description = ?,
        file_name = ?,
        file_key = ?,
        download_url = ?,
        file_size = ?,
        enabled = 1,
        updated_at = ?
      WHERE platform = ?
    `).bind(
      session.title,
      session.version,
      session.description,
      session.file_name,
      session.object_key,
      downloadUrl,
      Number(session.file_size),
      Math.floor(Date.now() / 1000),
      platform
    ).run();

    await env.DB.prepare(`
      DELETE FROM upload_parts
      WHERE session_id = ?
    `).bind(sessionId).run();

    await env.DB.prepare(`
      DELETE FROM upload_sessions
      WHERE id = ?
    `).bind(sessionId).run();

    return json({
      success: true,
      file_name: session.file_name,
      file_size: Number(session.file_size),
      download_url: downloadUrl,
      etag: object?.httpEtag || null
    });

  } catch (error) {
    return json({
      success: false,
      error: "UPLOAD_COMPLETE_FAILED"
    }, 500);
  }
}

// ABORT UPLOAD
async function abortUpload(request, env) {
  const data = await request.json();

  const platform = String(data.platform || "").toLowerCase();
  const sessionId = String(data.session_id || "");

  if (!validPlatform(platform) || !sessionId) {
    return json({ success: false, error: "INVALID_REQUEST" }, 400);
  }

  const auth = await authorizeAdmin(
    String(data.initData || ""),
    env,
    platform
  );

  if (!auth.ok) return adminAuthResponse(auth);

  const adminId = String(auth.telegramId || "");

  const session = await getSession(
    env,
    sessionId,
    adminId,
    platform
  );

  if (!session) {
    return json({ success: false, error: "SESSION_NOT_FOUND" }, 404);
  }

  try {
    const upload = env.DOWNLOADS_BUCKET.resumeMultipartUpload(
      session.object_key,
      session.upload_id
    );

    await upload.abort();

    await env.DB.prepare(`
      DELETE FROM upload_parts
      WHERE session_id = ?
    `).bind(sessionId).run();

    await env.DB.prepare(`
      DELETE FROM upload_sessions
      WHERE id = ?
    `).bind(sessionId).run();

    return json({ success: true });

  } catch (error) {
    return json({
      success: false,
      error: "UPLOAD_ABORT_FAILED"
    }, 500);
  }
}

// POST ROUTER
export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.DOWNLOADS_BUCKET) {
      return json({ success: false, error: "SERVER_CONFIG" }, 500);
    }

    const data = await request.clone().json();
    const action = String(data.action || "");

    if (action === "start") {
      return await startUpload(request, env);
    }

    if (action === "complete") {
      return await completeUpload(request, env);
    }

    if (action === "abort") {
      return await abortUpload(request, env);
    }

    return json({ success: false, error: "INVALID_ACTION" }, 400);

  } catch (error) {
    return json({
      success: false,
      error: "UPLOAD_SERVER_ERROR"
    }, 500);
  }
}

// PUT ROUTE
export async function onRequestPut({ request, env }) {
  try {
    if (!env.DB || !env.DOWNLOADS_BUCKET) {
      return json({ success: false, error: "SERVER_CONFIG" }, 500);
    }

    return await uploadPart(request, env);

  } catch (error) {
    return json({
      success: false,
      error: "PART_SERVER_ERROR"
    }, 500);
  }
}
