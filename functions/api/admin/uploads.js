
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

async function authenticate(request, env, platform) {
  const initData =
    request.headers.get("x-init-data") ||
    request.headers.get("content-type")?.includes("application/json")
      ? null
      : null;

  let data = {};

  if (request.method === "PUT") {
    data.initData = request.headers.get("x-init-data") || "";
  } else {
    try {
      data = await request.clone().json();
    } catch {
      return {
        response: json({ success: false, error: "INVALID_JSON" }, 400)
      };
    }
  }

  const auth = await authorizeAdmin(
    String(data.initData || ""),
    env,
    platform
  );

  if (!auth.ok) {
    return { response: adminAuthResponse(auth) };
  }

  return { auth, data };
}

async function getSession(env, id, adminId, platform) {
  return await env.DB.prepare(`
    SELECT *
    FROM upload_sessions
    WHERE id = ?
      AND admin_id = ?
      AND platform = ?
    LIMIT 1
  `).bind(id, adminId, platform).first();
}

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

  if (
    !fileName.toLowerCase().endsWith(".apk") ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > MAX_FILE_SIZE
  ) {
    return json({ success: false, error: "INVALID_FILE" }, 400);
  }

  if (!env.DB || !env.DOWNLOADS_BUCKET) {
    return json({ success: false, error: "SERVER_CONFIG" }, 500);
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
      auth.telegramId
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

async function uploadPart(request, env) {
  if (!env.DB || !env.DOWNLOADS_BUCKET) {
    return json({ success: false, error: "SERVER_CONFIG" }, 500);
  }

  const sessionId = request.headers.get("x-session-id") || "";
  const partNumber = Number(request.headers.get("x-part-number"));
  const contentLength = Number(request.headers.get("content-length"));

  if (
    !sessionId ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > PART_SIZE
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

  const auth = await authorizeAdmin(
    request.headers.get("x-init-data") || "",
    env,
    session.platform
  );

  if (!auth.ok) return adminAuthResponse(auth);

  if (String(session.admin_id) !== String(auth.telegramId)) {
    return json({ success: false, error: "SESSION_OWNER_MISMATCH" }, 403);
  }

  const totalParts = Math.ceil(Number(session.file_size) / PART_SIZE);

  if (partNumber > totalParts) {
    return json({ success: false, error: "INVALID_PART_NUMBER" }, 400);
  }

  const expectedSize =
    partNumber === totalParts
      ? Number(session.file_size) - PART_SIZE * (totalParts - 1)
      : PART_SIZE;

  if (contentLength !== expectedSize) {
    return json({ success: false, error: "INVALID_PART_SIZE" }, 400);
  }

  try {
    const bytes = await request.arrayBuffer();

    if (bytes.byteLength !== expectedSize) {
      return json({ success: false, error: "PART_SIZE_MISMATCH" }, 400);
    }

    const upload = env.DOWNLOADS_BUCKET.resumeMultipartUpload(
      session.object_key,
      session.upload_id
    );

    const result = await upload.uploadPart(partNumber, bytes);

    await env.DB.prepare(`
      INSERT INTO upload_parts (session_id, part_number, etag)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, part_number)
      DO UPDATE SET etag = excluded.etag
    `).bind(
      sessionId,
      partNumber,
      result.etag
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

  const session = await getSession(
    env,
    sessionId,
    auth.telegramId,
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

    const parts = savedParts.map((part, index) => {
      if (Number(part.part_number) !== index + 1 || !part.etag) {
        throw new Error("INVALID_PART_SEQUENCE");
      }

      return {
        partNumber: Number(part.part_number),
        etag: String(part.etag)
      };
    });

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
      DELETE FROM upload_parts WHERE session_id = ?
    `).bind(sessionId).run();

    await env.DB.prepare(`
      DELETE FROM upload_sessions WHERE id = ?
    `).bind(sessionId).run();

    return json({
      success: true,
      file_name: session.file_name,
      file_size: Number(session.file_size),
      download_url: downloadUrl,
      etag: object.httpEtag
    });

  } catch (error) {
    return json({
      success: false,
      error: "UPLOAD_COMPLETE_FAILED"
    }, 500);
  }
}

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

  const session = await getSession(
    env,
    sessionId,
    auth.telegramId,
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
      DELETE FROM upload_parts WHERE session_id = ?
    `).bind(sessionId).run();

    await env.DB.prepare(`
      DELETE FROM upload_sessions WHERE id = ?
    `).bind(sessionId).run();

    return json({ success: true });

  } catch (error) {
    return json({
      success: false,
      error: "UPLOAD_ABORT_FAILED"
    }, 500);
  }
}

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

export async function onRequestPut({ request, env }) {
  try {
    return await uploadPart(request, env);
  } catch (error) {
    return json({
      success: false,
      error: "PART_SERVER_ERROR"
    }, 500);
  }
}
