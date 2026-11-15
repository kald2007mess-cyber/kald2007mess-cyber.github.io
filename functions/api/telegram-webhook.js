
import { json } from "./_lib/session.js";


async function createMissionNotification(env,userId,type,title,body,points=0){
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oxide_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',reward_points INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,read_at INTEGER,claimed_at INTEGER,claim_token TEXT)`).run();
 await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_oxide_notifications_user ON oxide_notifications(user_id, created_at DESC)`).run();
 await env.DB.prepare(`INSERT INTO oxide_notifications(user_id,type,title,body,reward_points,created_at) VALUES(?,?,?,?,?,?)`).bind(userId,type,title,body,points,Math.floor(Date.now()/1000)).run();
}

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


// Forward an administrator's Telegram reply to the matching website conversation.
async function handleSupportReply(message, env) {
  if (
    !message ||
    !message.reply_to_message ||
    String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)
  ) {
    return;
  }

  const originalMessageId = Number(message.reply_to_message.message_id);
  if (!originalMessageId) return;

  const original = await env.DB.prepare(`
    SELECT m.conversation_id, c.user_id
    FROM support_messages m
    JOIN support_conversations c ON c.id = m.conversation_id
    WHERE m.telegram_chat_id = ?
      AND m.telegram_message_id = ?
      AND m.sender = 'user'
    LIMIT 1
  `).bind(String(message.chat.id), originalMessageId).first();

  if (!original) return;

  const text = String(message.text || message.caption || "").trim();
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
      (conversation_id, sender, message_type, message_text, media_file_id, created_at)
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
  `).bind(now, original.conversation_id).run();
}

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.DB ||
      !env.TELEGRAM_BOT_TOKEN ||
      !env.TELEGRAM_ADMIN_ID ||
      !env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const suppliedSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return json({ error: "UNAUTHORIZED" }, 401);
    }

    const update = await request.json();

    // Support replies are normal Telegram messages, not callback queries.
    if (update.message) {
      await handleSupportReply(update.message, env);
      return json({ success: true });
    }

    const callback = update.callback_query;
    if (!callback) {
      return json({ success: true });
    }

    const message = callback.message;

    if (
      !message ||
      String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)
    ) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "غير مصرح لك بهذا الإجراء"
      });

      return json({ success: true });
    }

    const match = String(callback.data || "").match(
      /^oxide_mission:(approve|reject):(\d+)$/
    );

    if (!match) {
      return json({ success: true });
    }

    const action = match[1];
    const submissionId = Number(match[2]);
    const now = Math.floor(Date.now() / 1000);

    const submission = await env.DB.prepare(`
      SELECT
        s.id,
        s.user_id,
        s.mission_id,
        s.status,
        m.title,
        m.reward_points
      FROM mission_submissions s
      INNER JOIN oxide_admin_missions m
        ON m.id = s.mission_id
      WHERE s.id = ?
    `).bind(submissionId).first();

    if (!submission) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "الطلب أو المهمة غير موجودة"
      });

      return json({ success: true });
    }

    if (submission.status !== "pending") {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "تمت مراجعة هذا الطلب مسبقاً"
      });

      return json({ success: true });
    }

    let resultText = "";

    if (action === "approve") {
      const reward = Math.max(
        0,
        Math.floor(Number(submission.reward_points) || 0)
      );

      const user = await env.DB.prepare(`
        SELECT user_id
        FROM visitors
        WHERE user_id = ?
      `).bind(submission.user_id).first();

      if (!user) {
        await telegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "المستخدم غير موجود"
        });

        return json({ success: true });
      }

      const results = await env.DB.batch([
        env.DB.prepare(`
          UPDATE visitors
          SET points = points + ?
          WHERE user_id = ?
            AND EXISTS (
              SELECT 1
              FROM mission_submissions
              WHERE id = ?
                AND status = 'pending'
            )
        `).bind(reward, submission.user_id, submissionId),

        env.DB.prepare(`
          UPDATE mission_submissions
          SET status = 'approved',
              reviewed_at = ?
          WHERE id = ?
            AND status = 'pending'
        `).bind(now, submissionId)
      ]);

      const awarded = Number(results[0]?.meta?.changes || 0);
      const updated = Number(results[1]?.meta?.changes || 0);

      if (awarded !== 1 || updated !== 1) {
        return json({
          success: true,
          message: "Already reviewed"
        });
      }

      try{await createMissionNotification(env,submission.user_id,"mission_approved","✅ تمت الموافقة على مهمتك",`تم قبول مهمة ${submission.title} وإضافة ${reward} نقطة إلى رصيدك.`);}catch(error){console.error("Mission notification failed",error);}

      resultText =
        `✅ تمت الموافقة على مهمة ${submission.title}\n` +
        `🎁 تمت إضافة ${reward} نقطة للمستخدم.`;

    } else {
      const rejected = await env.DB.prepare(`
        UPDATE mission_submissions
        SET status = 'rejected',
            reviewed_at = ?
        WHERE id = ?
          AND status = 'pending'
      `).bind(now, submissionId).run();

      if (Number(rejected.meta?.changes || 0) !== 1) {
        return json({
          success: true,
          message: "Already reviewed"
        });
      }

      try{await createMissionNotification(env,submission.user_id,"mission_rejected","❌ تم رفض إثبات المهمة",`لم يتم قبول إثبات مهمة ${submission.title}. راجع المطلوب وأرسل إثباتًا صحيحًا جديدًا.`);}catch(error){console.error("Mission notification failed",error);}

      resultText =
        `❌ تم رفض مهمة ${submission.title}.\n` +
        "يمكن للمستخدم المحاولة مجدداً.";
    }

    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: action === "approve"
        ? "تمت الموافقة ✅"
        : "تم الرفض ❌"
    });

    const oldCaption = message.caption || "";

    await telegram(env, "editMessageCaption", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      caption: oldCaption + "\n\n" + resultText,
      reply_markup: { inline_keyboard: [] }
    });

    return json({ success: true });

  } catch (error) {
    return json({ error: "WEBHOOK_FAILED" }, 500);
  }
}
