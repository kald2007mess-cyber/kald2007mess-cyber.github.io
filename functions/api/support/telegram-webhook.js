
import { json } from "../_lib/session.js";

async function telegram(env, method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  return await response.json();
}

// مراجعة المهام من أزرار تيليغرام
async function handleMissionCallback(callback, env) {
  const message = callback.message;

  if (
    !message ||
    String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)
  ) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "غير مصرح لك بهذا الإجراء"
    });
    return;
  }

  const match = String(callback.data || "").match(
    /^oxide_mission:(approve|reject):(\d+)$/
  );

  if (!match) return;

  const action = match[1];
  const submissionId = Number(match[2]);
  const now = Math.floor(Date.now() / 1000);

  const submission = await env.DB.prepare(`
    SELECT id, user_id, mission_id, status
    FROM mission_submissions
    WHERE id = ?
  `).bind(submissionId).first();

  if (!submission || Number(submission.mission_id) !== 1) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "الطلب غير موجود"
    });
    return;
  }

  if (submission.status !== "pending") {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "تمت مراجعة هذا الطلب مسبقاً"
    });
    return;
  }

  let resultText = "";

  if (action === "approve") {
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE visitors
        SET points = points + 50
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1
            FROM mission_submissions
            WHERE id = ? AND status = 'pending'
          )
      `).bind(submission.user_id, submissionId),

      env.DB.prepare(`
        UPDATE mission_submissions
        SET status = 'approved', reviewed_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, submissionId)
    ]);

    const awarded = Number(results[0]?.meta?.changes || 0);
    const updated = Number(results[1]?.meta?.changes || 0);

    if (awarded !== 1 || updated !== 1) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "تمت مراجعة الطلب مسبقاً"
      });
      return;
    }

    resultText = "✅ تمت الموافقة وإضافة 50 نقطة للمستخدم.";
  } else {
    const rejected = await env.DB.prepare(`
      UPDATE mission_submissions
      SET status = 'rejected', reviewed_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, submissionId).run();

    if (Number(rejected.meta?.changes || 0) !== 1) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "تمت مراجعة الطلب مسبقاً"
      });
      return;
    }

    resultText = "❌ تم رفض المهمة. يمكن للمستخدم المحاولة مجدداً.";
  }

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: action === "approve" ? "تمت الموافقة ✅" : "تم الرفض ❌"
  });

  await telegram(env, "editMessageCaption", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    caption: (message.caption || "") + "\n\n" + resultText,
    reply_markup: { inline_keyboard: [] }
  });
}

// استقبال ردود الدعم من المسؤول
async function handleSupportReply(message, env) {
  if (!message || !message.reply_to_message) {
    return;
  }

  if (String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)) {
    return;
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

  if (!original) return;

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

  if (!text && !mediaFileId) return;

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
}

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.DB ||
      !env.TELEGRAM_ADMIN_ID ||
      !env.TELEGRAM_WEBHOOK_SECRET ||
      !env.TELEGRAM_BOT_TOKEN
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

    // أزرار الموافقة والرفض
    if (update.callback_query) {
      await handleMissionCallback(update.callback_query, env);
      return json({ success: true });
    }

    // ردود الدعم
    if (update.message) {
      await handleSupportReply(update.message, env);
      return json({ success: true });
    }

    return json({ success: true });

  } catch (error) {
    return json({ error: "Webhook processing failed" }, 500);
  }
}
