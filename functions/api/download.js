
import { json, getVisitor } from "./_lib/session.js";

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;

  // We support one byte range only.
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

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.DOWNLOADS_BUCKET) {
      return json({
        success: false,
        error: "SERVER_CONFIG"
      }, 500);
    }

    // Check visitor identity.
    const visitorId = await getVisitor(request, env);

    if (!visitorId) {
      return json({
        success: false,
        error: "VISITOR_NOT_FOUND"
      }, 401);
    }

    // Keep the existing requirement: 3 completed ads.
    const visitor = await env.DB.prepare(`
      SELECT progress
      FROM visitors
      WHERE user_id = ?
    `).bind(visitorId).first();

    if (!visitor || Number(visitor.progress || 0) < 3) {
      return json({
        success: false,
        error: "AD_PROGRESS_REQUIRED",
        required: 3
      }, 403);
    }

    const url = new URL(request.url);
    const platform = (
      url.searchParams.get("platform") || ""
    ).toLowerCase();

    if (!["android", "ios", "beta"].includes(platform)) {
      return json({
        success: false,
        error: "INVALID_PLATFORM"
      }, 400);
    }

    const item = await env.DB.prepare(`
      SELECT *
      FROM platform_downloads
      WHERE platform = ?
        AND enabled = 1
      LIMIT 1
    `).bind(platform).first();

    if (!item) {
      return json({
        success: false,
        error: "NOT_AVAILABLE"
      }, 404);
    }

    // iOS uses its external download URL.
    if (platform === "ios") {
      if (!item.download_url) {
        return json({
          success: false,
          error: "DOWNLOAD_URL_MISSING"
        }, 404);
      }

      return Response.redirect(item.download_url, 302);
    }

    if (!item.file_key) {
      return json({
        success: false,
        error: "FILE_NOT_FOUND"
      }, 404);
    }

    // Read object metadata without downloading its contents.
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

    // Invalid or unsupported range.
    if (range && range.invalid) {
      headers.set("Content-Range", `bytes */${fileSize}`);

      return new Response(null, {
        status: 416,
        headers
      });
    }

    // Partial download / resume.
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

    // Full download: stream directly from R2.
    const file = await env.DOWNLOADS_BUCKET.get(item.file_key);

    if (!file) {
      return json({
        success: false,
        error: "FILE_NOT_FOUND"
      }, 404);
    }

    headers.set("Content-Length", String(fileSize));

    return new Response(file.body, {
      status: 200,
      headers
    });

  } catch (error) {
    return json({
      success: false,
      error: "DOWNLOAD_SERVER_ERROR"
    }, 500);
  }
}
