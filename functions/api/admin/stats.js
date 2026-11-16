import {
  authorizeAdmin,
  adminAuthResponse
} from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function count(DB, sql, ...values) {
  const statement = DB.prepare(sql);
  const row = values.length
    ? await statement.bind(...values).first()
    : await statement.first();
  return Number(row?.total || 0);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);

    const body = await request.json();
    const auth = await authorizeAdmin(String(body.initData || ""), env, "stats");
    if (!auth.ok) return adminAuthResponse(auth);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayStart = Math.floor(today.getTime() / 1000);

    const [
      visitors,
      visitorsToday,
      confirmedAds,
      ptcAds,
      totalPoints,
      referrals,
      pendingRewards,
      pendingMissions
    ] = await Promise.all([
      count(env.DB, "SELECT COUNT(*) AS total FROM users"),
      count(env.DB, "SELECT COUNT(*) AS total FROM users WHERE created_at >= ?", todayStart),
      count(env.DB, "SELECT COUNT(*) AS total FROM ad_events WHERE status = 'credited'"),
      count(env.DB, "SELECT COUNT(*) AS total FROM ad_events WHERE status = 'credited' AND LOWER(provider) = 'ptc'"),
      count(env.DB, "SELECT COALESCE(SUM(points), 0) AS total FROM users"),
      count(env.DB, "SELECT COUNT(*) AS total FROM referrals"),
      count(env.DB, "SELECT COUNT(*) AS total FROM withdrawals WHERE status = 'pending'"),
      count(env.DB, "SELECT COUNT(*) AS total FROM mission_submissions WHERE status = 'pending'")
    ]);

    return json({
      success: true,
      stats: {
        visitors,
        visitorsToday,
        confirmedAds,
        ptcAds,
        totalPoints,
        referrals,
        pendingRewards,
        pendingMissions,
        // No download analytics table exists in the current D1 schema.
        downloads: 0
      }
    });
  } catch (error) {
    console.error("Admin stats failed:", error);
    return json({ success: false, error: "STATS_LOAD_FAILED" }, 500);
  }
}
