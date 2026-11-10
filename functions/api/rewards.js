
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

function response(data, cookie = null, status = 200) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (cookie) headers["Set-Cookie"] = cookie;

  return new Response(JSON.stringify(data), { status, headers });
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

    return response({
      success: true,
      points: Number(user?.points || 0),
      offers: OFFERS
    }, cookie);

  } catch {
    return json({ error: "Could not load rewards" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const { userId, cookie } = await getUser(request, env);

    const body = await request.json();
    const offerId = Number(body.offerId);
    const offer = OFFERS.find(item => item.id === offerId);

    if (!offer) {
      return response({ success: false, error: "Invalid offer" }, cookie, 400);
    }

    const result = await env.DB.prepare(`
      UPDATE visitors
      SET points = points - ?
      WHERE user_id = ?
      AND points >= ?
    `).bind(offer.points, userId, offer.points).run();

    if (result.meta?.changes !== 1) {
      return response({
        success: false,
        error: "INSUFFICIENT_POINTS"
      }, cookie, 400);
    }

    try {
      await env.DB.prepare(`
        INSERT INTO reward_orders
        (user_id, offer_id, points_cost, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
      `).bind(
        userId,
        offer.id,
        offer.points,
        Math.floor(Date.now() / 1000)
      ).run();
    } catch (error) {
      await env.DB.prepare(`
        UPDATE visitors
        SET points = points + ?
        WHERE user_id = ?
      `).bind(offer.points, userId).run();

      throw error;
    }

    const user = await env.DB.prepare(`
      SELECT points FROM visitors WHERE user_id = ?
    `).bind(userId).first();

    return response({
      success: true,
      message: "Request created",
      points: Number(user?.points || 0)
    }, cookie);

  } catch {
    return json({ error: "Could not create reward request" }, 500);
  }
}
