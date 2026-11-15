import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function ensureRedemptionOrdersTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_redemption_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      display_id TEXT NOT NULL,
      offer_id INTEGER NOT NULL,
      offer_name TEXT NOT NULL,
      points_cost INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      telegram_message_id INTEGER,
      refund_token TEXT
    )
  `).run();

  const columns = await DB.prepare("PRAGMA table_info(oxide_redemption_orders)").all();
  if (!(columns.results || []).some(column => column.name === "user_uuid_input")) {
    await DB.prepare("ALTER TABLE oxide_redemption_orders ADD COLUMN user_uuid_input TEXT").run();
  }
}

async function ensureNotificationsTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      reward_points INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      claimed_at INTEGER,
      claim_token TEXT
    )
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_oxide_notifications_user
    ON oxide_notifications(user_id, created_at DESC)
  `).run();
}

async function notifyUser(DB, userId, type, title, body) {
  await ensureNotificationsTable(DB);
  await DB.prepare(`
    INSERT INTO oxide_notifications(user_id,type,title,body,reward_points,created_at)
    VALUES(?,?,?,?,0,?)
  `).bind(userId, type, title, body, Math.floor(Date.now() / 1000)).run();
}

async function getReviewItems(DB, type) {
  if (type === "missions") {
    const result = await DB.prepare(`
      SELECT s.id, s.user_id, s.mission_id, s.proof_file_id, s.created_at,
             m.title AS mission_title, m.reward_points,
             v.points, v.created_at AS user_created_at,
             CASE WHEN s.proof_file_id IS NOT NULL AND s.proof_file_id != ''
                       AND s.proof_file_id != 'uploading' THEN 1 ELSE 0 END AS proof_available
      FROM mission_submissions s
      JOIN oxide_admin_missions m ON m.id = s.mission_id
      LEFT JOIN visitors v ON v.user_id = s.user_id
      WHERE s.status = 'pending'
      ORDER BY s.created_at ASC, s.id ASC
      LIMIT 50
    `).all();
    return result.results || [];
  }

  const result = await DB.prepare(`
    SELECT o.id, o.user_id, o.display_id, o.offer_id, o.offer_name,
           o.points_cost, o.user_uuid_input, o.created_at,
           v.points, v.created_at AS user_created_at,
           (SELECT COUNT(*) FROM mission_submissions s
             WHERE s.user_id = o.user_id AND s.status = 'approved') AS completed_missions,
           (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id = o.user_id) AS invited_friends
    FROM oxide_redemption_orders o
    LEFT JOIN visitors v ON v.user_id = o.user_id
    WHERE o.status = 'pending'
    ORDER BY o.created_at ASC, o.id ASC
    LIMIT 50
  `).all();
  return result.results || [];
}

