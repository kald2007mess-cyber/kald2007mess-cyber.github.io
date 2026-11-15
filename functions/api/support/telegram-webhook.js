
import { json } from "../_lib/session.js";


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

async function adminMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text
  });
}


async function ensureNotificationsTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      reward_points INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      claimed_at INTEGER,
      claim_token TEXT
    )
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_oxide_notifications_user
    ON oxide_notifications(user_id, created_at DESC)
  `).run();
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
        SELECT user_id, points, created_at
        FROM visitors
        WHERE UPPER(user_id) = ?
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
        SELECT user_id, points, created_at
        FROM visitors
        WHERE UPPER(SUBSTR(REPLACE(user_id, '-', ''), 1, 8)) = ?
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
          INSERT INTO oxide_notifications
            (user_id, type, title, body, reward_points, created_at)
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
    const updatedUser = await env.DB.prepare(`
      UPDATE visitors
      SET points = points - ?
      WHERE user_id = ? AND points >= ?
      RETURNING points
    `).bind(deduction, targetUserId, deduction).first();

    if (!updatedUser) {
      const current = await env.DB.prepare("SELECT points FROM visitors WHERE user_id = ?")
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
      await env.DB.prepare("UPDATE visitors SET points = points + ? WHERE user_id = ?")
        .bind(deduction, targetUserId).run();
      throw error;
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
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "غير مصرح لك بهذا الإجراء" });
    return;
  }
  const match = String(callback.data || "").match(/^oxide_redeem:(approve|reject):(\d+)$/);
  if (!match) return;
  const action = match[1];
  const orderId = Number(match[2]);
  const now = Math.floor(Date.now() / 1000);
  const order = await env.DB.prepare(`
    SELECT id, user_id, display_id, offer_name, points_cost, status
    FROM oxide_redemption_orders WHERE id = ?
  `).bind(orderId).first();
  if (!order || order.status !== "pending") {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "الطلب غير موجود أو تمت مراجعته مسبقًا" });
    return;
  }
  let resultText = "";
  if (action === "approve") {
    const updated = await env.DB.prepare(`
      UPDATE oxide_redemption_orders SET status = 'approved', reviewed_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, orderId).run();
    if (Number(updated.meta?.changes || 0) !== 1) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "تمت مراجعة الطلب مسبقًا" });
      return;
    }
    try {
      await createMissionNotification(env, order.user_id, "redemption_approved",
        "✅ تمت الموافقة على طلب الاستبدال",
        "تم قبول طلبك رقم #" + orderId + " للعرض " + String(order.offer_name) +
        ". تم اعتماد الاستبدال من الإدارة.");
    } catch (error) { console.error("Redemption approval notification failed", error); }
    resultText = "✅ تمت الموافقة على طلب الاستبدال.";
  } else {
    const refundToken = crypto.randomUUID();
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE oxide_redemption_orders SET status = 'rejected', reviewed_at = ?, refund_token = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, refundToken, orderId),
      env.DB.prepare(`
        UPDATE visitors SET points = points + (
          SELECT points_cost FROM oxide_redemption_orders WHERE id = ? AND refund_token = ?
        )
        WHERE user_id = (
          SELECT user_id FROM oxide_redemption_orders WHERE id = ? AND refund_token = ?
        )
        AND EXISTS (
          SELECT 1 FROM oxide_redemption_orders WHERE id = ? AND refund_token = ?
        )
      `).bind(orderId, refundToken, orderId, refundToken, orderId, refundToken)
    ]);
    const rejected = Number(results[0]?.meta?.changes || 0);
    const refunded = Number(results[1]?.meta?.changes || 0);
    if (rejected !== 1 || refunded !== 1) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "تعذر رفض الطلب أو تمت مراجعته مسبقًا" });
      return;
    }
    try {
      await createMissionNotification(env, order.user_id, "redemption_rejected",
        "❌ تم رفض طلب الاستبدال",
        "تم رفض طلبك رقم #" + orderId + " للعرض " + String(order.offer_name) +
        " وإعادة " + Number(order.points_cost).toLocaleString() +
        " نقطة إلى رصيدك.");
    } catch (error) { console.error("Redemption rejection notification failed", error); }
    resultText = "❌ تم رفض الطلب وإعادة " + Number(order.points_cost).toLocaleString() + " نقطة للمستخدم.";
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

    try{await createMissionNotification(env,submission.user_id,"mission_approved","✅ تمت الموافقة على مهمتك","تم قبول المهمة وإضافة 50 نقطة إلى رصيدك.");}catch(error){console.error("Mission notification failed",error);}
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

    try{await createMissionNotification(env,submission.user_id,"mission_rejected","❌ تم رفض إثبات المهمة","لم يتم قبول إثبات المهمة. راجع المطلوب وأرسل إثباتًا صحيحًا جديدًا.");}catch(error){console.error("Mission notification failed",error);}
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

