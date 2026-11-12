export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const postId = url.searchParams.get("id");

    if (!postId || !/^\d+$/.test(postId)) {
      return new Response("Invalid post ID", { status: 400 });
    }

    if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
      return new Response("Server configuration error", { status: 500 });
    }

    const post = await env.DB.prepare(
      "SELECT media_type, media_file_id FROM news_posts WHERE id = ?"
    )
      .bind(Number(postId))
      .first();

    if (!post) {
      return new Response("Media not found", { status: 404 });
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(post.media_file_id)}`
    );

    const telegramData = await telegramResponse.json();

    if (!telegramResponse.ok || !telegramData.ok || !telegramData.result?.file_path) {
      return new Response("Unable to retrieve media", { status: 502 });
    }

    const filePath = telegramData.result.file_path;

    const fileResponse = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`
    );

    if (!fileResponse.ok) {
      return new Response("Unable to download media", { status: 502 });
    }

    const contentType =
      post.media_type === "video"
        ? "video/mp4"
        : "image/jpeg";

    return new Response(fileResponse.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff"
      }
    });

  } catch (error) {
    console.error("News media error:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
