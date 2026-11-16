import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_VISITOR_SESSION" }, 401);

    const rows = await env.DB.prepare(`
      SELECT id, type, title, body, reward_points, created_at, read_at, claimed_at
      FROM notifications
      WHERE user_uuid = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `).bind(userUuid).all();

    return json({ success: true, notifications: rows.results || [] });
  } catch (error) {
    console.error("Notifications load failed:", error);
    return json({ success: false, error: "NOTIFICATIONS_LOAD_FAILED" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }
    const userUuid = await getVisitor(request, env);
    if (!userUuid) return json({ success: false, error: "NO_VISITOR_SESSION" }, 401);

    const user = await env.DB.prepare(`
      SELECT user_uuid, status
      FROM users
      WHERE user_uuid = ?
      LIMIT 1
    `).bind(userUuid).first();
    if (!user || user.status !== "active") {
      return json({ success: false, error: "USER_NOT_AVAILABLE" }, 404);
    }

    const body = await request.json();
    const now = Math.floor(Date.now() / 1000);

    if (body.action === "delete_read") {
      const result = await env.DB.prepare(`
        DELETE FROM notifications
        WHERE user_uuid = ? AND read_at IS NOT NULL
      `).bind(userUuid).run();
      return json({ success: true, deleted: Number(result.meta?.changes || 0) });
    }

    if (body.action === "read_all") {
      await env.DB.prepare(`
        UPDATE notifications SET read_at = COALESCE(read_at, ?)
        WHERE user_uuid = ? AND read_at IS NULL
      `).bind(now, userUuid).run();
      return json({ success: true });
    }

    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return json({ success: false, error: "INVALID_NOTIFICATION" }, 400);
    }

    if (body.action === "read") {
      await env.DB.prepare(`
        UPDATE notifications SET read_at = COALESCE(read_at, ?)
        WHERE id = ? AND user_uuid = ?
      `).bind(now, id, userUuid).run();
      return json({ success: true });
    }

    if (body.action !== "claim") {
      return json({ success: false, error: "INVALID_ACTION" }, 400);
    }

    const claimed = await env.DB.prepare(`
      UPDATE notifications
      SET claimed_at = ?, read_at = COALESCE(read_at, ?)
      WHERE id = ? AND user_uuid = ? AND type = 'reward'
        AND reward_points > 0 AND claimed_at IS NULL
      RETURNING reward_points
    `).bind(now, now, id, userUuid).first();

    if (!claimed) {
      return json({ success: false, error: "ALREADY_CLAIMED_OR_NOT_FOUND" }, 409);
    }

    const points = Math.max(0, Math.floor(Number(claimed.reward_points) || 0));
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE users
        SET points = COALESCE(points, 0) + ?, updated_at = ?
        WHERE user_uuid = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM notifications
            WHERE id = ? AND user_uuid = ? AND claimed_at = ?
          )
      `).bind(points, now, userUuid, id, userUuid, now),
      env.DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid, delta, balance_after, reason, reference_type,
           reference_id, admin_telegram_id, created_at)
        SELECT user_uuid, ?, points, 'notification_reward_claimed',
               'notification', ?, NULL, ?
        FROM users
        WHERE user_uuid = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM notifications
            WHERE id = ? AND user_uuid = ? AND claimed_at = ?
          )
      `).bind(points, String(id), now, userUuid, id, userUuid, now)
    ]);

    if (Number(results[0]?.meta?.changes || 0) !== 1) {
      return json({ success: false, error: "USER_NOT_AVAILABLE" }, 404);
    }

    const updatedUser = await env.DB.prepare(`
      SELECT points FROM users WHERE user_uuid = ?
    `).bind(userUuid).first();

    return json({
      success: true,
      pointsAwarded: points,
      balance: Number(updatedUser?.points || 0)
    });
  } catch (error) {
    console.error("Notification action failed:", error);
    return json({ success: false, error: "NOTIFICATION_ACTION_FAILED" }, 500);
  }
}
