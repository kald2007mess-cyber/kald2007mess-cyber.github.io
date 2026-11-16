
import { json } from "./_lib/session.js";


async function createMissionNotification(env,userId,type,title,body,points=0){
 await env.DB.prepare(`INSERT INTO notifications
   (user_uuid,type,title,body,reward_points,created_at)
   VALUES(?,?,?,?,?,?)`)
   .bind(userId,type,title,body,points,Math.floor(Date.now()/1000)).run();
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
  ) return;

  const repliedText = String(
    message.reply_to_message.text ||
    message.reply_to_message.caption ||
    ""
  );
  const match = repliedText.match(/(?:Conversation|المحادثة):\s*#?(\d+)/i);
  if (!match) return;

  const conversationId = Number(match[1]);
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) return;

  const conversation = await env.DB.prepare(`
    SELECT id FROM support_conversations WHERE id = ? LIMIT 1
  `).bind(conversationId).first();
  if (!conversation) return;

  const text = String(message.text || message.caption || "").trim();
  if (!text) return;

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO support_messages
      (conversation_id, sender, message_type, message_text, created_at)
    VALUES (?, 'admin', 'text', ?, ?)
  `).bind(conversationId, text, now).run();

  await env.DB.prepare(`
    UPDATE support_conversations
    SET updated_at = ?, status = 'open'
    WHERE id = ?
  `).bind(now, conversationId).run();
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
        s.user_uuid,
        s.mission_id,
        s.status,
        m.title,
        m.reward_points
      FROM mission_submissions s
      INNER JOIN missions m ON m.id = s.mission_id
      WHERE s.id = ?
      LIMIT 1
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
      const reward = Math.max(0, Math.floor(Number(submission.reward_points) || 0));
      const user = await env.DB.prepare(`
        SELECT user_uuid
        FROM users
        WHERE user_uuid = ? AND status = 'active'
        LIMIT 1
      `).bind(submission.user_uuid).first();

      if (!user) {
        await telegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "المستخدم غير موجود أو غير نشط"
        });
        return json({ success: true });
      }

      const results = await env.DB.batch([
        env.DB.prepare(`
          UPDATE users
          SET points = COALESCE(points, 0) + ?, updated_at = ?
          WHERE user_uuid = ? AND status = 'active'
            AND EXISTS (
              SELECT 1 FROM mission_submissions
              WHERE id = ? AND status = 'pending'
            )
        `).bind(reward, now, submission.user_uuid, submissionId),

        env.DB.prepare(`
          UPDATE mission_submissions
          SET status = 'approved',
              reviewed_at = ?,
              reviewer_telegram_id = ?
          WHERE id = ? AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM users
              WHERE user_uuid = ? AND status = 'active'
            )
        `).bind(now, String(env.TELEGRAM_ADMIN_ID), submissionId, submission.user_uuid),

        env.DB.prepare(`
          INSERT INTO point_ledger
            (user_uuid, delta, balance_after, reason, reference_type,
             reference_id, admin_telegram_id, created_at)
          SELECT user_uuid, ?, points, 'mission_approved',
                 'mission_submission', ?, ?, ?
          FROM users
          WHERE user_uuid = ?
            AND EXISTS (
              SELECT 1 FROM mission_submissions
              WHERE id = ? AND status = 'approved'
            )
        `).bind(reward, String(submissionId), String(env.TELEGRAM_ADMIN_ID), now, submission.user_uuid, submissionId)
      ]);

      const awarded = Number(results[0]?.meta?.changes || 0);
      const updated = Number(results[1]?.meta?.changes || 0);
      if (awarded !== 1 || updated !== 1) {
        return json({ success: true, message: "Already reviewed" });
      }

      try {
        await createMissionNotification(
          env,
          submission.user_uuid,
          "mission_approved",
          "✅ تمت الموافقة على مهمتك",
          `تم قبول مهمة ${submission.title} وإضافة ${reward} نقطة إلى رصيدك.`
        );
      } catch (error) {
        console.error("Mission notification failed", error);
      }

      resultText =
        `✅ تمت الموافقة على مهمة ${submission.title}\\n` +
        `🎁 تمت إضافة ${reward} نقطة للمستخدم.`;
    } else {
      const rejected = await env.DB.prepare(`
        UPDATE mission_submissions
        SET status = 'rejected',
            reviewed_at = ?,
            reviewer_telegram_id = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, String(env.TELEGRAM_ADMIN_ID), submissionId).run();

      if (Number(rejected.meta?.changes || 0) !== 1) {
        return json({ success: true, message: "Already reviewed" });
      }

      try {
        await createMissionNotification(
          env,
          submission.user_uuid,
          "mission_rejected",
          "❌ تم رفض إثبات المهمة",
          `لم يتم قبول إثبات مهمة ${submission.title}. راجع المطلوب وأرسل إثباتًا صحيحًا جديدًا.`
        );
      } catch (error) {
        console.error("Mission notification failed", error);
      }

      resultText =
        `❌ تم رفض مهمة ${submission.title}.\\n` +
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
