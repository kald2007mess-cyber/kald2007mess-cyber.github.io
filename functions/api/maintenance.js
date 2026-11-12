
import { json } from "./_lib/session.js";

const DEFAULT_MESSAGE =
  "نعتذر عن الإزعاج، الموقع تحت الصيانة حالياً. سنعود قريباً.";

export async function onRequestGet({ env }) {
  try {
    if (!env.DB) {
      return json({ success: false, error: "DATABASE_ERROR" }, 500);
    }

    const result = await env.DB.prepare(
      "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN (?, ?)"
    ).bind("maintenance_enabled", "maintenance_message").all();

    const settings = {};
    for (const row of result.results || []) {
      settings[row.setting_key] = row.setting_value;
    }

    return json({
      success: true,
      maintenance: settings.maintenance_enabled === "1",
      message: settings.maintenance_message || DEFAULT_MESSAGE
    });
  } catch (error) {
    console.error("Maintenance GET error:", error);
    return json({ success: false, error: "MAINTENANCE_LOAD_FAILED" }, 500);
  }
}
