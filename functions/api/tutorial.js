import { json } from "./_lib/session.js";
import { ensurePlatformTables } from "./_lib/platform-schema.js";

const R2_PUBLIC_URL = "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";
const ALLOWED_PLATFORMS = new Set(["android", "ios", "beta"]);

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || start >= size) return { invalid: true };
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

function keyFromUrl(value, platform) {
  try {
    const url = new URL(String(value || ""));
    if (url.origin !== R2_PUBLIC_URL) return null;
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!key.startsWith(`tutorials/${platform}/`) ||
        key.includes("..") || key.includes("\\")) return null;
    return key;
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.DOWNLOADS_BUCKET) {
      return json({ success: false, error: "SERVER_CONFIG" }, 500);
    }
    await ensurePlatformTables(env.DB);

    const url = new URL(request.url);
    const platform = String(url.searchParams.get("platform") || "").toLowerCase();
    if (!ALLOWED_PLATFORMS.has(platform)) {
      return json({ success: false, error: "INVALID_PLATFORM" }, 400);
    }

    const row = await env.DB.prepare(`
      SELECT video_url FROM platform_tutorials
      WHERE platform = ? LIMIT 1
    `).bind(platform).first();

    const key = keyFromUrl(row?.video_url, platform);
    if (!key) return json({ success: false, error: "TUTORIAL_NOT_FOUND" }, 404);

    const info = await env.DOWNLOADS_BUCKET.head(key);
    const size = Number(info?.size || 0);
    if (!info || !Number.isSafeInteger(size) || size <= 0) {
      return json({ success: false, error: "TUTORIAL_NOT_FOUND" }, 404);
    }

    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes"
    });

    const range = parseRange(request.headers.get("range"), size);
    if (range?.invalid) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }

    if (range) {
      const object = await env.DOWNLOADS_BUCKET.get(key, {
        range: { offset: range.start, length: range.length }
      });
      if (!object) return json({ success: false, error: "TUTORIAL_NOT_FOUND" }, 404);
      headers.set("Content-Length", String(range.length));
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      return new Response(object.body, { status: 206, headers });
    }

    const object = await env.DOWNLOADS_BUCKET.get(key);
    if (!object) return json({ success: false, error: "TUTORIAL_NOT_FOUND" }, 404);
    headers.set("Content-Length", String(size));
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    console.error("Tutorial proxy failed:", error);
    return json({ success: false, error: "TUTORIAL_PROXY_FAILED" }, 500);
  }
}
