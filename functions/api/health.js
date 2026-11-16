import { json } from "./_lib/session.js";

const REQUIRED_TABLES = [
  "users",
  "referrals",
  "missions",
  "mission_submissions",
  "notifications",
  "point_ledger",
  "app_sessions",
  "identity_migrations",
  "migration_claims",
  "app_settings",
  "admin_permissions"
];

export async function onRequestGet({ env }) {
  const result = {
    ok: false,
    dbBinding: Boolean(env.DB),
    sessionSecret: Boolean(env.SESSION_SECRET),
    database: false,
    tables: Object.fromEntries(REQUIRED_TABLES.map(name => [name, false]))
  };

  if (env.DB) {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      result.database = true;

      for (const name of REQUIRED_TABLES) {
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

  const allTablesPresent = Object.values(result.tables).every(Boolean);
  result.ok = result.dbBinding && result.sessionSecret &&
    result.database && allTablesPresent;

  return json(result, result.ok ? 200 : 503);
}
