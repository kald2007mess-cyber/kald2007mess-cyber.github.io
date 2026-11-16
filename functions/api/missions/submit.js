import { getVisitor, json } from "../_lib/session.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.DB ||
      !env.SESSION_SECRET ||
      !env.TELEGRAM_BOT_TOKEN ||
      !env.TELEGRAM_ADMIN_ID
    ) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) return json({ error: "NO_VISITOR_SESSION" }, 401);

    const user = await env.DB.prepare(`
      SELECT user_uuid, public_id, status
      FROM users
      WHERE user_uuid = ?
      LIMIT 1
    `).bind(userId).first();

    if (!user || user.status !== "active") {
      return json({ error: "USER_NOT_AVAILABLE" }, 404);
    }

    const form = await request.formData();
    const proof = form.get("proof");
    const missionId = Number(form.get("missionId"));

    if (!Number.isSafeInteger(missionId) || missionId <= 0) {
      return json({ error: "INVALID_MISSION_ID" }, 400);
    }

    const mission = await env.DB.prepare(`
      SELECT id, title, platform, reward_points
      FROM missions
      WHERE id = ? AND enabled = 1
      LIMIT 1
    `).bind(missionId).first();

    if (!mission) return json({ error: "MISSION_NOT_AVAILABLE" }, 404);

    if (
      !proof ||
      typeof proof.arrayBuffer !== "function" ||
      !String(proof.type || "").startsWith("image/") ||
      Number(proof.size) <= 0 ||
      Number(proof.size) > MAX_IMAGE_BYTES
    ) {
      return json({ error: "INVALID_IMAGE" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const inserted = await env.DB.prepare(`
      INSERT INTO mission_submissions
        (user_uuid, mission_id, status, proof_file_key, created_at, reviewed_at)
      VALUES (?, ?, 'pending', 'uploading', ?, NULL)
      ON CONFLICT(user_uuid, mission_id) DO UPDATE SET
        status = 'pending',
        proof_file_key = 'uploading',
        created_at = excluded.created_at,
        reviewed_at = NULL,
        reviewer_telegram_id = NULL
      WHERE mission_submissions.status = 'rejected'
      RETURNING id
    `).bind(userId, missionId, now).first();

    if (!inserted?.id) {
      const existing = await env.DB.prepare(`
        SELECT status
        FROM mission_submissions
        WHERE user_uuid = ? AND mission_id = ?
        LIMIT 1
      `).bind(userId, missionId).first();

      if (existing?.status === "approved") {
        return json({ error: "MISSION_ALREADY_COMPLETED" }, 409);
      }
      return json({ error: "ALREADY_PENDING" }, 409);
    }

    const submissionId = Number(inserted.id);
    const displayId = user.public_id || (
      "OX-" + userId.replace(/-/g, "").slice(0, 8).toUpperCase()
    );
    const reward = Math.max(0, Math.floor(Number(mission.reward_points) || 0));

    const caption =
      "🎮 OXIDE HUB — MISSION REVIEW\n\n" +
      "📌 Mission: " + String(mission.title || "").slice(0, 150) + "\n" +
      "🆔 Mission ID: #" + missionId + "\n" +
      "🎁 Reward: " + reward + " points\n" +
      "👤 User: " + displayId + "\n" +
      "🧾 Submission: #" + submissionId + "\n\n" +
      "Review the screenshot and choose:";

    const upload = new FormData();
    upload.set("chat_id", String(env.TELEGRAM_ADMIN_ID));
    upload.set("caption", caption);
    upload.set("photo", proof, proof.name || "mission-proof.jpg");
    upload.set("reply_markup", JSON.stringify({
      inline_keyboard: [[
        { text: "موافقة ✅", callback_data: `oxide_mission:approve:${submissionId}` },
        { text: "رفض ❌", callback_data: `oxide_mission:reject:${submissionId}` }
      ]]
    }));

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
      { method: "POST", body: upload }
    );
    const telegramResult = await telegramResponse.json();

    if (!telegramResponse.ok || !telegramResult.ok) {
      await env.DB.prepare(`
        UPDATE mission_submissions
        SET status = 'rejected', proof_file_key = NULL, reviewed_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, submissionId).run();
      return json({ error: "TELEGRAM_DELIVERY_FAILED" }, 502);
    }

    const telegramFileId = String(
      telegramResult.result.photo?.at(-1)?.file_id || ""
    );
    if (!telegramFileId) {
      await env.DB.prepare(`
        UPDATE mission_submissions
        SET status = 'rejected', proof_file_key = NULL, reviewed_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, submissionId).run();
      return json({ error: "TELEGRAM_PROOF_ID_MISSING" }, 502);
    }

    await env.DB.prepare(`
      UPDATE mission_submissions
      SET proof_file_key = ?
      WHERE id = ? AND status = 'pending'
    `).bind(telegramFileId, submissionId).run();

    return json({ success: true, status: "pending", missionId });
  } catch (error) {
    console.error("Mission submission failed:", error);
    return json({ error: "MISSION_SUBMISSION_FAILED" }, 500);
  }
}
