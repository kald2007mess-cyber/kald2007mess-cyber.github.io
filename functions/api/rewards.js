import {
  getVisitor,
  json,
  createVisitorCookie
} from "./_lib/session.js";

const OFFERS = [
  { id: 1, name: "55 COINS", points: 1500 },
  { id: 2, name: "145 COINS", points: 3500 },
  { id: 3, name: "PREMIUM", points: 3000 },
  { id: 4, name: "25 BP COINS", points: 3500 }
];

async function ensureOrdersTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_redemption_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      display_id TEXT NOT NULL,
      offer_id INTEGER NOT NULL,
      offer_name TEXT NOT NULL,
      points_cost INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      telegram_message_id INTEGER,
      refund_token TEXT
    )
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_oxide_redemption_user
    ON oxide_redemption_orders(user_id, created_at DESC)
  `).run();

  const columns = await DB.prepare("PRAGMA table_info(oxide_redemption_orders)").all();
  if (!(columns.results || []).some(column => column.name === "user_uuid_input")) {
    await DB.prepare("ALTER TABLE oxide_redemption_orders ADD COLUMN user_uuid_input TEXT").run();
  }
}

async function getUser(request, env) {
  let userId = await getVisitor(request, env);
  let cookie = null;
  if (!userId) {
    cookie = await createVisitorCookie(env);
    const match = cookie.match(/^oxide_visitor=([^;]+)/);
    if (!match) throw new Error("Session creation failed");
    userId = decodeURIComponent(match[1]).split(".")[0];
  }
  await env.DB.prepare(`
    INSERT OR IGNORE INTO visitors (user_id, progress, points, created_at)
    VALUES (?, 0, 0, ?)
  `).bind(userId, Math.floor(Date.now() / 1000)).run();
  return { userId, cookie };
}

function response(data, cookie = null, status = 200) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}

async function resolveOwnUuid(DB, input, sessionUserId) {
  const value = String(input || "").trim().toUpperCase();
  let row = null;
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(value)) {
    row = await DB.prepare("SELECT user_id FROM visitors WHERE UPPER(user_id) = ? LIMIT 1").bind(value).first();
  } else {
    const match = value.match(/^OX-?([0-9A-F]{8})$/);
    if (!match) return null;
    const rows = await DB.prepare(`
      SELECT user_id FROM visitors
      WHERE UPPER(SUBSTR(REPLACE(user_id, '-', ''), 1, 8)) = ?
      LIMIT 2
    `).bind(match[1]).all();
    if ((rows.results || []).length !== 1) return null;
    row = rows.results[0];
  }
  if (!row || String(row.user_id).toLowerCase() !== String(sessionUserId).toLowerCase()) return null;
  return "OX-" + String(row.user_id).replace(/-/g, "").slice(0, 8).toUpperCase();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ error: "Server configuration missing" }, 500);
    const { userId, cookie } = await getUser(request, env);
    const user = await env.DB.prepare("SELECT points FROM visitors WHERE user_id = ?").bind(userId).first();
    return response({ success: true, points: Number(user?.points || 0), offers: OFFERS }, cookie);
  } catch {
    return json({ error: "Could not load rewards" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let userId = null;
  let orderId = null;
  let offer = null;
  let cookie = null;
  let deducted = false;
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    ({ userId, cookie } = await getUser(request, env));
    await ensureOrdersTable(env.DB);
    const body = await request.json();
    offer = OFFERS.find(item => item.id === Number(body.offerId));
    if (!offer) return response({ success: false, error: "INVALID_OFFER" }, cookie, 400);

    const enteredUuid = String(body.userUuid || "").trim();
    const displayId = await resolveOwnUuid(env.DB, enteredUuid, userId);
    if (!displayId) return response({ success: false, error: "UUID_DOES_NOT_MATCH_ACCOUNT" }, cookie, 400);

    const debit = await env.DB.prepare(`
      UPDATE visitors SET points = points - ?
      WHERE user_id = ? AND points >= ?
      RETURNING points
    `).bind(offer.points, userId, offer.points).first();
    if (!debit) return response({ success: false, error: "INSUFFICIENT_POINTS" }, cookie, 400);
    deducted = true;

    const now = Math.floor(Date.now() / 1000);
    const [missionStats, referralStats] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM mission_submissions
        WHERE user_id = ? AND status = 'approved'
      `).bind(userId).first(),
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM referrals
        WHERE referrer_id = ?
      `).bind(userId).first()
    ]);
    const completedMissions = Number(missionStats?.total || 0);
    const invitedFriends = Number(referralStats?.total || 0);
    const pointsBeforeRequest = Number(debit.points || 0) + offer.points;

    const inserted = await env.DB.prepare(`
      INSERT INTO oxide_redemption_orders
        (user_id, display_id, offer_id, offer_name, points_cost, status, created_at, user_uuid_input)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      RETURNING id
    `).bind(userId, displayId, offer.id, offer.name, offer.points, now, enteredUuid).first();
    if (!inserted?.id) throw new Error("ORDER_CREATE_FAILED");
    orderId = Number(inserted.id);

    const messageText =
      "🎁 OXIDE HUB — طلب استبدال نقاط جديد\\n\\n" +
      "🧾 الطلب: #" + orderId + "\\n" +
      "👤 المستخدم: " + displayId + "\\n" +
      "💰 رصيد المستخدم قبل الطلب: " + pointsBeforeRequest.toLocaleString() + " نقطة\\n" +
      "📋 المهمات المكتملة: " + completedMissions + "\\n" +
      "👥 الأصدقاء المدعوون: " + invitedFriends + "\\n" +
      "🎮 العرض: " + offer.name + "\\n" +
      "🎁 النقاط المطلوبة: " + offer.points.toLocaleString() + "\\n" +
      "🪪 UUID الذي أدخله: " + enteredUuid + "\\n\\n" +
      "اختر الموافقة أو الرفض:";

    const tgResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_ADMIN_ID,
        text: messageText,
        reply_markup: { inline_keyboard: [[
          { text: "موافقة ✅", callback_data: `oxide_redeem:approve:${orderId}` },
          { text: "رفض ❌", callback_data: `oxide_redeem:reject:${orderId}` }
        ]] }
      })
    });
    const tg = await tgResponse.json();
    if (!tgResponse.ok || !tg.ok) throw new Error("TELEGRAM_DELIVERY_FAILED");

    await env.DB.prepare(`
      UPDATE oxide_redemption_orders SET telegram_message_id = ?
      WHERE id = ? AND status = 'pending'
    `).bind(Number(tg.result?.message_id || 0), orderId).run();

    return response({ success: true, orderId, points: Number(debit.points || 0), status: "pending" }, cookie);
  } catch (error) {
    if (deducted && userId) {
      try {
        await env.DB.prepare("UPDATE visitors SET points = points + ? WHERE user_id = ?")
          .bind(Number(offer?.points || 0), userId).run();
        if (orderId) {
          await env.DB.prepare(`
            UPDATE oxide_redemption_orders SET status = 'failed', reviewed_at = ?
            WHERE id = ? AND status = 'pending'
          `).bind(Math.floor(Date.now() / 1000), orderId).run();
        }
      } catch (refundError) { console.error("Redemption compensation failed", refundError); }
    }
    return response({
      success: false,
      error: error?.message === "TELEGRAM_DELIVERY_FAILED" ? "TELEGRAM_DELIVERY_FAILED" : "REDEMPTION_REQUEST_FAILED"
    }, cookie, 500);
  }
}
