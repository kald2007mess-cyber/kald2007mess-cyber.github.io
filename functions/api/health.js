import { json } from "./_lib/session.js";

export async function onRequestGet({ env }) {
  const result = {
    ok: true,
    dbBinding: Boolean(env.DB),
    sessionSecret: Boolean(env.SESSION_SECRET),
    database: false,
    tables: {
      visitors: false,
      referrals: false,
      news_posts: false,
      oxide_admin_missions: false,
      mission_submissions: false
    }
  };

  if (env.DB) {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      result.database = true;

      const names = Object.keys(result.tables);
      for (const name of names) {
        try {
          const row = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
          ).bind(name).first();
          result.tables[name] = Boolean(row);
        } catch {}
      }
    } catch {
      result.database = false;
    }
  }

  result.ok = result.dbBinding && result.sessionSecret && result.database;
  return json(result, result.ok ? 200 : 503);
}
