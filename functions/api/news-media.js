
export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
      return new Response("Server configuration missing", { status: 500 });
    }

    const url = new URL(request.url);
    const postId = Number(url.searchParams.get("postId"));

    if (!Number.isInteger(postId) || postId < 1) {
      return new Response("Invalid post ID", { status: 400 });
    }

    const post = await env.DB.prepare(`
      SELECT media_type, media_file_id
      FROM news_posts
      WHERE id = ?
    `).bind(postId).first();

    if (!post || !post.media_file_id) {
      return new Response("Media not found", { status: 404 });
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(post.media_file_id)}`
    );

    if (!telegramResponse.ok) {
      return new Response("Telegram file lookup failed", { status: 502 });
    }

    const telegramData = await telegramResponse.json();

    if (!telegramData.ok || !telegramData.result?.file_path) {
      return new Response("Telegram file unavailable", { status: 502 });
    }

    const filePath = telegramData.result.file_path;

    // Only allow the expected Telegram media folders.
    if (
      !filePath.startsWith("photos/") &&
      !filePath.startsWith("videos/")
    ) {
      return new Response("Unsupported media", { status: 415 });
    }

    const mediaResponse = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`
    );

    if (!mediaResponse.ok || !mediaResponse.body) {
      return new Response("Media download failed", { status: 502 });
    }

    const contentType =
      post.media_type === "video" ? "video/mp4" : "image/jpeg";

    return new Response(mediaResponse.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff"
      }
    });

  } catch (error) {
    console.error("NEWS media error:", error);
    return new Response("Media service error", { status: 500 });
  }
}
