
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
    INSERT OR IGNORE INTO visitors
    (user_id, progress, points, created_at)
    VALUES (?, 0, 0, ?)
  `).bind(userId, Math.floor(Date.now() / 1000)).run();

  return { userId, cookie };
}

function shortId(id) {
  return "OX-" + id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const { userId, cookie } = await getUser(request, env);

    const user = await env.DB.prepare(`
      SELECT points FROM visitors WHERE user_id = ?
    `).bind(userId).first();

    const stats = await env.DB.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(points_awarded), 0) AS earned
      FROM referrals
      WHERE referrer_id = ?
    `).bind(userId).first();

    const pointsRanking = await env.DB.prepare(`
      SELECT user_id, points
      FROM visitors
      ORDER BY points DESC, created_at ASC
      LIMIT 10
    `).all();

    const referralRanking = await env.DB.prepare(`
      SELECT referrer_id, COUNT(*) AS total
      FROM referrals
      GROUP BY referrer_id
      ORDER BY total DESC, referrer_id ASC
      LIMIT 10
    `).all();

    return response({
      success: true,
      user: {
        userId: shortId(userId),
        points: Number(user?.points || 0),
        referrals: Number(stats?.total || 0),
        earned: Number(stats?.earned || 0)
      },
      pointsRanking: (pointsRanking.results || []).map((item, index) => ({
        rank: index + 1,
        userId: shortId(item.user_id),
        points: Number(item.points || 0)
      })),
      referralRanking: (referralRanking.results || []).map((item, index) => ({
        rank: index + 1,
        userId: shortId(item.referrer_id),
        referrals: Number(item.total || 0)
      }))
    }, cookie);

  } catch (error) {
    return json({ error: "Could not load referral data" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const { userId, cookie } = await getUser(request, env);
    const body = await request.json();
    const referrerId = String(body.referrerId || "").trim();

    if (!referrerId || referrerId.length > 100) {
      return response({ success: false, error: "Invalid referral" }, cookie, 400);
    }

    if (referrerId === userId) {
      return response({ success: false, error: "SELF_REFERRAL" }, cookie, 400);
    }

    const referrer = await env.DB.prepare(`
      SELECT user_id FROM visitors WHERE user_id = ?
    `).bind(referrerId).first();

    if (!referrer) {
      return response({ success: false, error: "REFERRER_NOT_FOUND" }, cookie, 404);
    }

    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO referrals
      (referrer_id, referred_id, points_awarded, created_at)
      VALUES (?, ?, 15, ?)
    `).bind(
      referrerId,
      userId,
      Math.floor(Date.now() / 1000)
    ).run();

    if (result.meta?.changes !== 1) {
      return response({
        success: true,
        alreadyRegistered: true
      }, cookie);
    }

    return response({
      success: true,
      registered: true,
      message: "Referral registered"
    }, cookie);

  } catch (error) {
    return json({ error: "Could not register referral" }, 500);
  }
}
