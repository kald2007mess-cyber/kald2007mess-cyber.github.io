
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(message)
    )
  );
}

function toHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyAdmin(initData, env) {
  if (!initData || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
    return false;
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userText = params.get("user");

  if (!receivedHash || !authDate || !userText) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > 86400 || authDate > now + 60) return false;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // Telegram WebApp HMAC verification
  const secretKey = await hmac(
    new TextEncoder().encode("WebAppData"),
    env.TELEGRAM_BOT_TOKEN
  );

  const calculatedHash = toHex(
    await hmac(secretKey, dataCheckString)
  );

  if (calculatedHash !== receivedHash) return false;

  try {
    const user = JSON.parse(userText);
    return String(user.id) === String(env.TELEGRAM_ADMIN_ID);
  } catch {
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    }

    const body = await request.json();

    if (!(await verifyAdmin(body.initData, env))) {
      return json({ success: false, error: "UNAUTHORIZED" }, 401);
    }

    if (body.action === "list") {
      const result = await env.DB.prepare(`
        SELECT
          m.id,
          m.title,
          m.platform,
          m.description,
          m.target_url,
          m.reward_points,
          m.enabled,
          m.sort_order,
          m.created_at,
          m.updated_at,
          (SELECT COUNT(*) FROM mission_submissions s
            WHERE s.mission_id = m.id AND s.status = 'approved') AS completed_count,
          (SELECT COUNT(*) FROM mission_submissions s
            WHERE s.mission_id = m.id AND s.status = 'pending') AS pending_count,
          (SELECT COUNT(*) FROM mission_submissions s
            WHERE s.mission_id = m.id AND s.status = 'rejected') AS rejected_count
        FROM oxide_admin_missions m
        ORDER BY m.sort_order ASC, m.id ASC
      `).all();

      return json({ success: true, tasks: result.results || [] });
    }

    if (body.action === "save") {
      const id = Number(body.id || 0);
      const title = String(body.title || "").trim();
      const platform = String(body.platform || "").trim().toLowerCase();
      const description = String(body.description || "").trim();
      const targetUrl = String(body.target_url || "").trim();
      const rewardPoints = Number(body.reward_points);
      const enabled = Number(body.enabled) === 1 ? 1 : 0;
      const sortOrder = Number(body.sort_order || 0);

      if (!title || title.length > 120) {
        return json({ success: false, error: "INVALID_TITLE" }, 400);
      }

      if (!["tiktok", "telegram"].includes(platform)) {
        return json({ success: false, error: "INVALID_PLATFORM" }, 400);
      }

      if (!Number.isInteger(rewardPoints) || rewardPoints < 0 || rewardPoints > 100000) {
        return json({ success: false, error: "INVALID_REWARD" }, 400);
      }

      if (targetUrl && !/^https:\/\/\S+$/i.test(targetUrl)) {
        return json({ success: false, error: "INVALID_URL" }, 400);
      }

      if (id > 0) {
        const result = await env.DB.prepare(`
          UPDATE oxide_admin_missions
          SET title = ?, platform = ?, description = ?, target_url = ?,
              reward_points = ?, enabled = ?, sort_order = ?,
              updated_at = unixepoch()
          WHERE id = ?
        `).bind(
          title, platform, description, targetUrl,
          rewardPoints, enabled, sortOrder, id
        ).run();

        if (!result.meta.changes) {
          return json({ success: false, error: "TASK_NOT_FOUND" }, 404);
        }

        return json({ success: true, message: "TASK_UPDATED" });
      }

      const next = await env.DB.prepare(`
        SELECT COALESCE(MAX(id), 0) + 1 AS next_id
        FROM oxide_admin_missions
      `).first();

      await env.DB.prepare(`
        INSERT INTO oxide_admin_missions
        (id, title, platform, description, target_url,
         reward_points, enabled, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        next.next_id, title, platform, description,
        targetUrl, rewardPoints, enabled, sortOrder
      ).run();

      return json({
        success: true,
        id: next.next_id,
        message: "TASK_CREATED"
      });
    }

    if (body.action === "toggle") {
      const id = Number(body.id);
      const enabled = Number(body.enabled) === 1 ? 1 : 0;

      if (!Number.isInteger(id) || id < 1) {
        return json({ success: false, error: "INVALID_ID" }, 400);
      }

      const result = await env.DB.prepare(`
        UPDATE oxide_admin_missions
        SET enabled = ?, updated_at = unixepoch()
        WHERE id = ?
      `).bind(enabled, id).run();

      if (!result.meta.changes) {
        return json({ success: false, error: "TASK_NOT_FOUND" }, 404);
      }

      return json({ success: true, message: "TASK_STATUS_UPDATED" });
    }

    if (body.action === "delete") {
      const id = Number(body.id);

      if (!Number.isInteger(id) || id < 1) {
        return json({ success: false, error: "INVALID_ID" }, 400);
      }

      const submissions = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM mission_submissions
        WHERE mission_id = ?
      `).bind(id).first();

      if (Number(submissions?.total || 0) > 0) {
        return json({
          success: false,
          error: "TASK_HAS_SUBMISSIONS_DISABLE_INSTEAD"
        }, 409);
      }

      const result = await env.DB.prepare(`
        DELETE FROM oxide_admin_missions WHERE id = ?
      `).bind(id).run();

      if (!result.meta.changes) {
        return json({ success: false, error: "TASK_NOT_FOUND" }, 404);
      }

      return json({ success: true, message: "TASK_DELETED" });
    }

    if (body.action === "completed") {
      const missionId = Number(body.missionId);
      const page = Math.max(1, Number(body.page) || 1);
      const limit = 50;
      const offset = (page - 1) * limit;

      if (!Number.isInteger(missionId) || missionId < 1) {
        return json({ success: false, error: "INVALID_MISSION_ID" }, 400);
      }

      const total = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM mission_submissions
        WHERE mission_id = ? AND status = 'approved'
      `).bind(missionId).first();

      const users = await env.DB.prepare(`
        SELECT s.user_id, s.created_at, s.reviewed_at, v.points
        FROM mission_submissions s
        LEFT JOIN visitors v ON v.user_id = s.user_id
        WHERE s.mission_id = ? AND s.status = 'approved'
        ORDER BY s.reviewed_at DESC
        LIMIT ? OFFSET ?
      `).bind(missionId, limit, offset).all();

      return json({
        success: true,
        total: Number(total?.total || 0),
        page,
        users: users.results || []
      });
    }

    return json({ success: false, error: "INVALID_ACTION" }, 400);

  } catch (error) {
    return json({
      success: false,
      error: "TASKS_API_ERROR",
      details: String(error?.message || error)
    }, 500);
  }
}