// إدارة منشورات الأخبار من لوحة تيليغرام
async function ensureNewsAdminSessions(DB) {
  await DB.prepare("CREATE TABLE IF NOT EXISTS telegram_news_sessions (admin_id TEXT PRIMARY KEY, stage TEXT NOT NULL, post_id INTEGER, title TEXT, updated_at INTEGER NOT NULL)").run();
}

async function showNewsMenu(env, chatId, messageId = null) {
  const data = {
    chat_id: chatId,
    text: "📰 إدارة المنشورات\\n\\nاختر العملية التي تريد تنفيذها:",
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ إضافة منشور", callback_data: "oxide_news:add" }],
        [{ text: "✏️ تعديل منشور", callback_data: "oxide_news:list_edit" }],
        [{ text: "🗑 حذف منشور", callback_data: "oxide_news:list_delete" }],
        [{ text: "📋 عرض المنشورات", callback_data: "oxide_news:list" }]
      ]
    }
  };
  if (messageId) {
    data.message_id = messageId;
    await telegram(env, "editMessageText", data);
  } else {
    await telegram(env, "sendMessage", data);
  }
}

async function sendNewsPostList(env, chatId, messageId, mode) {
  const result = await env.DB.prepare(
    "SELECT id, title, created_at FROM news_posts ORDER BY created_at DESC LIMIT 10"
  ).all();
  const posts = result.results || [];
  if (!posts.length) {
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "لا توجد منشورات حاليًا.",
      reply_markup: { inline_keyboard: [[{ text: "⬅️ رجوع", callback_data: "oxide_news:menu" }]] }
    });
    return;
  }
  const keyboard = posts.map(function(post) {
    const title = String(post.title || "بدون عنوان").slice(0, 35);
    if (mode === "edit") {
      return [{ text: "✏️ #" + post.id + " " + title, callback_data: "oxide_news:edit:" + post.id }];
    }
    if (mode === "delete") {
      return [{ text: "🗑 #" + post.id + " " + title, callback_data: "oxide_news:delete:" + post.id }];
    }
    return [{ text: "📰 #" + post.id + " " + title, callback_data: "oxide_news:details:" + post.id }];
  });
  keyboard.push([{ text: "⬅️ رجوع", callback_data: "oxide_news:menu" }]);
  await telegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: "📋 أحدث المنشورات (آخر 10):\\nاختر منشورًا من القائمة:",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function handleNewsCallback(callback, env) {
  const message = callback.message;
  if (!message || String(message.chat && message.chat.id) !== String(env.TELEGRAM_ADMIN_ID)) {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "غير مصرح لك" });
    return;
  }
  await ensureNewsAdminSessions(env.DB);
  const data = String(callback.data || "");
  const chatId = String(message.chat.id);
  const messageId = message.message_id;

  if (data === "oxide_news:menu") {
    await showNewsMenu(env, chatId, messageId);
  } else if (data === "oxide_news:add") {
    await env.DB.prepare(
      "INSERT INTO telegram_news_sessions(admin_id,stage,post_id,title,updated_at) VALUES(?,'add_title',NULL,NULL,?) ON CONFLICT(admin_id) DO UPDATE SET stage='add_title',post_id=NULL,title=NULL,updated_at=excluded.updated_at"
    ).bind(chatId, Math.floor(Date.now() / 1000)).run();
    await telegram(env, "editMessageText", {
      chat_id: chatId, message_id: messageId,
      text: "➕ إضافة منشور جديد\\n\\nأرسل عنوان المنشور الآن.\\nللإلغاء أرسل /cancel.",
      reply_markup: { inline_keyboard: [[{ text: "⬅️ رجوع", callback_data: "oxide_news:menu" }]] }
    });
  } else if (data === "oxide_news:list_edit") {
    await sendNewsPostList(env, chatId, messageId, "edit");
  } else if (data === "oxide_news:list_delete") {
    await sendNewsPostList(env, chatId, messageId, "delete");
  } else if (data === "oxide_news:list") {
    await sendNewsPostList(env, chatId, messageId, "view");
  } else {
    const editMatch = data.match(/^oxide_news:edit:(\\d+)$/);
    const deleteMatch = data.match(/^oxide_news:delete:(\\d+)$/);
    const detailsMatch = data.match(/^oxide_news:details:(\\d+)$/);
    if (editMatch) {
      const postId = Number(editMatch[1]);
      const post = await env.DB.prepare("SELECT id,title FROM news_posts WHERE id=?").bind(postId).first();
      if (!post) {
        await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "المنشور غير موجود" });
        return;
      }
      await env.DB.prepare(
        "INSERT INTO telegram_news_sessions(admin_id,stage,post_id,title,updated_at) VALUES(?,'edit_title',?,?,?) ON CONFLICT(admin_id) DO UPDATE SET stage='edit_title',post_id=excluded.post_id,title=excluded.title,updated_at=excluded.updated_at"
      ).bind(chatId, postId, post.title, Math.floor(Date.now() / 1000)).run();
      await telegram(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: "✏️ تعديل المنشور #" + postId + "\\nالعنوان الحالي: " + post.title + "\\n\\nأرسل العنوان الجديد، أو /skip للإبقاء عليه. بعد ذلك يمكنك تغيير الصورة/الفيديو أو تخطيها.",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ رجوع", callback_data: "oxide_news:list_edit" }]] }
      });
    } else if (deleteMatch) {
      const postId = Number(deleteMatch[1]);
      const post = await env.DB.prepare("SELECT id,title FROM news_posts WHERE id=?").bind(postId).first();
      if (!post) {
        await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "المنشور غير موجود" });
        return;
      }
      await telegram(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: "⚠️ هل تريد حذف هذا المنشور نهائيًا؟\\n\\n#" + post.id + " — " + post.title + "\\nسيتم حذف التعليقات والتفاعلات المرتبطة به أيضًا.",
        reply_markup: { inline_keyboard: [
          [{ text: "نعم، احذف المنشور", callback_data: "oxide_news:confirm_delete:" + postId }],
          [{ text: "إلغاء", callback_data: "oxide_news:list_delete" }]
        ]}
      });
    } else if (data.match(/^oxide_news:confirm_delete:(\\d+)$/)) {
      const postId = Number(data.match(/^oxide_news:confirm_delete:(\\d+)$/)[1]);
      const post = await env.DB.prepare("SELECT id FROM news_posts WHERE id=?").bind(postId).first();
      if (!post) {
        await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "المنشور محذوف أو غير موجود" });
        return;
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM news_comments WHERE post_id=?").bind(postId),
        env.DB.prepare("DELETE FROM news_reactions WHERE post_id=?").bind(postId),
        env.DB.prepare("DELETE FROM news_posts WHERE id=?").bind(postId)
      ]);
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "تم حذف المنشور" });
      await telegram(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: "🗑 تم حذف المنشور #" + postId + " والتعليقات والتفاعلات المرتبطة به.",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ إدارة المنشورات", callback_data: "oxide_news:menu" }]] }
      });
      return;
    } else if (detailsMatch) {
      const postId = Number(detailsMatch[1]);
      const post = await env.DB.prepare("SELECT id,title,media_type,views,created_at FROM news_posts WHERE id=?").bind(postId).first();
      if (!post) {
        await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "المنشور غير موجود" });
        return;
      }
      await telegram(env, "editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: "📰 المنشور #" + post.id + "\\nالعنوان: " + post.title + "\\nالوسائط: " + post.media_type + "\\nالمشاهدات: " + Number(post.views || 0) + "\\nالتاريخ: " + new Date(Number(post.created_at) * 1000).toLocaleString("ar"),
        reply_markup: { inline_keyboard: [[{ text: "⬅️ رجوع", callback_data: "oxide_news:menu" }]] }
      });
    }
  }
  await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
}

