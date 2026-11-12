
import { getVisitor, json } from "./_lib/session.js";

const ALLOWED_REACTIONS = ["❤️", "😡", "🥺", "👍", "👎"];

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIG_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) {
      return json({ success: false, error: "USER_NOT_FOUND" }, 401);
    }

    const url = new URL(request.url);
    const postId = Number(url.searchParams.get("postId"));

    // Load comments for one post
    if (url.searchParams.has("postId")) {
      if (!Number.isInteger(postId) || postId < 1) {
        return json({ success: false, error: "INVALID_POST_ID" }, 400);
      }

      const post = await env.DB.prepare(
        "SELECT id FROM news_posts WHERE id = ?"
      ).bind(postId).first();

      if (!post) {
        return json({ success: false, error: "POST_NOT_FOUND" }, 404);
      }

      const result = await env.DB.prepare(`
        SELECT user_id, comment, created_at
        FROM news_comments
        WHERE post_id = ?
        ORDER BY created_at ASC
        LIMIT 200
      `).bind(postId).all();

      return json({
        success: true,
        comments: result.results || []
      });
    }

    // Load news posts and reaction counts
    const result = await env.DB.prepare(`
      SELECT
        p.id,
        p.title,
        p.media_type,
        p.views,
        p.created_at,

        (
          SELECT COUNT(*)
          FROM news_comments c
          WHERE c.post_id = p.id
        ) AS comments_count,

        (
          SELECT COUNT(*)
          FROM news_reactions r
          WHERE r.post_id = p.id AND r.reaction = '❤️'
        ) AS heart_count,

        (
          SELECT COUNT(*)
          FROM news_reactions r
          WHERE r.post_id = p.id AND r.reaction = '😡'
        ) AS angry_count,

        (
          SELECT COUNT(*)
          FROM news_reactions r
          WHERE r.post_id = p.id AND r.reaction = '🥺'
        ) AS sad_count,

        (
          SELECT COUNT(*)
          FROM news_reactions r
          WHERE r.post_id = p.id AND r.reaction = '👍'
        ) AS like_count,

        (
          SELECT COUNT(*)
          FROM news_reactions r
          WHERE r.post_id = p.id AND r.reaction = '👎'
        ) AS dislike_count,

        (
          SELECT r.reaction
          FROM news_reactions r
          WHERE r.post_id = p.id AND r.user_id = ?
          LIMIT 1
        ) AS my_reaction

      FROM news_posts p
      ORDER BY p.created_at DESC
      LIMIT 50
    `).bind(userId).all();

    return json({
      success: true,
      posts: result.results || []
    });

  } catch (error) {
    console.error("NEWS GET error:", error);
    return json({ success: false, error: "NEWS_LOAD_FAILED" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIG_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) {
      return json({ success: false, error: "USER_NOT_FOUND" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: "INVALID_JSON" }, 400);
    }

    const action = String(body.action || "");
    const postId = Number(body.postId);

    if (!Number.isInteger(postId) || postId < 1) {
      return json({ success: false, error: "INVALID_POST_ID" }, 400);
    }

    const post = await env.DB.prepare(
      "SELECT id FROM news_posts WHERE id = ?"
    ).bind(postId).first();

    if (!post) {
      return json({ success: false, error: "POST_NOT_FOUND" }, 404);
    }

    // Count a view
    if (action === "view") {
      await env.DB.prepare(`
        UPDATE news_posts
        SET views = views + 1
        WHERE id = ?
      `).bind(postId).run();

      return json({ success: true });
    }

    // Add a comment
    if (action === "comment") {
      const comment = String(body.comment || "").trim();

      if (!comment || comment.length > 1000) {
        return json({ success: false, error: "INVALID_COMMENT" }, 400);
      }

      await env.DB.prepare(`
        INSERT INTO news_comments
          (post_id, user_id, comment, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(
        postId,
        userId,
        comment,
        Math.floor(Date.now() / 1000)
      ).run();

      return json({ success: true });
    }

    // Add or change one reaction per user per post
    if (action === "reaction") {
      const reaction = String(body.reaction || "");

      if (!ALLOWED_REACTIONS.includes(reaction)) {
        return json({ success: false, error: "INVALID_REACTION" }, 400);
      }

      await env.DB.prepare(`
        INSERT INTO news_reactions
          (post_id, user_id, reaction, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(post_id, user_id)
        DO UPDATE SET
          reaction = excluded.reaction,
          created_at = excluded.created_at
      `).bind(
        postId,
        userId,
        reaction,
        Math.floor(Date.now() / 1000)
      ).run();

      return json({ success: true });
    }

    return json({ success: false, error: "INVALID_ACTION" }, 400);

  } catch (error) {
    console.error("NEWS POST error:", error);
    return json({ success: false, error: "NEWS_ACTION_FAILED" }, 500);
  }
}
