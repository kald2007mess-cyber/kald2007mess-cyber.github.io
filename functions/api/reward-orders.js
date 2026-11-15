import { getVisitor, json } from "./_lib/session.js";

async function ensureOrdersTable(DB) {
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
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_oxide_redemption_user
    ON oxide_redemption_orders(user_id, created_at DESC)
  `).run();
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    const userId = await getVisitor(request, env);
    if (!userId) return json({ success: false, error: "NO_VISITOR_SESSION" }, 401);
    await ensureOrdersTable(env.DB);
    const result = await env.DB.prepare(`
      SELECT id, offer_name, points_cost, status, created_at, reviewed_at
      FROM oxide_redemption_orders WHERE user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 30
    `).bind(userId).all();
    return json({ success: true, orders: result.results || [] });
  } catch {
    return json({ success: false, error: "REWARD_ORDERS_LOAD_FAILED" }, 500);
  }
}