async function handleNewsMessage(message, env) {
  if (!message || String(message.chat && message.chat.id) !== String(env.TELEGRAM_ADMIN_ID)) return false;
  await ensureNewsAdminSessions(env.DB);
  const chatId = String(message.chat.id);
  const text = String(message.text || "").trim();

  if (/^\\/(?:news|posts)(?:@\\w+)?$/i.test(text)) {
    await showNewsMenu(env, chatId);
    return true;
  }
  if (/^\\/cancel(?:@\\w+)?$/i.test(text)) {
    await env.DB.prepare("DELETE FROM telegram_news_sessions WHERE admin_id=?").bind(chatId).run();
    await adminMessage(env, chatId, "تم إلغاء العملية.");
    return true;
  }

  const session = await env.DB.prepare(
    "SELECT admin_id,stage,post_id,title FROM telegram_news_sessions WHERE admin_id=?"
  ).bind(chatId).first();
  if (!session) return false;

  if (session.stage === "add_title") {
    if (!text || text.startsWith("/") || text.length > 250) {
      await adminMessage(env, chatId, "⚠️ أرسل عنوانًا من 1 إلى 250 حرفًا، أو /cancel.");
      return true;
    }
    await env.DB.prepare("UPDATE telegram_news_sessions SET stage='add_media',title=?,updated_at=? WHERE admin_id=?")
      .bind(text, Math.floor(Date.now() / 1000), chatId).run();
    await adminMessage(env, chatId, "✅ تم حفظ العنوان. أرسل صورة أو فيديو للمنشور.");
    return true;
  }

  if (session.stage === "add_media") {
    const photo = message.photo && message.photo.length ? message.photo[message.photo.length - 1].file_id : null;
    const video = message.video && message.video.file_id ? message.video.file_id : null;
    if (!photo && !video) {
      await adminMessage(env, chatId, "⚠️ أرسل صورة أو فيديو، أو /cancel للإلغاء.");
      return true;
    }
    const now = Math.floor(Date.now() / 1000);
    const inserted = await env.DB.prepare(
      "INSERT INTO news_posts(title,media_type,media_file_id,created_at) VALUES(?,?,?,?)"
    ).bind(session.title, photo ? "photo" : "video", photo || video, now).run();
    await env.DB.prepare("DELETE FROM telegram_news_sessions WHERE admin_id=?").bind(chatId).run();
    await adminMessage(env, chatId, "🎉 تم نشر المنشور بنجاح!\\n🆔 رقم المنشور: " + Number(inserted.meta && inserted.meta.last_row_id || 0) + "\\n📰 " + session.title);
    return true;
  }

  if (session.stage === "edit_title") {
    let title = session.title;
    if (text !== "/skip") {
      if (!text || text.startsWith("/") || text.length > 250) {
        await adminMessage(env, chatId, "⚠️ أرسل عنوانًا من 1 إلى 250 حرفًا، أو /skip للإبقاء على الحالي.");
        return true;
      }
      title = text;
      await env.DB.prepare("UPDATE news_posts SET title=? WHERE id=?").bind(title, session.post_id).run();
    }
    await env.DB.prepare("UPDATE telegram_news_sessions SET stage='edit_media',title=?,updated_at=? WHERE admin_id=?")
      .bind(title, Math.floor(Date.now() / 1000), chatId).run();
    await adminMessage(env, chatId, "✅ تم التعامل مع العنوان. أرسل صورة/فيديو جديدًا لتغيير الوسائط، أو /skip للإبقاء على الوسائط الحالية.");
    return true;
  }

  if (session.stage === "edit_media") {
    if (text === "/skip") {
      await env.DB.prepare("DELETE FROM telegram_news_sessions WHERE admin_id=?").bind(chatId).run();
      await adminMessage(env, chatId, "✅ تم حفظ تعديلات المنشور #" + session.post_id + ".");
      return true;
    }
    const photo = message.photo && message.photo.length ? message.photo[message.photo.length - 1].file_id : null;
    const video = message.video && message.video.file_id ? message.video.file_id : null;
    if (!photo && !video) {
      await adminMessage(env, chatId, "⚠️ أرسل صورة أو فيديو جديدًا، أو /skip للإبقاء على الوسائط الحالية.");
      return true;
    }
    await env.DB.prepare("UPDATE news_posts SET media_type=?,media_file_id=? WHERE id=?")
      .bind(photo ? "photo" : "video", photo || video, session.post_id).run();
    await env.DB.prepare("DELETE FROM telegram_news_sessions WHERE admin_id=?").bind(chatId).run();
    await adminMessage(env, chatId, "✅ تم تحديث المنشور #" + session.post_id + " بنجاح.");
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

    // أزرار إدارة المنشورات وطلبات الاستبدال والمهام
    if (update.callback_query) {
      const callbackData = String(update.callback_query.data || "");
      if (callbackData.startsWith("oxide_news:")) {
        await handleNewsCallback(update.callback_query, env);
      } else if (callbackData.startsWith("oxide_redeem:")) {
        await handleRedemptionCallback(update.callback_query, env);
      } else {
        await handleMissionCallback(update.callback_query, env);
      }
      return json({ success: true });
    }

    if (update.message) {
      // أمر إرسال هدايا النقاط أولاً، ثم نشر الأخبار، ثم الدعم.
      const giftHandled = await handleGiftMessage(update.message, env);
      if (!giftHandled) {
        const newsHandled = await handleNewsMessage(update.message, env);
        if (!newsHandled) {
          await handleSupportReply(update.message, env);
        }
      }

      return json({ success: true });
    }

    return json({ success: true });

  } catch (error) {
    return json({ error: "Webhook processing failed" }, 500);
  }
}
