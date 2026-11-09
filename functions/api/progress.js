
import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({
        progress: 0,
        required: 3,
        unlocked: false
      });
    }

    const row = await env.DB.prepare(
      "SELECT progress FROM visitors WHERE user_id = ?"
    ).bind(userId).first();

    const progress = Math.max(
      0,
      Math.min(3, Number(row?.progress || 0))
    );

    return json({
      progress,
      required: 3,
      unlocked: progress >= 3
    });

  } catch (error) {
    return json({ error: "Could not load progress" }, 500);
  }
}
