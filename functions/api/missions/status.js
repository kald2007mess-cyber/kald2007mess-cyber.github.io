
import { getVisitor, json } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "NO_VISITOR_SESSION" }, 401);
    }

    const user = await env.DB.prepare(`
      SELECT points
      FROM visitors
      WHERE user_id = ?
    `).bind(userId).first();

    if (!user) {
      return json({ error: "USER_NOT_FOUND" }, 404);
    }

    const missionsResult = await env.DB.prepare(`
      SELECT
        m.id,
        m.title,
        m.platform,
        m.description,
        m.target_url,
        m.reward_points,
        COALESCE(s.status, 'not_submitted') AS status
      FROM oxide_admin_missions m
      LEFT JOIN mission_submissions s
        ON s.mission_id = m.id
        AND s.user_id = ?
      WHERE m.enabled = 1
      ORDER BY m.sort_order ASC, m.id ASC
    `).bind(userId).all();

    const missions = (missionsResult.results || []).map(mission => ({
      id: Number(mission.id),
      title: mission.title,
      platform: mission.platform,
      description: mission.description,
      targetUrl: mission.target_url,
      rewardPoints: Number(mission.reward_points || 0),
      status: mission.status || "not_submitted"
    }));

    const completed = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM mission_submissions
      WHERE user_id = ?
        AND status = 'approved'
    `).bind(userId).first();

    const mission1 = await env.DB.prepare(`
      SELECT status
      FROM mission_submissions
      WHERE user_id = ? AND mission_id = 1
    `).bind(userId).first();

    return json({
      success: true,
      points: Number(user.points || 0),
      mission1: mission1?.status || "not_submitted",
      completedMissions: Number(completed?.total || 0),
      missions
    });

  } catch (error) {
    return json({ error: "MISSION_STATUS_FAILED" }, 500);
  }
}
