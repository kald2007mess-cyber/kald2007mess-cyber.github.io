
async function sendMessage(env, chatId, message) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    }
  );

  return response.ok;
}

// Website connection test
export async function onRequestGet() {
  return Response.json({
    status: "online",
    project: "OXIDE HUB",
    telegram: "endpoint ready"
  });
}

// Telegram commands
export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.DB ||
      !env.TELEGRAM_BOT_TOKEN ||
      !env.TELEGRAM_ADMIN_ID ||
      !env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Configuration missing", {
        status: 503
      });
    }

    const secret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", {
        status: 403
      });
    }

    const update = await request.json();
    const message = update.message;

    if (!message?.text || !message.chat?.id) {
      return new Response("ok");
    }

    if (
      String(message.from?.id) !==
      String(env.TELEGRAM_ADMIN_ID)
    ) {
      return new Response("ok");
    }

    const chatId = message.chat.id;
    const command = message.text
      .trim()
      .split(/\s+/)[0]
      .split("@")[0]
      .toLowerCase();

    if (command === "/start") {
      await sendMessage(
        env,
        chatId,
        "🚀 مرحبًا بك في لوحة إدارة OXIDE HUB!\n\n" +
        "📊 الأوامر المتاحة:\n" +
        "/stats - إحصائيات الموقع\n" +
        "/visitors - عدد الزوار\n" +
        "/rewards - مجموع المكافآت"
      );
    }

    else if (command === "/stats") {
      const visitors = await env.DB.prepare(`
        SELECT COUNT(*) AS total FROM visitors
      `).first();

      const ads = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM offerwall_events
        WHERE status = 1
      `).first();

      const ptc = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM offerwall_events
        WHERE status = 1 AND offer_type = 'ptc'
      `).first();

      const rewards = await env.DB.prepare(`
        SELECT COALESCE(SUM(reward), 0) AS total
        FROM offerwall_events
        WHERE status = 1
      `).first();

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const todayStart = Math.floor(
        today.getTime() / 1000
      );

      const todayVisitors = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM visitors
        WHERE created_at >= ?
      `).bind(todayStart).first();

      const todayAds = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM offerwall_events
        WHERE status = 1 AND created_at >= ?
      `).bind(todayStart).first();

      await sendMessage(
        env,
        chatId,
        "📊 OXIDE HUB STATISTICS\n\n" +
        `👥 إجمالي الزوار: ${visitors.total}\n` +
        `🆕 زوار اليوم: ${todayVisitors.total}\n\n` +
        `📺 الإعلانات المؤكدة: ${ads.total}\n` +
        `🎯 إعلانات PTC: ${ptc.total}\n` +
        `📅 إعلانات اليوم: ${todayAds.total}\n\n` +
        `💰 مجموع المكافآت: ${Number(rewards.total).toFixed(2)}`
      );
    }

    else if (command === "/visitors") {
      const result = await env.DB.prepare(`
        SELECT COUNT(*) AS total FROM visitors
      `).first();

      await sendMessage(
        env,
        chatId,
        `👥 إجمالي الزوار: ${result.total}`
      );
    }

    else if (command === "/rewards") {
      const result = await env.DB.prepare(`
        SELECT COALESCE(SUM(reward), 0) AS total
        FROM offerwall_events
        WHERE status = 1
      `).first();

      await sendMessage(
        env,
        chatId,
        `💰 مجموع المكافآت المؤكدة: ${Number(result.total).toFixed(2)}`
      );
    }

    return new Response("ok", { status: 200 });

  } catch (error) {
    return new Response("Server error", {
      status: 500
    });
  }
}
