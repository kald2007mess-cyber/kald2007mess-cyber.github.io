import {
  authorizeAdmin,
  adminAuthResponse
} from "../_lib/admin-auth.js";
import { ensureMissionColumns } from "../_lib/mission-schema.js";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);

    const body = await request.json();
    const auth = await authorizeAdmin(String(body.initData || ""), env, "tasks");
    if (!auth.ok) return adminAuthResponse(auth);
    await ensureMissionColumns(env.DB);

    if (body.action === "list") {
      const result = await env.DB.prepare(`
        SELECT
          m.id, m.title, m.platform, m.description,
          m.target_url, m.reward_points, m.enabled,
          m.sort_order, m.created_at, m.updated_at,
          (SELECT COUNT(*) FROM mission_submissions s
            WHERE s.mission_id = m.id AND s.status = 'approved') AS completed_count,
          (SELECT COUNT(*) FROM mission_submissions s
            WHERE s.mission_id = m.id AND s.status = 'pending') AS pending_count,
          (SELECT COUNT(*) FROM mission_submissions s
            WHERE s.mission_id = m.id AND s.status = 'rejected') AS rejected_count
        FROM missions m
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
      const sortOrder = Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0;

      if (!title || title.length > 120) return json({ success: false, error: "INVALID_TITLE" }, 400);
      if (!["tiktok", "telegram"].includes(platform)) return json({ success: false, error: "INVALID_PLATFORM" }, 400);
      if (targetUrl && !/^https:\/\/\S+$/i.test(targetUrl)) return json({ success: false, error: "INVALID_URL" }, 400);
      if (!Number.isInteger(rewardPoints) || rewardPoints < 0 || rewardPoints > 100000) {
        return json({ success: false, error: "INVALID_REWARD" }, 400);
      }

      const now = Math.floor(Date.now() / 1000);
      if (id > 0) {
        const result = await env.DB.prepare(`
          UPDATE missions
          SET title = ?, platform = ?, description = ?, target_url = ?,
              reward_points = ?, enabled = ?, sort_order = ?, updated_at = ?
          WHERE id = ?
        `).bind(title, platform, description, targetUrl, rewardPoints, enabled, sortOrder, now, id).run();

        if (Number(result.meta?.changes || 0) !== 1) {
          return json({ success: false, error: "TASK_NOT_FOUND" }, 404);
        }
        return json({ success: true, message: "TASK_UPDATED" });
      }

      const result = await env.DB.prepare(`
        INSERT INTO missions
          (title, description, platform, target_url, reward_points, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).bind(title, description, platform, targetUrl, rewardPoints, enabled, sortOrder, now, now).first();

      return json({ success: true, id: Number(result?.id || 0), message: "TASK_CREATED" });
    }

    if (body.action === "toggle") {
      const id = Number(body.id);
      const enabled = Number(body.enabled) === 1 ? 1 : 0;
      if (!Number.isInteger(id) || id < 1) return json({ success: false, error: "INVALID_ID" }, 400);

      const result = await env.DB.prepare(`
        UPDATE missions SET enabled = ?, updated_at = ? WHERE id = ?
      `).bind(enabled, Math.floor(Date.now() / 1000), id).run();

      if (Number(result.meta?.changes || 0) !== 1) return json({ success: false, error: "TASK_NOT_FOUND" }, 404);
      return json({ success: true, message: "TASK_STATUS_UPDATED" });
    }

    if (body.action === "delete") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) return json({ success: false, error: "INVALID_ID" }, 400);

      const submissions = await env.DB.prepare(`
        SELECT COUNT(*) AS total FROM mission_submissions WHERE mission_id = ?
      `).bind(id).first();

      if (Number(submissions?.total || 0) > 0) {
        return json({ success: false, error: "TASK_HAS_SUBMISSIONS_DISABLE_INSTEAD" }, 409);
      }

      const result = await env.DB.prepare("DELETE FROM missions WHERE id = ?").bind(id).run();
      if (Number(result.meta?.changes || 0) !== 1) return json({ success: false, error: "TASK_NOT_FOUND" }, 404);
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
        SELECT s.user_uuid AS user_id, s.created_at, s.reviewed_at,
               u.public_id, u.points
        FROM mission_submissions s
        LEFT JOIN users u ON u.user_uuid = s.user_uuid
        WHERE s.mission_id = ? AND s.status = 'approved'
        ORDER BY s.reviewed_at DESC, s.id DESC
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
    console.error("Tasks API error:", error);
    return json({ success: false, error: "TASKS_API_ERROR" }, 500);
  }
}
