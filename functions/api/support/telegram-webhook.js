
import { json } from "../_lib/session.js";


async function createMissionNotification(env,userUuid,type,title,body,points=0){
  await env.DB.prepare(`
    INSERT INTO notifications
      (user_uuid,type,title,body,reward_points,created_at)
    VALUES(?,?,?,?,?,?)
  `).bind(userUuid,type,title,body,points,Math.floor(Date.now()/1000)).run();
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

async function adminMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text
  });
}


async function ensureNotificationsTable(DB) {
  // The current notifications table is provisioned by the D1 schema.
  await DB.prepare("SELECT id FROM notifications LIMIT 0").all();
}

async function ensureGiftSessions(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_gift_sessions (
      admin_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      target_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();
}

// أمر /gift: اختيار المستخدم ثم عدد النقاط، دون منحها مباشرة.
async function handleGiftMessage(message, env) {
  if (
    !message ||
    String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)
  ) return false;

  await ensureGiftSessions(env.DB);
  await ensureNotificationsTable(env.DB);
  const chatId = String(message.chat.id);
  const text = String(message.text || "").trim();

  if (/^\/gift(?:@\w+)?(?:\s|$)/i.test(text)) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      INSERT INTO telegram_gift_sessions
        (admin_id, stage, target_user_id, created_at, updated_at)
      VALUES (?, 'user', NULL, ?, ?)
      ON CONFLICT(admin_id) DO UPDATE SET
        stage = 'user',
        target_user_id = NULL,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).bind(chatId, now, now).run();

    await adminMessage(env, message.chat.id,
      "🎁 إدارة نقاط المستخدم\n\nأرسل الآن معرف المستخدم (UUID أو OX-XXXXXXXX).\nبعدها أرسل عدد النقاط: رقم موجب للإضافة، أو رقم سالب للخصم مثل -1000.\nلإلغاء العملية أرسل /cancel.");
    return true;
  }

  const session = await env.DB.prepare(`
    SELECT admin_id, stage, target_user_id
    FROM telegram_gift_sessions
    WHERE admin_id = ?
  `).bind(chatId).first();

  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    if (!session) return false;
    await env.DB.prepare("DELETE FROM telegram_gift_sessions WHERE admin_id = ?")
      .bind(chatId).run();
    await adminMessage(env, message.chat.id, "تم إلغاء إرسال الهدية.");
    return true;
  }

  if (!session) return false;
  if (!text || text.startsWith("/")) return false;

  if (session.stage === "user") {
    const raw = text.trim().toUpperCase();
    let user = null;

    if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(raw)) {
      user = await env.DB.prepare(`
        SELECT user_uuid AS user_id, points, created_at
        FROM users
        WHERE UPPER(user_uuid) = ?
        LIMIT 1
      `).bind(raw).first();
    } else {
      const prefix = raw.replace(/^OX-?/, "");
      if (!/^[0-9A-F]{8}$/.test(prefix)) {
        await adminMessage(env, message.chat.id,
          "⚠️ المعرف غير صحيح. أرسل UUID كاملًا أو OX- متبوعًا بثمانية أحرف/أرقام.");
        return true;
      }

      const matches = await env.DB.prepare(`
        SELECT user_uuid AS user_id, points, created_at
        FROM users
        WHERE UPPER(SUBSTR(REPLACE(user_uuid, '-', ''), 1, 8)) = ?
        LIMIT 2
      `).bind(prefix).all();

      if ((matches.results || []).length > 1) {
        await adminMessage(env, message.chat.id,
          "⚠️ هذا المعرف المختصر غير فريد. أرسل UUID الكامل للمستخدم.");
        return true;
      }
      user = matches.results?.[0] || null;
    }

    if (!user) {
      await adminMessage(env, message.chat.id,
        "❌ لم أجد هذا المستخدم. تحقق من المعرف وأرسله مجددًا.");
      return true;
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      UPDATE telegram_gift_sessions
      SET stage = 'points', target_user_id = ?, updated_at = ?
      WHERE admin_id = ?
    `).bind(user.user_id, now, chatId).run();

    const displayId = "OX-" + user.user_id.replace(/-/g, "").slice(0, 8).toUpperCase();
    await adminMessage(env, message.chat.id,
      "👤 تم العثور على المستخدم\n\n" +
      "🆔 المعرف: " + displayId + "\n" +
      "⭐ الرصيد الحالي: " + Number(user.points || 0).toLocaleString() + " نقطة\n" +
      "📅 التسجيل: " + (user.created_at ? new Date(Number(user.created_at) * 1000).toISOString() : "غير معروف") +
      "\n\nأرسل الآن مقدار التعديل: رقم موجب للإضافة أو رقم سالب للخصم، مثل 1000 أو -1000. الحد الأقصى 1,000,000 نقطة.\nلإلغاء العملية أرسل /cancel.");
    return true;
  }

  if (session.stage === "points") {
    if (!/^-?\d+$/.test(text) || text === "-0") {
      await adminMessage(env, message.chat.id,
        "⚠️ أرسل عددًا صحيحًا فقط. مثال للإضافة: 1000، وللخصم: -1000.");
      return true;
    }

    const amount = Number(text);
    if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) {
      await adminMessage(env, message.chat.id,
        "⚠️ يجب أن يكون العدد بين -1,000,000 و1,000,000، ولا يمكن أن يكون صفرًا.");
      return true;
    }

    const targetUserId = session.target_user_id;
    const now = Math.floor(Date.now() / 1000);
    const displayId = "OX-" + targetUserId.replace(/-/g, "").slice(0, 8).toUpperCase();

    if (amount > 0) {
      const title = "🎁 هدية نقاط من إدارة OXIDE HUB";
      const body = "أهدتك إدارة OXIDE HUB " + amount.toLocaleString() +
        " نقطة. اضغط زر استلام لإضافتها إلى رصيدك.";

      const results = await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO notifications
            (user_uuid, type, title, body, reward_points, created_at)
          SELECT target_user_id, 'reward', ?, ?, ?, ?
          FROM telegram_gift_sessions
          WHERE admin_id = ? AND stage = 'points' AND target_user_id = ?
        `).bind(title, body, amount, now, chatId, targetUserId),
        env.DB.prepare(`
          DELETE FROM telegram_gift_sessions
          WHERE admin_id = ? AND stage = 'points' AND target_user_id = ?
        `).bind(chatId, targetUserId)
      ]);

      const created = Number(results[0]?.meta?.changes || 0);
      if (created !== 1) {
        await adminMessage(env, message.chat.id,
          "⚠️ انتهت الجلسة أو لم يعد المستخدم محددًا. أرسل /gift للبدء من جديد.");
        return true;
      }

      await adminMessage(env, message.chat.id,
        "✅ تمت إضافة الهدية إلى إشعارات المستخدم.\n\n🆔 المستخدم: " +
        displayId + "\n🎁 الهدية: +" + amount.toLocaleString() +
        " نقطة\n\nسيستلمها المستخدم من صندوق الإشعارات.");
      return true;
    }

    const deduction = Math.abs(amount);
    const ledgerReference = "gift-" + chatId + "-" + now;
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE users
        SET points = points - ?, updated_at = ?
        WHERE user_uuid = ? AND status = 'active' AND points >= ?
      `).bind(deduction, now, targetUserId, deduction),
      env.DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid, delta, balance_after, reason, reference_type,
           reference_id, admin_telegram_id, created_at)
        SELECT user_uuid, ?, points, 'admin_points_deduction',
               'telegram_gift', ?, ?, ?
        FROM users
        WHERE user_uuid = ?
          AND changes() = 1
          AND EXISTS (
            SELECT 1 FROM telegram_gift_sessions
            WHERE admin_id = ? AND stage = 'points' AND target_user_id = ?
          )
      `).bind(-deduction, ledgerReference, chatId, now, targetUserId, chatId, targetUserId)
    ]);
    const updatedUser = Number(results[0]?.meta?.changes || 0) === 1
      ? await env.DB.prepare("SELECT points FROM users WHERE user_uuid = ?").bind(targetUserId).first()
      : null;

    if (!updatedUser) {
      const current = await env.DB.prepare("SELECT points FROM users WHERE user_uuid = ?")
        .bind(targetUserId).first();
      await adminMessage(env, message.chat.id,
        "❌ لا يمكن الخصم. رصيد المستخدم الحالي " +
        Number(current?.points || 0).toLocaleString() +
        " نقطة، وهو أقل من " + deduction.toLocaleString() + " نقطة.\nأرسل مبلغًا آخر أو /cancel.");
      return true;
    }

    try {
      await createMissionNotification(
        env,
        targetUserId,
        "points_adjustment",
        "➖ تم خصم نقاط من رصيدك",
        "قامت إدارة OXIDE HUB بخصم " + deduction.toLocaleString() +
          " نقطة من رصيدك. رصيدك الحالي: " +
          Number(updatedUser.points || 0).toLocaleString() + " نقطة."
      );
    } catch (error) {
      console.error("Could not create deduction notification", error);
      // The point adjustment remains recorded in point_ledger.
    }

    await env.DB.prepare(`
      DELETE FROM telegram_gift_sessions
      WHERE admin_id = ? AND stage = 'points' AND target_user_id = ?
    `).bind(chatId, targetUserId).run();

    await adminMessage(env, message.chat.id,
      "✅ تم خصم النقاط مباشرة وإرسال إشعار للمستخدم.\n\n🆔 المستخدم: " +
      displayId + "\n➖ المخصوم: " + deduction.toLocaleString() +
      " نقطة\n⭐ الرصيد المتبقي: " +
      Number(updatedUser.points || 0).toLocaleString() + " نقطة.");
    return true;
  }

  return false;
}

