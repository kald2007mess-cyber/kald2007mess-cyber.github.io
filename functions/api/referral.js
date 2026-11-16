import {
  getVisitor,
  json,
  createVisitorCookie
} from "./_lib/session.js";

function response(data, cookie = null, status = 200) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}

function shortId(id) {
  return "OX-" + String(id).replace(/-/g, "").slice(0, 8).toUpperCase();
}

async function ensureUser(DB, userUuid) {
  const now = Math.floor(Date.now() / 1000);
  await DB.prepare(`
    INSERT OR IGNORE INTO users
      (user_uuid, public_id, legacy_user_id, points, status, created_at, updated_at)
    VALUES (?, ?, ?, 0, 'active', ?, ?)
  `).bind(userUuid, shortId(userUuid), userUuid, now, now).run();

  return DB.prepare(`
    SELECT user_uuid, public_id, points, status
    FROM users
    WHERE user_uuid = ?
    LIMIT 1
  `).bind(userUuid).first();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "USER_NOT_FOUND" }, 401);

    const user = await ensureUser(env.DB, userUuid);
    if (!user || user.status !== "active") {
      return json({ success: false, error: "USER_NOT_AVAILABLE" }, 404);
    }

    const stats = await env.DB.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(points_awarded), 0) AS earned
      FROM referrals
      WHERE referrer_uuid = ? AND status = 'confirmed'
    `).bind(userUuid).first();

    const pointsRanking = await env.DB.prepare(`
      SELECT user_uuid, public_id, points
      FROM users
      WHERE status = 'active'
      ORDER BY COALESCE(points, 0) DESC, created_at ASC, user_uuid ASC
      LIMIT 10
    `).all();

    const referralRanking = await env.DB.prepare(`
      SELECT r.referrer_uuid, u.public_id, COUNT(*) AS total
      FROM referrals r
      JOIN users u ON u.user_uuid = r.referrer_uuid
      WHERE r.status = 'confirmed'
      GROUP BY r.referrer_uuid, u.public_id
      ORDER BY total DESC, r.referrer_uuid ASC
      LIMIT 10
    `).all();

    return json({
      success: true,
      referralCode: user.public_id || shortId(userUuid),
      user: {
        userId: user.public_id || shortId(userUuid),
        points: Number(user.points || 0),
        referrals: Number(stats?.total || 0),
        earned: Number(stats?.earned || 0)
      },
      pointsRanking: (pointsRanking.results || []).map((item, index) => ({
        rank: index + 1,
        userId: item.public_id || shortId(item.user_uuid),
        points: Number(item.points || 0)
      })),
      referralRanking: (referralRanking.results || []).map((item, index) => ({
        rank: index + 1,
        userId: item.public_id || shortId(item.referrer_uuid),
        referrals: Number(item.total || 0)
      }))
    });
  } catch (error) {
    console.error("Referral data load failed:", error);
    return json({ success: false, error: "REFERRAL_LOAD_FAILED" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let cookie = null;
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const enteredCode = String(body.referrerId || body.code || "").trim().toUpperCase();
    const uuidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
    let referrer = null;

    if (uuidPattern.test(enteredCode)) {
      referrer = await env.DB.prepare(`
        SELECT user_uuid, public_id, status
        FROM users
        WHERE UPPER(user_uuid) = ?
        LIMIT 1
      `).bind(enteredCode).first();
    } else {
      const match = enteredCode.match(/^OX-?([0-9A-F]{8})$/);
      if (!match) return json({ success: false, error: "INVALID_REFERRAL" }, 400);

      const matches = await env.DB.prepare(`
        SELECT user_uuid, public_id, status
        FROM users
        WHERE UPPER(REPLACE(public_id, 'OX-', '')) = ?
        LIMIT 2
      `).bind(match[1]).all();

      if ((matches.results || []).length === 1) referrer = matches.results[0];
      else if ((matches.results || []).length > 1) {
        return json({ success: false, error: "REFERRAL_CODE_AMBIGUOUS" }, 409);
      }
    }

    if (!referrer || referrer.status !== "active") {
      return json({ success: false, error: "REFERRER_NOT_FOUND" }, 404);
    }

    let userUuid = await getVisitor(request, env);
    if (!userUuid) {
      cookie = await createVisitorCookie(env);
      const match = cookie.match(/^oxide_visitor=([^;]+)/);
      if (!match) throw new Error("SESSION_CREATE_FAILED");
      userUuid = decodeURIComponent(match[1]).split(".")[0];
    }

    if (String(userUuid).toLowerCase() === String(referrer.user_uuid).toLowerCase()) {
      return response({ success: false, error: "SELF_REFERRAL_NOT_ALLOWED" }, cookie, 400);
    }

    const user = await ensureUser(env.DB, userUuid);
    if (!user || user.status !== "active") {
      return response({ success: false, error: "USER_NOT_AVAILABLE" }, cookie, 404);
    }

    const already = await env.DB.prepare(`
      SELECT id FROM referrals WHERE referred_uuid = ? LIMIT 1
    `).bind(userUuid).first();
    if (already) {
      return response({ success: false, error: "REFERRAL_ALREADY_USED" }, cookie, 409);
    }

    const now = Math.floor(Date.now() / 1000);
    const inserted = await env.DB.prepare(`
      INSERT INTO referrals
        (referrer_uuid, referred_uuid, points_awarded, status, created_at, confirmed_at)
      VALUES (?, ?, 50, 'pending', ?, NULL)
      ON CONFLICT(referred_uuid) DO NOTHING
      RETURNING id
    `).bind(referrer.user_uuid, userUuid, now).first();

    if (!inserted?.id) {
      return response({ success: false, error: "REFERRAL_ALREADY_USED" }, cookie, 409);
    }

    const referralId = Number(inserted.id);
    const referrerCheck = await env.DB.prepare(`
      SELECT user_uuid FROM users
      WHERE user_uuid = ? AND status = 'active'
      LIMIT 1
    `).bind(referrer.user_uuid).first();

    if (!referrerCheck) {
      await env.DB.prepare("UPDATE referrals SET status = 'rejected' WHERE id = ? AND status = 'pending'")
        .bind(referralId).run();
      return response({ success: false, error: "REFERRER_NOT_AVAILABLE" }, cookie, 409);
    }

    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE users
        SET points = COALESCE(points, 0) + 30, updated_at = ?
        WHERE user_uuid = ? AND status = 'active'
          AND EXISTS (SELECT 1 FROM referrals WHERE id = ? AND status = 'pending')
      `).bind(now, userUuid, referralId),
      env.DB.prepare(`
        UPDATE users
        SET points = COALESCE(points, 0) + 50, updated_at = ?
        WHERE user_uuid = ? AND status = 'active'
          AND EXISTS (SELECT 1 FROM referrals WHERE id = ? AND status = 'pending')
      `).bind(now, referrer.user_uuid, referralId),
      env.DB.prepare(`
        UPDATE referrals
        SET status = 'confirmed', confirmed_at = ?
        WHERE id = ? AND status = 'pending'
          AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
          AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
      `).bind(now, referralId, userUuid, referrer.user_uuid),
      env.DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid, delta, balance_after, reason, reference_type,
           reference_id, admin_telegram_id, created_at)
        SELECT user_uuid, 30, points, 'referral_invitee_reward',
               'referral', ?, NULL, ?
        FROM users
        WHERE user_uuid = ?
          AND EXISTS (SELECT 1 FROM referrals WHERE id = ? AND status = 'confirmed')
      `).bind(String(referralId), now, userUuid, referralId),
      env.DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid, delta, balance_after, reason, reference_type,
           reference_id, admin_telegram_id, created_at)
        SELECT user_uuid, 50, points, 'referral_referrer_reward',
               'referral', ?, NULL, ?
        FROM users
        WHERE user_uuid = ?
          AND EXISTS (SELECT 1 FROM referrals WHERE id = ? AND status = 'confirmed')
      `).bind(String(referralId), now, referrer.user_uuid, referralId)
    ]);

    if (
      Number(results[0]?.meta?.changes || 0) !== 1 ||
      Number(results[1]?.meta?.changes || 0) !== 1 ||
      Number(results[2]?.meta?.changes || 0) !== 1
    ) {
      console.error("Referral reward batch incomplete:", results);
      return response({ success: false, error: "REFERRAL_REWARD_FAILED" }, cookie, 500);
    }

    return response({
      success: true,
      registered: true,
      invitedPointsAwarded: 30,
      referrerPointsAwarded: 50,
      userId: user.public_id || shortId(userUuid)
    }, cookie);
  } catch (error) {
    console.error("Referral registration failed:", error);
    return response({ success: false, error: "REFERRAL_REGISTRATION_FAILED" }, cookie, 500);
  }
}
