import { getVisitor, json } from "../_lib/session.js";

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) return json({ error: "NO_VISITOR_SESSION" }, 401);

    const body = await request.json();
    const message = String(body.message || "").trim();
    if (!message || message.length > 2000) {
      return json({ error: "INVALID_MESSAGE" }, 400);
    }

    const user = await env.DB.prepare(`
      SELECT user_uuid, public_id, points, created_at, status
      FROM users
      WHERE user_uuid = ?
      LIMIT 1
    `).bind(userId).first();

    if (!user || user.status !== "active") {
      return json({ error: "USER_NOT_AVAILABLE" }, 404);
    }

    const now = Math.floor(Date.now() / 1000);
    let conversation = await env.DB.prepare(`
      SELECT id
      FROM support_conversations
      WHERE user_uuid = ?
      ORDER BY id DESC
      LIMIT 1
    `).bind(userId).first();

    if (!conversation) {
      const created = await env.DB.prepare(`
        INSERT INTO support_conversations (user_uuid, status, created_at, updated_at)
        VALUES (?, 'open', ?, ?)
        RETURNING id
      `).bind(userId, now, now).first();
      conversation = created;
    }

    if (!conversation?.id) {
      return json({ error: "CONVERSATION_CREATE_FAILED" }, 500);
    }

    const recent = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM support_messages
      WHERE conversation_id = ?
        AND sender = 'user'
        AND created_at >= ?
    `).bind(conversation.id, now - 60).first();

    if (Number(recent?.total || 0) >= 5) {
      return json({ error: "SUPPORT_RATE_LIMIT" }, 429);
    }

    await env.DB.prepare(`
      INSERT INTO support_messages
        (conversation_id, sender, message_type, message_text, created_at)
      VALUES (?, 'user', 'text', ?, ?)
    `).bind(conversation.id, message, now).run();

    await env.DB.prepare(`
      UPDATE support_conversations
      SET updated_at = ?, status = 'open'
      WHERE id = ?
    `).bind(now, conversation.id).run();

    let notificationSent = false;
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_ID) {
      const displayId = user.public_id ||
        ("OX-" + userId.replace(/-/g, "").slice(0, 8).toUpperCase());
      const telegramText =
        "📩 OXIDE HUB SUPPORT\n\n" +
        "👤 User: " + displayId + "\n" +
        "🧵 Conversation: #" + conversation.id + "\n" +
        "🔎 Reply to this message to answer the user.\n\n" +
        "💬 Message:\n" + message;

      try {
        const response = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_ADMIN_ID,
              text: telegramText
            })
          }
        );
        const result = await response.json();
        notificationSent = Boolean(response.ok && result.ok);
      } catch (error) {
        console.error("Support Telegram notification failed:", error);
      }
    }

    return json({ success: true, saved: true, notificationSent });
  } catch (error) {
    console.error("Support send failed:", error);
    return json({ error: "SUPPORT_SEND_FAILED" }, 500);
  }
}
