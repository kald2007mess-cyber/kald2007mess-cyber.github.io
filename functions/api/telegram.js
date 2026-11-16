async function sendMessage(env, chatId, message) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    }
  );
  return response.ok;
}

export async function onRequestGet() {
  return Response.json({
    status: "online",
    project: "OXIDE HUB",
    telegram: "endpoint ready"
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID || !env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Configuration missing", { status: 503 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    const update = await request.json();
    const message = update.message;
    if (!message?.text || !message.chat?.id) return new Response("ok");
    if (String(message.from?.id) !== String(env.TELEGRAM_ADMIN_ID)) return new Response("ok");

    const chatId = message.chat.id;
    const command = message.text.trim().split(/\\s+/)[0].split("@")[0].toLowerCase();

    if (command === "/start") {
      await sendMessage(env, chatId,
        "🚀 مرحبًا بك في لوحة إدارة OXIDE HUB!\\n\\n" +
        "📊 الأوامر المتاحة:\\n" +
        "/stats - إحصائيات الموقع\\n" +
        "/visitors - عدد المستخدمين\\n" +
        "/rewards - مجموع النقاط");
    } else if (command === "/stats" || command === "/visitors" || command === "/rewards") {
      const visitors = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first();
      const totalPoints = await env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM users").first();
      const ads = await env.DB.prepare("SELECT COUNT(*) AS total FROM ad_events WHERE status = 'credited'").first();
      const ptc = await env.DB.prepare("SELECT COUNT(*) AS total FROM ad_events WHERE status = 'credited' AND LOWER(provider) = 'ptc'").first();

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const todayStart = Math.floor(today.getTime() / 1000);
      const todayVisitors = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM users WHERE created_at >= ?"
      ).bind(todayStart).first();
      const todayAds = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM ad_events WHERE status = 'credited' AND created_at >= ?"
      ).bind(todayStart).first();

      if (command === "/visitors") {
        await sendMessage(env, chatId, `👥 إجمالي المستخدمين: ${Number(visitors?.total || 0)}`);
      } else if (command === "/rewards") {
        await sendMessage(env, chatId, `⭐ مجموع النقاط الحالية: ${Number(totalPoints?.total || 0).toLocaleString()}`);
      } else {
        await sendMessage(env, chatId,
          "📊 OXIDE HUB STATISTICS\\n\\n" +
          `👥 إجمالي المستخدمين: ${Number(visitors?.total || 0)}\\n` +
          `🆕 مستخدمو اليوم: ${Number(todayVisitors?.total || 0)}\\n\\n` +
          `📺 الإعلانات المسجلة كمؤكدة: ${Number(ads?.total || 0)}\\n` +
          `🎯 إعلانات PTC: ${Number(ptc?.total || 0)}\\n` +
          `📅 إعلانات اليوم: ${Number(todayAds?.total || 0)}\\n\\n` +
          `⭐ مجموع النقاط: ${Number(totalPoints?.total || 0).toLocaleString()}`);
      }
    }

    return new Response("ok", { status: 200 });
  } catch (error) {
    console.error("Telegram stats failed:", error);
    return new Response("Server error", { status: 500 });
  }
}
