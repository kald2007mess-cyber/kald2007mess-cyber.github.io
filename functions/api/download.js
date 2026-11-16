
import { json, getVisitor } from "./_lib/session.js";
import { ensurePlatformTables } from "./_lib/platform-schema.js";

const R2_PUBLIC_URL = "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";

function r2KeyFromPublicUrl(value, platform) {
  try {
    const url = new URL(String(value || ""));
    if (url.origin !== R2_PUBLIC_URL) return null;
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!key.startsWith(platform + "/") || key.includes("..") || key.includes("\\")) return null;
    return key;
  } catch {
    return null;
  }
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

  if (!match || (!match[1] && !match[2])) {
    return { invalid: true };
  }

  let start;
  let end;

  if (!match[1]) {
    const suffixLength = Number(match[2]);

    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { invalid: true };
    }

    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      return { invalid: true };
    }

    end = Math.min(end, size - 1);
  }

  return {
    start,
    end,
    length: end - start + 1
  };
}

function attachmentHeader(fileName) {
  const name = String(fileName || "OXIDE-HUB.apk")
    .replace(/[\/\\"]/g, "_")
    .replace(/[\r\n]/g, "_");

  const fallback = name.replace(/[^\x20-\x7E]/g, "_");

  return (
    'attachment; filename="' + fallback + '"; ' +
    "filename*=UTF-8''" + encodeURIComponent(name)
  );
}

async function findFile(env, platform, fileId) {
  if (fileId && fileId.startsWith("legacy-") && fileId !== "legacy-" + platform) return null;
  if (fileId && !fileId.startsWith("legacy-")) {
    return await env.DB.prepare(`
      SELECT *
      FROM platform_files
      WHERE id = ?
        AND platform = ?
        AND enabled = 1
      LIMIT 1
    `).bind(fileId, platform).first();
  }

  return await env.DB.prepare(`
    SELECT *
    FROM platform_downloads
    WHERE platform = ?
      AND enabled = 1
    LIMIT 1
  `).bind(platform).first();
}

/* تسجيل المستخدم مرة واحدة لكل ملف */
async function recordUniqueDownload(env, fileId, visitorId) {
  if (!fileId || !visitorId) return;

  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO platform_file_downloads
        (file_id, user_id, downloaded_at)
      VALUES (?, ?, ?)
    `).bind(
      String(fileId),
      String(visitorId),
      Math.floor(Date.now() / 1000)
    ).run();
  } catch (error) {
    console.error("Download statistics error:", error);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.DOWNLOADS_BUCKET) {
      return json({
        success: false,
        error: "SERVER_CONFIG"
      }, 500);
    }

    await ensurePlatformTables(env.DB);

    const visitorId = await getVisitor(request, env);

    if (!visitorId) {
      return json({
        success: false,
        error: "VISITOR_NOT_FOUND"
      }, 401);
    }

    const visitor = await env.DB.prepare(`
      SELECT user_uuid
      FROM users
      WHERE user_uuid = ? AND status = 'active'
    `).bind(visitorId).first();

    if (!visitor) {
      return json({
        success: false,
        error: "VISITOR_NOT_FOUND"
      }, 401);
    }

    const url = new URL(request.url);

    const platform = (
      url.searchParams.get("platform") || ""
    ).toLowerCase();

    const fileId = String(
      url.searchParams.get("id") || ""
    ).trim();

    if (!["android", "ios", "beta"].includes(platform)) {
      return json({
        success: false,
        error: "INVALID_PLATFORM"
      }, 400);
    }

    const item = await findFile(env, platform, fileId);

    if (!item) {
      return json({
        success: false,
        error: "NOT_AVAILABLE"
      }, 404);
    }

    if (!item.file_key) {
      item.file_key = r2KeyFromPublicUrl(item.download_url, platform) || "";
    }

    if (item.file_key && (
      !String(item.file_key).startsWith(platform + "/") ||
      String(item.file_key).includes("..") ||
      String(item.file_key).includes("\\")
    )) {
      return json({ success: false, error: "INVALID_FILE_KEY" }, 500);
    }

    /* iOS: proxy the remote file through this endpoint so the browser
       can measure bytes received and verify the complete response. */
    if (platform === "ios") {
      if (!item.download_url) {
        return json({
          success: false,
          error: "DOWNLOAD_URL_MISSING"
        }, 404);
      }

      let remoteUrl;
      try {
        remoteUrl = new URL(item.download_url);
      } catch {
        return json({ success: false, error: "INVALID_DOWNLOAD_URL" }, 500);
      }

      if (remoteUrl.protocol !== "https:") {
        return json({ success: false, error: "INVALID_DOWNLOAD_URL" }, 500);
      }

      const upstreamHeaders = new Headers();
      const requestedRange = request.headers.get("range");
      if (requestedRange) upstreamHeaders.set("Range", requestedRange);

      const upstream = await fetch(remoteUrl.toString(), {
        method: "GET",
        headers: upstreamHeaders,
        redirect: "follow"
      });

      if (!upstream.ok || !upstream.body || !upstream.url.startsWith("https://")) {
        return json({
          success: false,
          error: "REMOTE_FILE_UNAVAILABLE",
          status: upstream.status
        }, 502);
      }

      const headers = new Headers();
      headers.set(
        "Content-Type",
        upstream.headers.get("Content-Type") || "application/octet-stream"
      );
      headers.set(
        "Content-Disposition",
        attachmentHeader(item.file_name || "OXIDE-iOS.ipa")
      );
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Accept-Ranges", upstream.headers.get("Accept-Ranges") || "none");

      const contentLength = upstream.headers.get("Content-Length");
      if (contentLength && /^\d+$/.test(contentLength)) {
        headers.set("Content-Length", contentLength);
      }

      if (upstream.status === 206) {
        const contentRange = upstream.headers.get("Content-Range");
        if (contentRange) headers.set("Content-Range", contentRange);
      }

      if (fileId && !fileId.startsWith("legacy-")) {
        await recordUniqueDownload(env, item.id, visitorId);
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers
      });
    }

    if (!item.file_key) {
      if (!item.download_url) {
        return json({ success: false, error: "FILE_NOT_FOUND" }, 404);
      }
      let externalUrl;
      try {
        externalUrl = new URL(String(item.download_url));
      } catch {
        return json({ success: false, error: "INVALID_DOWNLOAD_URL" }, 500);
      }
      if (externalUrl.protocol !== "https:") {
        return json({ success: false, error: "INVALID_DOWNLOAD_URL" }, 500);
      }
      if (fileId && !fileId.startsWith("legacy-")) {
        await recordUniqueDownload(env, item.id, visitorId);
      }
      return Response.redirect(externalUrl.toString(), 302);
    }

    const info = await env.DOWNLOADS_BUCKET.head(item.file_key);

    if (!info) {
      return json({
        success: false,
        error: "FILE_NOT_FOUND"
      }, 404);
    }

    const fileSize = Number(info.size);

    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      return json({
        success: false,
        error: "INVALID_FILE_SIZE"
      }, 500);
    }

    const headers = new Headers();

    headers.set(
      "Content-Type",
      "application/vnd.android.package-archive"
    );

    headers.set(
      "Content-Disposition",
      attachmentHeader(item.file_name)
    );

    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");

    const rangeHeader = request.headers.get("range");
    const range = parseRange(rangeHeader, fileSize);

    if (range && range.invalid) {
      headers.set("Content-Range", `bytes */${fileSize}`);

      return new Response(null, {
        status: 416,
        headers
      });
    }

    if (range) {
      const file = await env.DOWNLOADS_BUCKET.get(
        item.file_key,
        {
          range: {
            offset: range.start,
            length: range.length
          }
        }
      );

      if (!file) {
        return json({
          success: false,
          error: "FILE_NOT_FOUND"
        }, 404);
      }

      await recordUniqueDownload(env, fileId ? item.id : null, visitorId);

      headers.set("Content-Length", String(range.length));

      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${fileSize}`
      );

      return new Response(file.body, {
        status: 206,
        headers
      });
    }

    const file = await env.DOWNLOADS_BUCKET.get(item.file_key);

    if (!file) {
      return json({
        success: false,
        error: "FILE_NOT_FOUND"
      }, 404);
    }

    await recordUniqueDownload(env, fileId ? item.id : null, visitorId);

    headers.set("Content-Length", String(fileSize));

    return new Response(file.body, {
      status: 200,
      headers
    });

  } catch (error) {
    console.error("Download error:", error);

    return json({
      success: false,
      error: "DOWNLOAD_SERVER_ERROR"
    }, 500);
  }
}
