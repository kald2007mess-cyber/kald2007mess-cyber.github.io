
import { json, getVisitor } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    const visitorId = await getVisitor(request, env);

    if (!visitorId) {
      return json({ success: false, error: "VISITOR_NOT_FOUND" }, 401);
    }

    // التحقق من إكمال 3 إعلانات
    const visitor = await env.DB.prepare(
      "SELECT progress FROM visitors WHERE user_id = ?"
    ).bind(visitorId).first();

    if (!visitor || Number(visitor.progress || 0) < 3) {
      return json({
        success: false,
        error: "AD_PROGRESS_REQUIRED",
        required: 3
      }, 403);
    }

    const url = new URL(request.url);
    const platform = (url.searchParams.get("platform") || "").toLowerCase();

    if (!["android", "ios", "beta"].includes(platform)) {
      return json({ success: false, error: "INVALID_PLATFORM" }, 400);
    }

    const item = await env.DB.prepare(
      "SELECT * FROM platform_downloads WHERE platform = ? AND enabled = 1"
    ).bind(platform).first();

    if (!item) {
      return json({ success: false, error: "NOT_AVAILABLE" }, 404);
    }

    // iOS: تحويل إلى رابط خارجي
    if (platform === "ios") {
      if (!item.download_url) {
        return json({ success: false, error: "DOWNLOAD_URL_MISSING" }, 404);
      }

      return Response.redirect(item.download_url, 302);
    }

    // Android و BETA: تحميل الملف من R2
    if (!item.file_key) {
      return json({ success: false, error: "FILE_NOT_FOUND" }, 404);
    }

    const file = await env.DOWNLOADS_BUCKET.get(item.file_key);

    if (!file) {
      return json({ success: false, error: "FILE_NOT_FOUND" }, 404);
    }

    const headers = new Headers();
    headers.set(
      "Content-Type",
      file.httpMetadata?.contentType || "application/vnd.android.package-archive"
    );
    headers.set(
      "Content-Disposition",
      `attachment; filename="${item.file_name || "OXIDE-HUB.apk"}"`
    );
    headers.set("Cache-Control", "no-store");

    if (file.size) {
      headers.set("Content-Length", String(file.size));
    }

    return new Response(file.body, {
      status: 200,
      headers
    });

  } catch (error) {
    return json({
      success: false,
      error: "SERVER_ERROR"
    }, 500);
  }
}
