
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
  return "OX-" + id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "USER_NOT_FOUND" }, 401);
    }

    const user = await env.DB.prepare(`
      SELECT points FROM visitors WHERE user_id = ?
    `).bind(userId).first();

    if (!user) {
      return json({ error: "USER_NOT_FOUND" }, 404);
    }

    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
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

    return json({
      success: true,
      user: {
        userId: shortId(userId),
        points: Number(user.points || 0),
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
    });

  } catch (error) {
    return json({ error: "Could not load referral data" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    // Existing visitors cannot register a new referral.
    const existingUser = await getVisitor(request, env);

    if (existingUser) {
      return json({
        success: false,
        error: "REFERRAL_NOT_ALLOWED_FOR_EXISTING_USER"
      }, 403);
    }

    const body = await request.json();
    const referrerId = String(body.referrerId || "").trim();

    // Only accept a complete UUID.
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(referrerId)) {
      return json({ success: false, error: "INVALID_REFERRAL" }, 400);
    }

    const referrer = await env.DB.prepare(`
      SELECT user_id FROM visitors WHERE user_id = ?
    `).bind(referrerId).first();

    if (!referrer) {
      return json({ success: false, error: "REFERRER_NOT_FOUND" }, 404);
    }

    // Create a new visitor identity.
    const cookie = await createVisitorCookie(env);
    const match = cookie.match(/^oxide_visitor=([^;]+)/);

    if (!match) {
      throw new Error("Session creation failed");
    }

    const userId = decodeURIComponent(match[1]).split(".")[0];

    const created = await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
      (user_id, progress, points, created_at)
      VALUES (?, 0, 0, ?)
    `).bind(
      userId,
      Math.floor(Date.now() / 1000)
    ).run();

    if (created.meta?.changes !== 1) {
      return response({
        success: false,
        error: "VISITOR_ALREADY_EXISTS"
      }, cookie, 409);
    }

    // The database trigger awards the 15 points automatically.
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
        success: false,
        error: "REFERRAL_NOT_REGISTERED"
      }, cookie, 409);
    }

    return response({
      success: true,
      registered: true,
      pointsAwarded: 15,
      userId: shortId(userId)
    }, cookie);

  } catch (error) {
    return json({ error: "Could not register referral" }, 500);
  }
}
 {
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
  return "OX-" + id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "USER_NOT_FOUND" }, 401);
    }

    const user = await env.DB.prepare(`
      SELECT points FROM visitors WHERE user_id = ?
    `).bind(userId).first();

    if (!user) {
      return json({ error: "USER_NOT_FOUND" }, 404);
    }

    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
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

    return json({
      success: true,
      user: {
        userId: shortId(userId),
        points: Number(user.points || 0),
        referrals: Number(stats?.total || 0),
        earned: Number(stats?.earned || 0)
      },
      pointsRanking: (pointsRanking.results || []).map((item, index) => ({
        rank: index + 1,
        userId: shortId(item.user_id),