// مراجعة طلبات استبدال النقاط من تيليغرام
async function handleRedemptionCallback(callback, env) {
  const message = callback.message;
  if (!message || String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "غير مصرح لك بهذا الإجراء"
    });
    return;
  }

  const match = String(callback.data || "").match(/^oxide_redeem:(approve|reject):(\d+)$/);
  if (!match) return;

  const action = match[1];
  const orderId = Number(match[2]);
  const now = Math.floor(Date.now() / 1000);
  const order = await env.DB.prepare(`
    SELECT id, user_id, display_id, offer_name, points_cost, status
    FROM oxide_redemption_orders
    WHERE id = ?
    LIMIT 1
  `).bind(orderId).first();

  if (!order || order.status !== "pending") {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "الطلب غير موجود أو تمت مراجعته مسبقاً"
    });
    return;
  }

  let resultText = "";
  if (action === "approve") {
    const updated = await env.DB.prepare(`
      UPDATE oxide_redemption_orders
      SET status = 'approved', reviewed_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, orderId).run();

    if (Number(updated.meta?.changes || 0) !== 1) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "تمت مراجعة الطلب مسبقاً"
      });
      return;
    }

    try {
      await createMissionNotification(
        env, order.user_id, "redemption_approved",
        "✅ تمت الموافقة على طلب الاستبدال",
        "تم قبول طلبك رقم #" + orderId + " للعرض " +
          String(order.offer_name) + ". تم اعتماد الاستبدال من الإدارة."
      );
    } catch (error) {
      console.error("Redemption approval notification failed", error);
    }
    resultText = "✅ تمت الموافقة على طلب الاستبدال.";
  } else {
    const refundToken = crypto.randomUUID();
    const points = Math.max(0, Math.floor(Number(order.points_cost) || 0));
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE oxide_redemption_orders
        SET status = 'rejected', reviewed_at = ?, refund_token = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, refundToken, orderId),
      env.DB.prepare(`
        UPDATE users
        SET points = COALESCE(points, 0) + ?, updated_at = ?
        WHERE user_uuid = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM oxide_redemption_orders
            WHERE id = ? AND refund_token = ?
          )
      `).bind(points, now, order.user_id, orderId, refundToken),
      env.DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid, delta, balance_after, reason, reference_type,
           reference_id, admin_telegram_id, created_at)
        SELECT user_uuid, ?, points, 'redemption_refund',
               'redemption_order', ?, ?, ?
        FROM users
        WHERE user_uuid = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM oxide_redemption_orders
            WHERE id = ? AND refund_token = ?
          )
      `).bind(points, String(orderId), String(env.TELEGRAM_ADMIN_ID), now, order.user_id, orderId, refundToken)
    ]);

    if (Number(results[0]?.meta?.changes || 0) !== 1 ||
        Number(results[1]?.meta?.changes || 0) !== 1) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "تعذر إرجاع النقاط أو تمت مراجعة الطلب مسبقاً"
      });
      return;
    }

    try {
      await createMissionNotification(
        env, order.user_id, "redemption_rejected",
        "❌ تم رفض طلب الاستبدال",
        "تم رفض طلبك رقم #" + orderId + " للعرض " +
          String(order.offer_name) + " وإعادة " +
          points.toLocaleString() + " نقطة إلى رصيدك."
      );
    } catch (error) {
      console.error("Redemption rejection notification failed", error);
    }
    resultText = "❌ تم رفض الطلب وإعادة " + points.toLocaleString() + " نقطة للمستخدم.";
  }

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: action === "approve" ? "تمت الموافقة ✅" : "تم الرفض وإرجاع النقاط ❌"
  });
  await telegram(env, "editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: (message.text || "") + "\n\n" + resultText,
    reply_markup: { inline_keyboard: [] }
  });
}

