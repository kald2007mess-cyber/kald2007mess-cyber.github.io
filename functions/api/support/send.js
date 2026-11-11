
import { getVisitor, json } from "../_lib/session.js";

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.DB ||
      !env.SESSION_SECRET ||
      !env.TELEGRAM_BOT_TOKEN ||
      !env.TELEGRAM_ADMIN_ID
    ) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "No visitor session" }, 401);
    }

    const body = await request.json();
    const message = String(body.message || "").trim();

    if (!message || message.length > 2000) {
      return json({ error: "Invalid message" }, 400);
    }

    const user = await env.DB.prepare(`
      SELECT
        v.user_id,
        v.points,
        v.progress,
        v.created_at,
        COALESCE(r.completed_ads, 0) AS island_ads,
        (
          SELECT COUNT(*)
          FROM offerwall_events e
          WHERE e.user_id = v.user_id
            AND e.status = 1
            AND e.offer_type = 'ptc'
        ) AS ptc_ads
      FROM visitors v
      LEFT JOIN reward_ad_cycles r
        ON r.user_id = v.user_id
      WHERE v.user_id = ?
    `).bind(userId).first();

    if (!user) {
      return json({ error: "User not found" }, 404);
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT OR IGNORE INTO support_conversations
      (user_id, status, created_at, updated_at)
      VALUES (?, 'open', ?, ?)
    `).bind(userId, now, now).run();

    const conversation = await env.DB.prepare(`
      SELECT id
      FROM support_conversations
      WHERE user_id = ?
    `).bind(userId).first();

    if (!conversation) {
      return json({ error: "Conversation creation failed" }, 500);
    }

    const saved = await env.DB.prepare(`
      INSERT INTO support_messages
      (conversation_id, sender, message_type, message_text, created_at)
      VALUES (?, 'user', 'text', ?, ?)
    `).bind(conversation.id, message, now).run();

    const displayId =
      "OX-" + userId.replace(/-/g, "").slice(0, 8).toUpperCase();

    const telegramText =
      "📩 OXIDE HUB SUPPORT\n\n" +
      "👤 User: " + displayId + "\n" +
      "🆔 ID: " + userId + "\n\n" +
      "💬 Message:\n" + message + "\n\n" +
      "📊 ACCOUNT INFORMATION\n" +
      "⭐ Points: " + Number(user.points || 0) + "\n" +
      "🎬 OXIDE HUB PTC completed: " + Number(user.ptc_ads || 0) + "\n" +
      "🏝️ OXIDE ISLAND completed: " + Number(user.island_ads || 0) + "\n" +
      "📈 Current progress: " + Number(user.progress || 0) + "/3\n" +
      "📅 Registration: " +
      (user.created_at
        ? new Date(Number(user.created_at) * 1000).toISOString()
        : "Unknown") +
      "\n\n↩️ Reply to this message to answer the user.";

    const telegramResponse = await fetch(
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

    const telegramResult = await telegramResponse.json();

    if (!telegramResponse.ok || !telegramResult.ok) {
      return json({
        error: "Telegram delivery failed",
        saved: true
      }, 502);
    }

    await env.DB.prepare(`
      UPDATE support_messages
      SET telegram_chat_id = ?,
          telegram_message_id = ?
      WHERE id = ?
    `).bind(
      String(telegramResult.result.chat.id),
      telegramResult.result.message_id,
      saved.meta.last_row_id
    ).run();

    await env.DB.prepare(`
      UPDATE support_conversations
      SET updated_at = ?, status = 'open'
      WHERE id = ?
    `).bind(now, conversation.id).run();

    return json({
      success: true,
      message: "Message sent"
    });

  } catch (error) {
    return json({ error: "Could not send support message" }, 500);
  }
}
