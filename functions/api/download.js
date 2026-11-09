import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "Visitor session missing" }, 401);
    }

    const row = await env.DB.prepare(
      "SELECT progress FROM visitors WHERE user_id = ?"
    ).bind(userId).first();

    const progress = Number(row?.progress || 0);

    if (progress < 5) {
      return json({
        error: "Complete all 5 rewarded actions first",
        progress,
        required: 5
      }, 403);
    }

    // التحميل معطّل حتى نجهّز الملف الحقيقي ونربطه بتخزين آمن.
    return json({
      error: "Download is not configured yet"
    }, 503);

  } catch (error) {
    return json({ error: "Download failed" }, 500);
  }
}
