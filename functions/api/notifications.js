import { getVisitor, json } from "./_lib/session.js";

async function ensureTable(DB) {
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
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_oxide_notifications_user ON oxide_notifications(user_id, created_at DESC)`).run();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success:false, error:"SERVER_CONFIGURATION_MISSING" },500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success:false, error:"NO_VISITOR_SESSION" },401);
    await ensureTable(env.DB);
    const rows = await env.DB.prepare(`
      SELECT id, type, title, body, reward_points, created_at, read_at, claimed_at
      FROM oxide_notifications
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `).bind(userId).all();
    return json({ success:true, notifications:rows.results || [] });
  } catch (error) {
    return json({ success:false, error:"NOTIFICATIONS_LOAD_FAILED" },500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success:false, error:"SERVER_CONFIGURATION_MISSING" },500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success:false, error:"NO_VISITOR_SESSION" },401);
    await ensureTable(env.DB);
    const body = await request.json();
    if (body.action === "read_all") {
      await env.DB.prepare(`
        UPDATE oxide_notifications SET read_at = COALESCE(read_at, ?)
        WHERE user_id = ? AND read_at IS NULL
      `).bind(Math.floor(Date.now()/1000), userId).run();
      return json({ success:true });
    }
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ success:false, error:"INVALID_NOTIFICATION" },400);
    if (body.action === "read") {
      await env.DB.prepare(`
        UPDATE oxide_notifications SET read_at = COALESCE(read_at, ?)
        WHERE id = ? AND user_id = ?
      `).bind(Math.floor(Date.now()/1000), id, userId).run();
      return json({ success:true });
    }

    if (body.action !== "claim") return json({ success:false, error:"INVALID_ACTION" },400);
    const token = crypto.randomUUID();
    const now = Math.floor(Date.now()/1000);
    const result = await env.DB.batch([
      env.DB.prepare(`
        UPDATE oxide_notifications
        SET claimed_at = ?, read_at = COALESCE(read_at, ?), claim_token = ?
        WHERE id = ? AND user_id = ? AND type = 'reward'
          AND reward_points > 0 AND claimed_at IS NULL
      `).bind(now, now, token, id, userId),
      env.DB.prepare(`
        UPDATE visitors SET points = points + (
          SELECT reward_points FROM oxide_notifications
          WHERE id = ? AND user_id = ? AND claim_token = ?
        )
        WHERE user_id = ? AND EXISTS (
          SELECT 1 FROM oxide_notifications
          WHERE id = ? AND user_id = ? AND claim_token = ?
        )
      `).bind(id,userId,token,userId,id,userId,token)
    ]);
    const claimed = Number(result[0]?.meta?.changes || 0);
    const credited = Number(result[1]?.meta?.changes || 0);
    if (claimed !== 1 || credited !== 1) return json({ success:false, error:"ALREADY_CLAIMED_OR_NOT_FOUND" },409);
    const user = await env.DB.prepare("SELECT points FROM visitors WHERE user_id = ?").bind(userId).first();
    const notice = await env.DB.prepare("SELECT reward_points FROM oxide_notifications WHERE id = ? AND user_id = ?").bind(id,userId).first();
    return json({ success:true, pointsAwarded:Number(notice?.reward_points || 0), balance:Number(user?.points || 0) });
  } catch (error) {
    return json({ success:false, error:"NOTIFICATION_ACTION_FAILED" },500);
  }
}
