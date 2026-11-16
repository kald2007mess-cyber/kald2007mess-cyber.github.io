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
      refund_token TEXT,
      user_uuid_input TEXT
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
  let userUuid = await getVisitor(request, env);
  let cookie = null;
  if (!userUuid) {
    cookie = await createVisitorCookie(env);
    const match = cookie.match(/^oxide_visitor=([^;]+)/);
    if (!match) throw new Error("SESSION_CREATE_FAILED");
    userUuid = decodeURIComponent(match[1]).split(".")[0];
  }

  const now = Math.floor(Date.now() / 1000);
  const publicId = "OX-" + userUuid.replace(/-/g, "").slice(0, 8).toUpperCase();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO users
      (user_uuid, public_id, legacy_user_id, points, status, created_at, updated_at)
    VALUES (?, ?, ?, 0, 'active', ?, ?)
  `).bind(userUuid, publicId, userUuid, now, now).run();

  const user = await env.DB.prepare(`
    SELECT user_uuid, public_id, points, status
    FROM users WHERE user_uuid = ? LIMIT 1
  `).bind(userUuid).first();

  if (!user || user.status !== "active") throw new Error("USER_NOT_AVAILABLE");
  return { userUuid, user, cookie };
}

function response(data, cookie = null, status = 200) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}

async function resolveOwnUuid(DB, input, sessionUserUuid) {
  const value = String(input || "").trim().toUpperCase();
  let row = null;

  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(value)) {
    row = await DB.prepare(`
      SELECT user_uuid, public_id FROM users
      WHERE UPPER(user_uuid) = ? LIMIT 1
    `).bind(value).first();
  } else {
    const match = value.match(/^OX-?([0-9A-F]{8})$/);
    if (!match) return null;
    const rows = await DB.prepare(`
      SELECT user_uuid, public_id FROM users
      WHERE UPPER(SUBSTR(REPLACE(public_id, '-', ''), 1, 8)) = ?
      LIMIT 2
    `).bind(match[1]).all();
    if ((rows.results || []).length !== 1) return null;
    row = rows.results[0];
  }

  if (!row || String(row.user_uuid).toLowerCase() !== String(sessionUserUuid).toLowerCase()) {
    return null;
  }
  return row.public_id;
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    const { userUuid, user, cookie } = await getUser(request, env);
    return response({
      success: true,
      points: Number(user.points || 0),
      offers: OFFERS
    }, cookie);
  } catch (error) {
    console.error("Rewards load failed:", error);
    return json({ error: "REWARDS_LOAD_FAILED" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let userUuid = null;
  let orderId = null;
  let offer = null;
  let cookie = null;
  let deducted = false;
  let debitBalance = 0;

  try {
    if (!env.DB || !env.SESSION_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const current = await getUser(request, env);
    userUuid = current.userUuid;
    cookie = current.cookie;
    await ensureOrdersTable(env.DB);

    const body = await request.json();
    offer = OFFERS.find(item => item.id === Number(body.offerId));
    if (!offer) return response({ success: false, error: "INVALID_OFFER" }, cookie, 400);

    const enteredUuid = String(body.userUuid || "").trim();
    const displayId = await resolveOwnUuid(env.DB, enteredUuid, userUuid);
    if (!displayId) return response({ success: false, error: "UUID_DOES_NOT_MATCH_ACCOUNT" }, cookie, 400);

    const debit = await env.DB.prepare(`
      UPDATE users
      SET points = points - ?, updated_at = ?
      WHERE user_uuid = ? AND status = 'active' AND points >= ?
      RETURNING points
    `).bind(offer.points, Math.floor(Date.now() / 1000), userUuid, offer.points).first();

    if (!debit) return response({ success: false, error: "INSUFFICIENT_POINTS" }, cookie, 400);
    deducted = true;
    debitBalance = Number(debit.points || 0);

    const now = Math.floor(Date.now() / 1000);
    const [missionStats, referralStats] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM mission_submissions
        WHERE user_uuid = ? AND status = 'approved'
      `).bind(userUuid).first(),
      env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM referrals
        WHERE referrer_uuid = ? AND status = 'confirmed'
      `).bind(userUuid).first()
    ]);

    const completedMissions = Number(missionStats?.total || 0);
    const invitedFriends = Number(referralStats?.total || 0);
    const inserted = await env.DB.prepare(`
      INSERT INTO oxide_redemption_orders
        (user_id, display_id, offer_id, offer_name, points_cost,
         status, created_at, user_uuid_input)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      RETURNING id
    `).bind(userUuid, displayId, offer.id, offer.name, offer.points, now, enteredUuid).first();

    if (!inserted?.id) throw new Error("ORDER_CREATE_FAILED");
    orderId = Number(inserted.id);

    await env.DB.prepare(`
      INSERT INTO point_ledger
        (user_uuid, delta, balance_after, reason, reference_type,
         reference_id, admin_telegram_id, created_at)
      VALUES (?, ?, ?, 'redemption_requested', 'redemption_order', ?, NULL, ?)
    `).bind(userUuid, -offer.points, debitBalance, String(orderId), now).run();

    const messageText =
      "🎁 OXIDE HUB — طلب استبدال نقاط جديد\\n\\n" +
      "🧾 الطلب: #" + orderId + "\\n" +
      "👤 المستخدم: " + displayId + "\\n" +
      "💰 رصيد المستخدم قبل الطلب: " + (debitBalance + offer.points).toLocaleString() + " نقطة\\n" +
      "📋 المهمات المكتملة: " + completedMissions + "\\n" +
      "👥 الأصدقاء المدعوون: " + invitedFriends + "\\n" +
      "🎮 العرض: " + offer.name + "\\n" +
      "🎁 النقاط المطلوبة: " + offer.points.toLocaleString() + "\\n" +
      "🪪 UUID الذي أدخله: " + enteredUuid + "\\n\\n" +
      "اختر الموافقة أو الرفض:";

    const tgResponse = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_ADMIN_ID,
          text: messageText,
          reply_markup: {
            inline_keyboard: [[
              { text: "موافقة ✅", callback_data: `oxide_redeem:approve:${orderId}` },
              { text: "رفض ❌", callback_data: `oxide_redeem:reject:${orderId}` }
            ]]
          }
        })
      }
    );
    const tg = await tgResponse.json();
    if (!tgResponse.ok || !tg.ok) throw new Error("TELEGRAM_DELIVERY_FAILED");

    await env.DB.prepare(`
      UPDATE oxide_redemption_orders
      SET telegram_message_id = ?
      WHERE id = ? AND status = 'pending'
    `).bind(Number(tg.result?.message_id || 0), orderId).run();

    return response({
      success: true,
      orderId,
      points: debitBalance,
      status: "pending"
    }, cookie);
  } catch (error) {
    console.error("Redemption request failed:", error);
    if (deducted && userUuid && offer) {
      const now = Math.floor(Date.now() / 1000);
      try {
        const refund = await env.DB.prepare(`
          UPDATE users
          SET points = points + ?, updated_at = ?
          WHERE user_uuid = ? AND status = 'active'
          RETURNING points
        `).bind(offer.points, now, userUuid).first();

        if (orderId) {
          await env.DB.prepare(`
            UPDATE oxide_redemption_orders
            SET status = 'failed', reviewed_at = ?
            WHERE id = ? AND status = 'pending'
          `).bind(now, orderId).run();
        }

        if (refund) {
          await env.DB.prepare(`
            INSERT INTO point_ledger
              (user_uuid, delta, balance_after, reason, reference_type,
               reference_id, admin_telegram_id, created_at)
            VALUES (?, ?, ?, 'redemption_request_refund',
                    'redemption_order', ?, NULL, ?)
          `).bind(userUuid, offer.points, Number(refund.points || 0),
            String(orderId || "request-failed"), now).run();
        }
      } catch (refundError) {
        console.error("Redemption compensation failed:", refundError);
      }
    }

    return response({
      success: false,
      error: error?.message === "TELEGRAM_DELIVERY_FAILED"
        ? "TELEGRAM_DELIVERY_FAILED"
        : "REDEMPTION_REQUEST_FAILED"
    }, cookie, 500);
  }
}
