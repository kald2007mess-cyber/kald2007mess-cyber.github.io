
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

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function shortId(id) {
  return "OX-" + String(id)
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({
        success: false,
        error: "Server configuration missing"
      }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({
        success: false,
        error: "USER_NOT_FOUND"
      }, 401);
    }

    // الرصيد الإجمالي للمستخدم من جميع مصادر المكافآت
    const user = await env.DB.prepare(`
      SELECT user_id, points
      FROM visitors
      WHERE user_id = ?
    `).bind(userId).first();

    if (!user) {
      return json({
        success: false,
        error: "USER_NOT_FOUND"
      }, 404);
    }

    // إحصائيات الإحالات فقط
    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(points_awarded), 0) AS earned
      FROM referrals
      WHERE referrer_id = ?
    `).bind(userId).first();

    // ترتيب جميع المستخدمين حسب رصيدهم الإجمالي
    const pointsRanking = await env.DB.prepare(`
      SELECT user_id, points
      FROM visitors
      ORDER BY
        COALESCE(points, 0) DESC,
        created_at ASC,
        user_id ASC
      LIMIT 10
    `).all();

    // ترتيب المستخدمين حسب عدد الإحالات الناجحة
    const referralRanking = await env.DB.prepare(`
      SELECT
        referrer_id,
        COUNT(*) AS total
      FROM referrals
      GROUP BY referrer_id
      ORDER BY total DESC, referrer_id ASC
      LIMIT 10
    `).all();

    return json({
      success: true,

      referralCode: shortId(user.user_id),

      user: {
        userId: shortId(user.user_id),
        points: Number(user.points || 0),
        referrals: Number(stats?.total || 0),
        earned: Number(stats?.earned || 0)
      },

      pointsRanking: (pointsRanking.results || []).map(
        (item, index) => ({
          rank: index + 1,
          userId: shortId(item.user_id),
          points: Number(item.points || 0)
        })
      ),

      referralRanking: (referralRanking.results || []).map(
        (item, index) => ({
          rank: index + 1,
          userId: shortId(item.referrer_id),
          referrals: Number(item.total || 0)
        })
      )
    });

  } catch (error) {
    return json({
      success: false,
      error: "Could not load referral data"
    }, 500);
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
      referrer = await env.DB.prepare(
        "SELECT user_id FROM visitors WHERE UPPER(user_id) = ? LIMIT 1"
      ).bind(enteredCode).first();
    } else {
      const match = enteredCode.match(/^OX-?([0-9A-F]{8})$/);
      if (!match) {
        return json({ success: false, error: "INVALID_REFERRAL" }, 400);
      }
      const matches = await env.DB.prepare(`
        SELECT user_id FROM visitors
        WHERE UPPER(SUBSTR(REPLACE(user_id, '-', ''), 1, 8)) = ?
        LIMIT 2
      `).bind(match[1]).all();
      if ((matches.results || []).length === 1) referrer = matches.results[0];
      else if ((matches.results || []).length > 1) {
        return json({ success: false, error: "REFERRAL_CODE_AMBIGUOUS" }, 409);
      }
    }

    if (!referrer) {
      return json({ success: false, error: "REFERRER_NOT_FOUND" }, 404);
    }

    let userId = await getVisitor(request, env);
    if (!userId) {
      cookie = await createVisitorCookie(env);
      const match = cookie.match(/^oxide_visitor=([^;]+)/);
      if (!match) throw new Error("Session creation failed");
      userId = decodeURIComponent(match[1]).split(".")[0];
    }

    if (String(userId).toLowerCase() === String(referrer.user_id).toLowerCase()) {
      return response({ success: false, error: "SELF_REFERRAL_NOT_ALLOWED" }, cookie, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors (user_id, progress, points, created_at)
      VALUES (?, 0, 0, ?)
    `).bind(userId, now).run();

    const already = await env.DB.prepare(
      "SELECT id FROM referrals WHERE referred_id = ? LIMIT 1"
    ).bind(userId).first();
    if (already) {
      return response({ success: false, error: "REFERRAL_ALREADY_USED" }, cookie, 409);
    }

    // D1 batch is transactional: the referrer trigger awards 50 and the invited
    // account receives 30 only when this one-time referral row is inserted.
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO referrals
          (referrer_id, referred_id, points_awarded, created_at)
        VALUES (?, ?, 50, ?)
      `).bind(referrer.user_id, userId, now),
      env.DB.prepare(`
        UPDATE visitors SET points = points + 30
        WHERE user_id = ?
          AND EXISTS (SELECT 1 FROM referrals WHERE referred_id = ?)
      `).bind(userId, userId)
    ]);

    if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
      return response({ success: false, error: "REFERRAL_ALREADY_USED" }, cookie, 409);
    }

    return response({
      success: true,
      registered: true,
      invitedPointsAwarded: 30,
      referrerPointsAwarded: 50,
      userId: shortId(userId)
    }, cookie);
  } catch (error) {
    console.error("Referral registration failed:", error);
    return response({ success: false, error: "Could not register referral" }, cookie, 500);
  }
}
