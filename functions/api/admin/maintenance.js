
import { json } from "../_lib/session.js";
import {
  authorizeAdmin,
  adminAuthResponse
} from "../_lib/admin-auth.js";

const DEFAULT_MESSAGE =
  "نعتذر عن الإزعاج، الموقع تحت الصيانة حالياً. سنعود قريباً.";

async function readSettings(env) {
  const result = await env.DB.prepare(
    "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN (?, ?)"
  ).bind(
    "maintenance_enabled",
    "maintenance_message"
  ).all();

  const settings = {};

  for (const row of result.results || []) {
    settings[row.setting_key] = row.setting_value;
  }

  return {
    maintenance: settings.maintenance_enabled === "1",
    message: settings.maintenance_message || DEFAULT_MESSAGE
  };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({
        success: false,
        error: "SERVER_CONFIG"
      }, 500);
    }

    const body = await request.json();

    const auth = await authorizeAdmin(
      String(body.initData || ""),
      env,
      "maintenance"
    );

    if (!auth.ok) {
      return adminAuthResponse(auth);
    }

    if (body.action === "get") {
      return json({
        success: true,
        ...(await readSettings(env))
      });
    }

    if (body.action !== "save") {
      return json({
        success: false,
        error: "INVALID_ACTION"
      }, 400);
    }

    if (typeof body.maintenance !== "boolean") {
      return json({
        success: false,
        error: "INVALID_STATUS"
      }, 400);
    }

    const message = String(body.message || "").trim();

    if (!message || message.length > 1000) {
      return json({
        success: false,
        error: "INVALID_MESSAGE"
      }, 400);
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO site_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at`
      ).bind(
        "maintenance_enabled",
        body.maintenance ? "1" : "0",
        now
      ),

      env.DB.prepare(
        `INSERT INTO site_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at`
      ).bind(
        "maintenance_message",
        message,
        now
      )
    ]);

    return json({
      success: true,
      maintenance: body.maintenance,
      message
    });

  } catch (error) {
    console.error("Admin maintenance error:", error);

    return json({
      success: false,
      error: "MAINTENANCE_FAILED"
    }, 500);
  }
}
