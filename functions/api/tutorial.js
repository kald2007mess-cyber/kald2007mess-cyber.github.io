const R2_PUBLIC_URL = "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };

  let start, end;
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
    if (!key.startsWith("tutorials/" + platform + "/") || key.includes("..") || key.includes("\\")) return null;
    return key;
  } catch {
    return null;
  }
}

async function handle({ request, env }) {
  try {
    if (!env.DB || !env.DOWNLOADS_BUCKET) {
      return new Response("Server configuration error", { status: 500 });
    }

    const platform = String(new URL(request.url).searchParams.get("platform") || "").toLowerCase();
    if (!["android", "ios", "beta"].includes(platform)) {
      return new Response("Invalid platform", { status: 400 });
    }

    const row = await env.DB.prepare(`
      SELECT video_url
      FROM platform_tutorials
      WHERE platform = ?
      LIMIT 1
    `).bind(platform).first();

    if (!row?.video_url) return new Response("Tutorial not found", { status: 404 });

    const key = keyFromUrl(row.video_url, platform);
    if (!key) {
      let external;
      try { external = new URL(String(row.video_url)); } catch {
        return new Response("Invalid tutorial URL", { status: 500 });
      }
      if (external.protocol !== "https:") return new Response("Invalid tutorial URL", { status: 500 });
      return Response.redirect(external.toString(), 302);
    }

    const info = await env.DOWNLOADS_BUCKET.head(key);
    if (!info || !Number.isSafeInteger(Number(info.size)) || Number(info.size) <= 0) {
      return new Response("Tutorial file not found", { status: 404 });
    }

    const size = Number(info.size);
    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });

    const range = parseRange(request.headers.get("range"), size);
    if (range?.invalid) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }

    const object = range
      ? await env.DOWNLOADS_BUCKET.get(key, {
          range: { offset: range.start, length: range.length }
        })
      : await env.DOWNLOADS_BUCKET.get(key);

    if (!object) return new Response("Tutorial file not found", { status: 404 });

    if (range) {
      headers.set("Content-Length", String(range.length));
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      return new Response(object.body, { status: 206, headers });
    }

    headers.set("Content-Length", String(size));
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    console.error("Tutorial API error:", error);
    return json({ success: false, error: "TUTORIAL_LOAD_FAILED" }, 500);
  }
}

export async function onRequestGet(context) {
  return handle(context);
}

export async function onRequestHead(context) {
  const response = await handle(context);
  return new Response(null, {
    status: response.status,
    headers: response.headers
  });
}
