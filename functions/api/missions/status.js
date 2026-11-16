import { getVisitor, json } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) return json({ error: "NO_VISITOR_SESSION" }, 401);

    const user = await env.DB.prepare(`
      SELECT points, status
      FROM users
      WHERE user_uuid = ?
      LIMIT 1
    `).bind(userId).first();

    if (!user || user.status !== "active") {
      return json({ error: "USER_NOT_AVAILABLE" }, 404);
    }

    const missionsResult = await env.DB.prepare(`
      SELECT
        m.id,
        m.title,
        m.platform,
        m.description,
        m.reward_points,
        COALESCE(s.status, 'not_submitted') AS status
      FROM missions m
      LEFT JOIN mission_submissions s
        ON s.mission_id = m.id
        AND s.user_uuid = ?
      WHERE m.enabled = 1
      ORDER BY m.id ASC
    `).bind(userId).all();

    const missions = (missionsResult.results || []).map(mission => ({
      id: Number(mission.id),
      title: mission.title,
      platform: mission.platform,
      description: mission.description,
      // The current D1 missions table has no target_url column.
      targetUrl: "",
      rewardPoints: Number(mission.reward_points || 0),
      status: mission.status || "not_submitted"
    }));

    const completed = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM mission_submissions
      WHERE user_uuid = ? AND status = 'approved'
    `).bind(userId).first();

    const mission1 = await env.DB.prepare(`
      SELECT status
      FROM mission_submissions
      WHERE user_uuid = ? AND mission_id = 1
      LIMIT 1
    `).bind(userId).first();

    return json({
      success: true,
      points: Number(user.points || 0),
      mission1: mission1?.status || "not_submitted",
      completedMissions: Number(completed?.total || 0),
      missions
    });
  } catch (error) {
    console.error("Mission status failed:", error);
    return json({ error: "MISSION_STATUS_FAILED" }, 500);
  }
}