// مراجعة المهام من أزرار تيليغرام
async function handleMissionCallback(callback, env) {
  const message = callback.message;
  if (!message || String(message.chat?.id) !== String(env.TELEGRAM_ADMIN_ID)) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "غير مصرح لك بهذا الإجراء"
    });
    return;
  }

  const match = String(callback.data || "").match(/^oxide_mission:(approve|reject):(\d+)$/);
  if (!match) return;

  const action = match[1];
  const submissionId = Number(match[2]);
  const now = Math.floor(Date.now() / 1000);

  const submission = await env.DB.prepare(`
    SELECT s.id, s.user_uuid, s.mission_id, s.status,
           m.title, m.reward_points
    FROM mission_submissions s
    JOIN missions m ON m.id = s.mission_id
    WHERE s.id = ?
    LIMIT 1
  `).bind(submissionId).first();

  if (!submission || submission.status !== "pending") {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "الطلب غير موجود أو تمت مراجعته مسبقاً"
    });
    return;
  }

  let resultText = "";
  if (action === "approve") {
    const reward = Math.max(0, Math.floor(Number(submission.reward_points) || 0));
    const user = await env.DB.prepare(`
      SELECT user_uuid FROM users
      WHERE user_uuid = ? AND status = 'active'
      LIMIT 1
    `).bind(submission.user_uuid).first();

    if (!user) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "المستخدم غير موجود أو غير نشط"
      });
      return;
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
        SET status = 'approved', reviewed_at = ?, reviewer_telegram_id = ?
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
          AND changes() = 1
          AND EXISTS (
            SELECT 1 FROM mission_submissions
            WHERE id = ? AND status = 'approved'
          )
      `).bind(reward, String(submissionId), String(env.TELEGRAM_ADMIN_ID), now, submission.user_uuid, submissionId)
    ]);

    if (
      Number(results[0]?.meta?.changes || 0) !== 1 ||
      Number(results[1]?.meta?.changes || 0) !== 1
    ) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "تعذر اعتماد الطلب أو تمت مراجعته مسبقاً"
      });
      return;
    }

    try {
      await createMissionNotification(
        env, submission.user_uuid, "mission_approved",
        "✅ تمت الموافقة على مهمتك",
        "تم قبول مهمة " + String(submission.title || "") +
          " وإضافة " + reward + " نقطة إلى رصيدك."
      );
    } catch (error) {
      console.error("Mission notification failed", error);
    }
    resultText = "✅ تمت الموافقة على المهمة وإضافة " + reward + " نقطة للمستخدم.";
  } else {
    const rejected = await env.DB.prepare(`
      UPDATE mission_submissions
      SET status = 'rejected', reviewed_at = ?, reviewer_telegram_id = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, String(env.TELEGRAM_ADMIN_ID), submissionId).run();

    if (Number(rejected.meta?.changes || 0) !== 1) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "تمت مراجعة الطلب مسبقاً"
      });
      return;
    }

    try {
      await createMissionNotification(
        env, submission.user_uuid, "mission_rejected",
        "❌ تم رفض إثبات المهمة",
        "لم يتم قبول إثبات مهمة " + String(submission.title || "") +
          ". راجع المطلوب وأرسل إثباتاً صحيحاً جديداً."
      );
    } catch (error) {
      console.error("Mission notification failed", error);
    }
    resultText = "❌ تم رفض المهمة. يمكن للمستخدم إرسال إثبات جديد.";
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
    SELECT id, user_uuid
    FROM support_conversations
    WHERE id = ?
    LIMIT 1
  `).bind(conversationId).first();
  if (!conversation) return;

  const text = String(message.text || message.caption || "").trim();
  if (!text) {
    await adminMessage(
      env,
      message.chat.id,
      "تنبيه: قاعدة البيانات الحالية تحفظ ردود الدعم النصية فقط. أرسل الرد كنص أو أضف شرحاً مكتوباً للمرفق."
    );
    return;
  }

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

    // أزرار مراجعة طلبات الاستبدال والمهام
    if (update.callback_query) {
      if (String(update.callback_query.data || "").startsWith("oxide_redeem:")) {
        await handleRedemptionCallback(update.callback_query, env);
      } else {
        await handleMissionCallback(update.callback_query, env);
      }
      return json({ success: true });
    }

    if (update.message) {
      // Handle point gifts and support replies. News management remains
      // disabled until its tables are added through a reviewed migration.
      const giftHandled = await handleGiftMessage(update.message, env);
      if (!giftHandled) {
        await handleSupportReply(update.message, env);
      }

      return json({ success: true });
    }

    return json({ success: true });

  } catch (error) {
    return json({ error: "Webhook processing failed" }, 500);
  }
}
