
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

async function adminMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text
  });
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

// نشر الأخبار: المسؤول فقط
async function handleNewsMessage(message, env) {
  if (!message) return false;

  if (
    String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)
  ) {
    return false;
  }

  const chatId = message.chat.id;
  const text = String(message.text || "").trim();

  // بدء نشر خبر جديد
  if (/^\/news(?:@\w+)?(?:\s|$)/i.test(text)) {
    await env.DB.prepare(`
      INSERT INTO news_drafts (admin_id, stage, title, created_at)
      VALUES (?, 'title', NULL, ?)
      ON CONFLICT(admin_id) DO UPDATE SET
        stage = 'title',
        title = NULL,
        created_at = excluded.created_at
    `).bind(
      String(chatId),
      Math.floor(Date.now() / 1000)
    ).run();

    await adminMessage(
      env,
      chatId,
      "📰 نشر خبر جديد\n\nأرسل عنوان الخبر الآن."
    );

    return true;
  }

  // إلغاء عملية النشر
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    await env.DB.prepare(`
      DELETE FROM news_drafts WHERE admin_id = ?
    `).bind(String(chatId)).run();

    await adminMessage(env, chatId, "تم إلغاء نشر الخبر.");
    return true;
  }

  const draft = await env.DB.prepare(`
    SELECT admin_id, stage, title
    FROM news_drafts
    WHERE admin_id = ?
  `).bind(String(chatId)).first();

  if (!draft) return false;

  // استقبال عنوان الخبر
  if (draft.stage === "title") {
    if (!text || text.startsWith("/")) {
      await adminMessage(
        env,
        chatId,
        "⚠️ أرسل عنوان الخبر كنص، أو استخدم /cancel للإلغاء."
      );
      return true;
    }

    if (text.length > 250) {
      await adminMessage(
        env,
        chatId,
        "⚠️ العنوان طويل. الحد الأقصى 250 حرفاً."
      );
      return true;
    }

    await env.DB.prepare(`
      UPDATE news_drafts
      SET title = ?, stage = 'media'
      WHERE admin_id = ?
    `).bind(text, String(chatId)).run();

    await adminMessage(
      env,
      chatId,
      "✅ تم حفظ العنوان.\n\nأرسل صورة أو فيديو لنشر الخبر."
    );

    return true;
  }

  // استقبال الصورة أو الفيديو
  if (draft.stage === "media") {
    const photo = message.photo?.length
      ? message.photo[message.photo.length - 1].file_id
      : null;

    const video = message.video?.file_id || null;

    if (!photo && !video) {
      await adminMessage(
        env,
        chatId,
        "⚠️ أرسل صورة أو فيديو فقط، أو استخدم /cancel للإلغاء."
      );
      return true;
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO news_posts
      (title, media_type, media_file_id, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(
      draft.title,
      photo ? "photo" : "video",
      photo || video,
      now
    ).run();

    await env.DB.prepare(`
      DELETE FROM news_drafts
      WHERE admin_id = ?
    `).bind(String(chatId)).run();

    await adminMessage(
      env,
      chatId,
      "🎉 تم نشر الخبر بنجاح!\n\n📰 " + draft.title
    );

    return true;
  }

  return false;
}

// استقبال ردود الدعم من المسؤول
async function handleSupportReply(message, env) {
  if (!message || !message.reply_to_message) {
    return;
  }

  if (
    String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)
  ) {
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

    if (update.message) {
      // معالجة نشر الأخبار أولاً
      const handled = await handleNewsMessage(
        update.message,
        env
      );

      // إذا لم تكن رسالة نشر، نحافظ على نظام الدعم
      if (!handled) {
        await handleSupportReply(update.message, env);
      }

      return json({ success: true });
    }

    return json({ success: true });

  } catch (error) {
    return json({ error: "Webhook processing failed" }, 500);
  }
}
