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

async function count(env, sql, ...values) {
  const row = await env.DB.prepare(sql).bind(...values).first();
  return Number(row?.total || 0);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    }

    const body = await request.json();
    const auth = await authorizeAdmin(
      String(body.initData || ""),
      env,
      "stats"
    );

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
      pendingMissions,
      downloads
    ] = await Promise.all([
      count(env, "SELECT COUNT(*) AS total FROM visitors"),
      count(env, "SELECT COUNT(*) AS total FROM visitors WHERE created_at >= ?", todayStart),
      count(env, "SELECT COUNT(*) AS total FROM offerwall_events WHERE status = 1"),
      count(env, "SELECT COUNT(*) AS total FROM offerwall_events WHERE status = 1 AND offer_type = 'ptc'"),
      count(env, "SELECT COALESCE(SUM(points), 0) AS total FROM visitors"),
      count(env, "SELECT COUNT(*) AS total FROM referrals"),
      count(env, "SELECT COUNT(*) AS total FROM reward_orders WHERE status = 'pending'"),
      count(env, "SELECT COUNT(*) AS total FROM mission_submissions WHERE status = 'pending'"),
      count(env, "SELECT COUNT(*) AS total FROM platform_file_downloads")
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
        downloads
      }
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    return json({ success: false, error: "STATS_LOAD_FAILED" }, 500);
  }
}
