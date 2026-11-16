import { getVisitor, json } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) return json({ error: "NO_VISITOR_SESSION" }, 401);

    const conversation = await env.DB.prepare(`
      SELECT id
      FROM support_conversations
      WHERE user_uuid = ?
      ORDER BY id DESC
      LIMIT 1
    `).bind(userId).first();

    if (!conversation) return json({ success: true, messages: [] });

    const url = new URL(request.url);
    const rawAfter = Number(url.searchParams.get("after") || 0);
    const afterId = Number.isSafeInteger(rawAfter) && rawAfter > 0 ? rawAfter : 0;

    const result = await env.DB.prepare(`
      SELECT id, sender, message_type, message_text, created_at
      FROM support_messages
      WHERE conversation_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT 100
    `).bind(conversation.id, afterId).all();

    return json({ success: true, messages: result.results || [] });
  } catch (error) {
    console.error("Support messages load failed:", error);
    return json({ error: "SUPPORT_MESSAGES_LOAD_FAILED" }, 500);
  }
}
