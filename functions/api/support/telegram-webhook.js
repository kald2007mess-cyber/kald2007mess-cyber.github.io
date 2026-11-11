
import { json } from "../_lib/session.js";

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.DB ||
      !env.TELEGRAM_ADMIN_ID ||
      !env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const secret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }

    const update = await request.json();
    const message = update.message;

    if (!message || !message.reply_to_message) {
      return json({ success: true });
    }

    // Only accept replies from the configured support admin chat.
    if (String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)) {
      return json({ error: "Unauthorized chat" }, 403);
    }

    const originalMessageId =
      message.reply_to_message.message_id;

    const original = await env.DB.prepare(`
      SELECT
        m.conversation_id,
        c.user_id
      FROM support_messages m
      JOIN support_conversations c
        ON c.id = m.conversation_id
      WHERE m.telegram_chat_id = ?
        AND m.telegram_message_id = ?
        AND m.sender = 'user'
      LIMIT 1
    `).bind(
      String(message.chat.id),
      originalMessageId
    ).first();

    if (!original) {
      return json({
        success: false,
        error: "Original support message not found"
      }, 404);
    }

    const text = String(
      message.text || message.caption || ""
    ).trim();

    const photo = message.photo?.length
      ? message.photo[message.photo.length - 1].file_id
      : null;

    const video = message.video?.file_id || null;

    let messageType = "text";
    let mediaFileId = null;

    if (photo) {
      messageType = "photo";
      mediaFileId = photo;
    } else if (video) {
      messageType = "video";
      mediaFileId = video;
    }

    if (!text && !mediaFileId) {
      return json({ success: true });
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO support_messages
      (
        conversation_id,
        sender,
        message_type,
        message_text,
        media_file_id,
        created_at
      )
      VALUES (?, 'admin', ?, ?, ?, ?)
    `).bind(
      original.conversation_id,
      messageType,
      text || null,
      mediaFileId,
      now
    ).run();

    await env.DB.prepare(`
      UPDATE support_conversations
      SET updated_at = ?, status = 'open'
      WHERE id = ?
    `).bind(
      now,
      original.conversation_id
    ).run();

    return json({ success: true });

  } catch {
    return json({ error: "Webhook processing failed" }, 500);
  }
}
