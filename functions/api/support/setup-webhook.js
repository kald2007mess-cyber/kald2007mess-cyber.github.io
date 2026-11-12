
function page(content) {
  return new Response(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OXIDE HUB - Webhook Setup</title>
</head>
<body style="font-family:Arial;max-width:600px;margin:40px auto;padding:20px;background:#111;color:white">
<h2>OXIDE HUB - ربط البوت</h2>
${content}
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function onRequest({ request, env }) {
  if (request.method === "GET") {
    return page(`
      <p>أدخل سر Webhook المحفوظ في Cloudflare.</p>
      <form method="POST">
        <input type="password" name="key" required
          placeholder="Webhook Secret"
          style="width:95%;padding:12px">
        <button name="action" value="check"
          style="padding:12px;margin-top:15px">
          فحص إعداد البوت
        </button>
      </form>
    `);
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const form = await request.formData();
  const key = form.get("key");
  const action = form.get("action");

  if (
    typeof key !== "string" ||
    !env.TELEGRAM_WEBHOOK_SECRET ||
    key !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return new Response("TELEGRAM_BOT_TOKEN is missing", {
      status: 500
    });
  }

  const api =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

  if (action === "check") {
    const response = await fetch(`${api}/getWebhookInfo`);
    const result = await response.json();

    if (!result.ok) {
      return page("<p>تعذر فحص إعداد البوت.</p>");
    }

    const info = result.result;
    const currentUrl = escapeHtml(
      info.url || "لا يوجد Webhook حاليًا"
    );

    return page(`
      <h3>نتيجة الفحص</h3>
      <p>العنوان الحالي:</p>
      <p style="direction:ltr;word-break:break-all">${currentUrl}</p>
      <p>الرسائل المعلقة: ${Number(info.pending_update_count || 0)}</p>
      <p>لم نغيّر أي إعداد حتى الآن.</p>

      <form method="POST">
        <input type="hidden" name="key" value="${escapeHtml(key)}">
        <button name="action" value="set"
          style="padding:12px;background:#16834a;color:white">
          تأكيد ربط بوت OXIDE HUB
        </button>
      </form>
    `);
  }

  if (action === "set") {
    const webhookUrl = new URL(
      "/api/support/telegram-webhook",
      request.url
    ).toString();

    const response = await fetch(`${api}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"]
      })
    });

    const result = await response.json();

    return page(result.ok
      ? "<h3>تم إرسال طلب الربط بنجاح.</h3><p>تم تفعيل استقبال الرسائل وأزرار الموافقة والرفض.</p>"
      : "<h3>فشل الربط.</h3><p>راجع إعدادات البوت والمتغيرات في Cloudflare.</p>"
    );
  }

  return new Response("Invalid action", { status: 400 });
}
