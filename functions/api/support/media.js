import { getVisitor, json } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN) {
      return new Response("Server configuration error", { status: 500 });
    }

    const userId = await getVisitor(request, env);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));

    if (!Number.isSafeInteger(id) || id < 1) {
      return new Response("Invalid message ID", { status: 400 });
    }

    const message = await env.DB.prepare(`
      SELECT m.message_type, m.media_file_id
      FROM support_messages m
      INNER JOIN support_conversations c
        ON c.id = m.conversation_id
      WHERE m.id = ?
        AND c.user_id = ?
        AND m.sender IN ('user', 'admin', 'support')
      LIMIT 1
    `).bind(id, userId).first();

    if (!message || !message.media_file_id) {
      return new Response("Media not found", { status: 404 });
    }

    const isVideo = message.message_type === "video";
    if (!isVideo && message.message_type !== "photo") {
      return new Response("Unsupported media type", { status: 415 });
    }

    const fileInfoResponse = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(message.media_file_id)}`
    );
    const fileInfo = await fileInfoResponse.json();

    if (
      !fileInfoResponse.ok ||
      !fileInfo.ok ||
      !fileInfo.result?.file_path ||
      !/^[A-Za-z0-9_./-]+$/.test(fileInfo.result.file_path)
    ) {
      return new Response("Unable to retrieve media", { status: 502 });
    }

    const fileResponse = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`
    );

    if (!fileResponse.ok || !fileResponse.body) {
      return new Response("Unable to download media", { status: 502 });
    }

    return new Response(fileResponse.body, {
      status: 200,
      headers: {
        "Content-Type": isVideo ? "video/mp4" : "image/jpeg",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    console.error("Support media error:", error);
    return json({ success: false, error: "SUPPORT_MEDIA_FAILED" }, 500);
  }
}
