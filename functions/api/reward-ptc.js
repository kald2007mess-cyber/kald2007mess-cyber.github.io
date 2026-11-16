
import {
  getVisitor,
  createVisitorCookie,
  json
} from "./_lib/session.js";

const CYCLE_SECONDS = 5 * 60 * 60;
const MAX_ADS = 10;

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

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS reward_ad_cycles (
      user_id TEXT PRIMARY KEY,
      completed_ads INTEGER NOT NULL DEFAULT 0,
      cycle_started_at INTEGER NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO visitors
    (user_id, progress, points, created_at)
    VALUES (?, 0, 0, ?)
  `).bind(userId, now).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO reward_ad_cycles
    (user_id, completed_ads, cycle_started_at)
    VALUES (?, 0, ?)
  `).bind(userId, now).run();

  let cycle = await env.DB.prepare(`
    SELECT completed_ads, cycle_started_at
    FROM reward_ad_cycles
    WHERE user_id = ?
  `).bind(userId).first();

  let startedAt = Number(cycle?.cycle_started_at || now);

  if (now - startedAt >= CYCLE_SECONDS) {
    await env.DB.prepare(`
      UPDATE reward_ad_cycles
      SET completed_ads = 0,
          cycle_started_at = ?
      WHERE user_id = ?
    `).bind(now, userId).run();

    cycle = {
      completed_ads: 0,
      cycle_started_at: now
    };

    startedAt = now;
  }

  return {
    userId,
    cookie,
    completedAds: Math.min(
      MAX_ADS,
      Math.max(0, Number(cycle?.completed_ads || 0))
    ),
    cycleStartedAt: startedAt,
    remainingSeconds: Math.max(
      0,
      CYCLE_SECONDS - (now - startedAt)
    )
  };
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    // Ads are intentionally disabled (SOON). Keep the island cycle data
    // available without requiring external offerwall credentials or API uptime.
    const user = await getUser(request, env);
    const ads = [];

    return response({
      success: true,
      count: ads.length,
      ads,
      completedAds: user.completedAds,
      requiredAds: MAX_ADS,
      remainingAds: Math.max(0, MAX_ADS - user.completedAds),
      cycleStartedAt: user.cycleStartedAt,
      remainingSeconds: user.remainingSeconds,
      pointsPerAd: 5,
      cycleSeconds: CYCLE_SECONDS
    }, user.cookie);

  } catch {
    return json({ error: "Reward PTC service error" }, 500);
  }
}
