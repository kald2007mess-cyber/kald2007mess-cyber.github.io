
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

    const user = await env.DB.prepare(
      "SELECT points FROM visitors WHERE user_id = ?"
    ).bind(userId).first();

    if (!user) {
      return json({ error: "USER_NOT_FOUND" }, 404);
    }

    const mission = await env.DB.prepare(`
      SELECT status
      FROM mission_submissions
      WHERE user_id = ? AND mission_id = 1
    `).bind(userId).first();

    const completed = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM mission_submissions
      WHERE user_id = ? AND status = 'approved'
    `).bind(userId).first();

    return json({
      success: true,
      points: Number(user.points || 0),
      mission1: mission?.status || "not_submitted",
      completedMissions: Number(completed?.total || 0)
    });

  } catch (error) {
    return json({ error: "MISSION_STATUS_FAILED" }, 500);
  }
}
