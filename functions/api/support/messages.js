
import { getVisitor, json } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "No visitor session" }, 401);
    }

    const conversation = await env.DB.prepare(`
      SELECT id
      FROM support_conversations
      WHERE user_id = ?
    `).bind(userId).first();

    if (!conversation) {
      return json({
        success: true,
        messages: []
      });
    }

    const url = new URL(request.url);
    const afterId = Math.max(
      0,
      Number(url.searchParams.get("after") || 0)
    );

    const result = await env.DB.prepare(`
      SELECT
        id,
        sender,
        message_type,
        message_text,
        media_file_id,
        created_at
      FROM support_messages
      WHERE conversation_id = ?
        AND id > ?
      ORDER BY id ASC
      LIMIT 100
    `).bind(conversation.id, afterId).all();

    return json({
      success: true,
      messages: result.results || []
    });

  } catch {
    return json({
      error: "Could not load support messages"
    }, 500);
  }
}
