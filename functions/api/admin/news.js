
import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp"
];

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function uploadMedia(file, env) {
  if (!file || typeof file === "string" || !file.size) {
    throw new Error("MEDIA_REQUIRED");
  }

  const mime = file.type || "";
  const name = (file.name || "").toLowerCase();

  const isVideo = mime === "video/mp4" || name.endsWith(".mp4");

  const isImage =
    ALLOWED_IMAGE_TYPES.includes(mime) ||
    /\.(jpg|jpeg|png|webp)$/i.test(name);

  if (!isVideo && !isImage) {
    throw new Error("INVALID_MEDIA_TYPE");
  }

  if (isVideo && file.size > MAX_VIDEO_SIZE) {
    throw new Error("VIDEO_TOO_LARGE");
  }

  if (isImage && file.size > MAX_IMAGE_SIZE) {
    throw new Error("IMAGE_TOO_LARGE");
  }

  const method = isVideo ? "sendVideo" : "sendPhoto";
  const fieldName = isVideo ? "video" : "photo";

  const form = new FormData();
  form.append("chat_id", String(env.TELEGRAM_ADMIN_ID));
  form.append(
    fieldName,
    file,
    file.name || (isVideo ? "video.mp4" : "image.jpg")
  );

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      body: form
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      "TELEGRAM_UPLOAD_FAILED: " +
      (result.description || "تعذر رفع الوسائط إلى Telegram")
    );
  }

  let fileId = "";

  if (isVideo) {
    fileId = result.result?.video?.file_id || "";
  } else {
    const photos = result.result?.photo || [];
    fileId = photos.length
      ? photos[photos.length - 1].file_id
      : "";
  }

  if (!fileId) {
    throw new Error("TELEGRAM_FILE_ID_MISSING");
  }

  return {
    media_type: isVideo ? "video" : "photo",
    media_file_id: fileId
  };
}

async function getPosts(env) {
  const result = await env.DB.prepare(`
    SELECT
      p.id,
      p.title,
      p.content,
      p.media_type,
      p.views,
      p.created_at,

      (SELECT COUNT(*) FROM news_comments c
       WHERE c.post_id = p.id) AS comments_count,

      (SELECT COUNT(*) FROM news_reactions r
       WHERE r.post_id = p.id AND r.reaction = '❤️') AS heart_count,

      (SELECT COUNT(*) FROM news_reactions r
       WHERE r.post_id = p.id AND r.reaction = '😡') AS angry_count,

      (SELECT COUNT(*) FROM news_reactions r
       WHERE r.post_id = p.id AND r.reaction = '🥺') AS sad_count,

      (SELECT COUNT(*) FROM news_reactions r
       WHERE r.post_id = p.id AND r.reaction = '👍') AS like_count,

      (SELECT COUNT(*) FROM news_reactions r
       WHERE r.post_id = p.id AND r.reaction = '👎') AS dislike_count

    FROM news_posts p
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 200
  `).all();

  return result.results || [];
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({
        success: false,
        error: "SERVER_CONFIGURATION_MISSING"
      }, 500);
    }

    const contentType = request.headers.get("content-type") || "";
    let initData = "";

    if (contentType.includes("application/json")) {
      const body = await request.clone().json();
      initData = String(body.initData || "");
    } else if (contentType.includes("multipart/form-data")) {
      const form = await request.clone().formData();
      initData = String(form.get("initData") || "");
    }

    const auth = await authorizeAdmin(initData, env, "news");

    if (!auth.ok) {
      return adminAuthResponse(auth);
    }

    // JSON actions: list and delete
    if (contentType.includes("application/json")) {
      const body = await request.json();
      const action = body.action;

      if (action === "list") {
        const posts = await getPosts(env);
        return json({ success: true, posts });
      }

      if (action === "delete") {
        const postId = Number(body.postId);

        if (!Number.isInteger(postId) || postId <= 0) {
          return json({
            success: false,
            error: "INVALID_POST_ID"
          }, 400);
        }

        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM news_comments WHERE post_id = ?"
          ).bind(postId),

          env.DB.prepare(
            "DELETE FROM news_reactions WHERE post_id = ?"
          ).bind(postId),

          env.DB.prepare(
            "DELETE FROM news_posts WHERE id = ?"
          ).bind(postId)
        ]);

        return json({ success: true });
      }

      return json({
        success: false,
        error: "INVALID_ACTION"
      }, 400);
    }

    // FormData actions: create and update
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();

      const action = String(form.get("action") || "");
      const title = String(form.get("title") || "").trim();
      const content = String(form.get("content") || "").trim();
      const postId = Number(form.get("postId") || 0);
      const media = form.get("media");

      if (!title || title.length > 200) {
        return json({
          success: false,
          error: "INVALID_TITLE"
        }, 400);
      }

      if (!content || content.length > 10000) {
        return json({
          success: false,
          error: "INVALID_CONTENT"
        }, 400);
      }

      if (action !== "create" && action !== "update") {
        return json({
          success: false,
          error: "INVALID_ACTION"
        }, 400);
      }

      if (
        action === "update" &&
        (!Number.isInteger(postId) || postId <= 0)
      ) {
        return json({
          success: false,
          error: "INVALID_POST_ID"
        }, 400);
      }

      let oldPost = null;

      if (action === "update") {
        oldPost = await env.DB.prepare(`
          SELECT id, media_type, media_file_id
          FROM news_posts
          WHERE id = ?
        `).bind(postId).first();

        if (!oldPost) {
          return json({
            success: false,
            error: "POST_NOT_FOUND"
          }, 404);
        }
      }

      let mediaData = oldPost
        ? {
            media_type: oldPost.media_type,
            media_file_id: oldPost.media_file_id
          }
        : null;

      if (media && typeof media !== "string" && media.size > 0) {
        mediaData = await uploadMedia(media, env);
      }

      if (!mediaData) {
        return json({
          success: false,
          error: "MEDIA_REQUIRED"
        }, 400);
      }

      if (action === "create") {
        const now = Math.floor(Date.now() / 1000);

        const inserted = await env.DB.prepare(`
          INSERT INTO news_posts
            (title, content, media_type, media_file_id, views, created_at)
          VALUES (?, ?, ?, ?, 0, ?)
        `).bind(
          title,
          content,
          mediaData.media_type,
          mediaData.media_file_id,
          now
        ).run();

        return json({
          success: true,
          id: inserted.meta?.last_row_id
        });
      }

      await env.DB.prepare(`
        UPDATE news_posts
        SET title = ?,
            content = ?,
            media_type = ?,
            media_file_id = ?
        WHERE id = ?
      `).bind(
        title,
        content,
        mediaData.media_type,
        mediaData.media_file_id,
        postId
      ).run();

      return json({
        success: true,
        id: postId
      });
    }

    return json({
      success: false,
      error: "UNSUPPORTED_CONTENT_TYPE"
    }, 400);

  } catch (error) {
    const message = String(error?.message || "SERVER_ERROR");

    return json({
      success: false,
      error: message
    }, 500);
  }
}