async function reviewMission(DB, id, decision) {
  const submission = await DB.prepare(`
    SELECT s.id, s.user_id, s.mission_id, s.status, m.title, m.reward_points
    FROM mission_submissions s
    JOIN oxide_admin_missions m ON m.id = s.mission_id
    WHERE s.id = ?
  `).bind(id).first();

  if (!submission || submission.status !== "pending") {
    return { success: false, status: 409, error: "REQUEST_NOT_PENDING" };
  }

  const now = Math.floor(Date.now() / 1000);
  const reward = Math.max(0, Math.floor(Number(submission.reward_points) || 0));

  if (decision === "approve") {
    const results = await DB.batch([
      DB.prepare(`
        UPDATE visitors SET points = points + ?
        WHERE user_id = ? AND EXISTS (
          SELECT 1 FROM mission_submissions
          WHERE id = ? AND status = 'pending'
        )
      `).bind(reward, submission.user_id, id),
      DB.prepare(`
        UPDATE mission_submissions
        SET status = 'approved', reviewed_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, id)
    ]);

    if (Number(results[0]?.meta?.changes || 0) !== 1 ||
        Number(results[1]?.meta?.changes || 0) !== 1) {
      return { success: false, status: 409, error: "REQUEST_ALREADY_REVIEWED" };
    }

    await notifyUser(DB, submission.user_id, "mission_approved",
      "✅ تمت الموافقة على مهمتك",
      "تم قبول المهمة " + String(submission.title || "") +
      " وإضافة " + reward.toLocaleString() + " نقطة إلى رصيدك.");
    return { success: true, message: "تم قبول المهمة وإضافة " + reward.toLocaleString() + " نقطة للمستخدم." };
  }

  const rejected = await DB.prepare(`
    UPDATE mission_submissions SET status = 'rejected', reviewed_at = ?
    WHERE id = ? AND status = 'pending'
  `).bind(now, id).run();

  if (Number(rejected.meta?.changes || 0) !== 1) {
    return { success: false, status: 409, error: "REQUEST_ALREADY_REVIEWED" };
  }

  await notifyUser(DB, submission.user_id, "mission_rejected",
    "❌ تم رفض إثبات المهمة",
    "لم يتم قبول إثبات المهمة " + String(submission.title || "") +
    ". راجع المطلوب وأرسل إثباتًا صحيحًا جديدًا.");
  return { success: true, message: "تم رفض المهمة. يمكن للمستخدم إرسال دليل جديد." };
}

async function reviewRedemption(DB, id, decision) {
  const order = await DB.prepare(`
    SELECT id, user_id, display_id, offer_name, points_cost, status
    FROM oxide_redemption_orders WHERE id = ?
  `).bind(id).first();

  if (!order || order.status !== "pending") {
    return { success: false, status: 409, error: "REQUEST_NOT_PENDING" };
  }

  const now = Math.floor(Date.now() / 1000);
  const points = Math.max(0, Math.floor(Number(order.points_cost) || 0));

  if (decision === "approve") {
    const updated = await DB.prepare(`
      UPDATE oxide_redemption_orders SET status = 'approved', reviewed_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, id).run();

    if (Number(updated.meta?.changes || 0) !== 1) {
      return { success: false, status: 409, error: "REQUEST_ALREADY_REVIEWED" };
    }

    await notifyUser(DB, order.user_id, "redemption_approved",
      "✅ تمت الموافقة على طلب الاستبدال",
      "تم قبول طلبك رقم #" + id + " للعرض " +
      String(order.offer_name) + ". تم اعتماد الاستبدال من الإدارة.");
    return { success: true, message: "تمت الموافقة على طلب الاستبدال." };
  }

  const refundToken = crypto.randomUUID();
  const results = await DB.batch([
    DB.prepare(`
      UPDATE oxide_redemption_orders
      SET status = 'rejected', reviewed_at = ?, refund_token = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, refundToken, id),
    DB.prepare(`
      UPDATE visitors SET points = points + (
        SELECT points_cost FROM oxide_redemption_orders
        WHERE id = ? AND refund_token = ?
      )
      WHERE user_id = (
        SELECT user_id FROM oxide_redemption_orders
        WHERE id = ? AND refund_token = ?
      )
      AND EXISTS (
        SELECT 1 FROM oxide_redemption_orders
        WHERE id = ? AND refund_token = ?
      )
    `).bind(id, refundToken, id, refundToken, id, refundToken)
  ]);

  if (Number(results[0]?.meta?.changes || 0) !== 1 ||
      Number(results[1]?.meta?.changes || 0) !== 1) {
    return { success: false, status: 409, error: "REDEMPTION_REFUND_FAILED" };
  }

  await notifyUser(DB, order.user_id, "redemption_rejected",
    "❌ تم رفض طلب الاستبدال",
    "تم رفض طلبك رقم #" + id + " للعرض " + String(order.offer_name) +
    " وإعادة " + points.toLocaleString() + " نقطة إلى رصيدك.");
  return { success: true, message: "تم رفض الطلب وإعادة " + points.toLocaleString() + " نقطة للمستخدم." };
}

async function getProofResponse(env, initData, submissionId) {
  const auth = await authorizeAdmin(initData, env, "tasks");
  if (!auth.ok) return adminAuthResponse(auth);

  const row = await env.DB.prepare(`
    SELECT proof_file_id FROM mission_submissions
    WHERE id = ? AND status = 'pending'
  `).bind(submissionId).first();

  if (!row?.proof_file_id || row.proof_file_id === "uploading") {
    return json({ success: false, error: "PROOF_NOT_FOUND" }, 404);
  }

  const infoResponse = await fetch(
    "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN +
    "/getFile?file_id=" + encodeURIComponent(row.proof_file_id)
  );
  const info = await infoResponse.json();
  const filePath = info?.result?.file_path;
  if (!infoResponse.ok || !info.ok || !filePath) {
    return json({ success: false, error: "TELEGRAM_FILE_LOOKUP_FAILED" }, 502);
  }

  const fileResponse = await fetch(
    "https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + filePath
  );
  if (!fileResponse.ok) return json({ success: false, error: "PROOF_DOWNLOAD_FAILED" }, 502);

  return new Response(fileResponse.body, {
    status: 200,
    headers: {
      "Content-Type": fileResponse.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const body = await request.json();
    const action = String(body.action || "");

    if (action === "proof") {
      const submissionId = Number(body.submissionId);
      if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
        return json({ success: false, error: "INVALID_REQUEST_ID" }, 400);
      }
      return await getProofResponse(env, String(body.initData || ""), submissionId);
    }

    const auth = await authorizeAdmin(String(body.initData || ""), env, "tasks");
    if (!auth.ok) return adminAuthResponse(auth);

    if (action === "list") {
      const type = String(body.type || "");
      if (!["missions", "redemptions"].includes(type)) {
        return json({ success: false, error: "INVALID_REVIEW_TYPE" }, 400);
      }
      if (type === "redemptions") await ensureRedemptionOrdersTable(env.DB);
      const items = await getReviewItems(env.DB, type);
      return json({ success: true, items, more: items.length === 50 });
    }

    if (action === "review") {
      const type = String(body.type || "");
      const id = Number(body.id);
      const decision = String(body.decision || "");
      if (!["missions", "redemptions"].includes(type) ||
          !Number.isSafeInteger(id) || id < 1 ||
          !["approve", "reject"].includes(decision)) {
        return json({ success: false, error: "INVALID_REVIEW_ACTION" }, 400);
      }
      if (type === "redemptions") await ensureRedemptionOrdersTable(env.DB);
      const result = type === "missions"
        ? await reviewMission(env.DB, id, decision)
        : await reviewRedemption(env.DB, id, decision);
      return json(result, result.status || (result.success ? 200 : 400));
    }

    return json({ success: false, error: "INVALID_ACTION" }, 400);
  } catch (error) {
    return json({
      success: false,
      error: "ADMIN_REVIEWS_ERROR",
      details: String(error?.message || error)
    }, 500);
  }
}
