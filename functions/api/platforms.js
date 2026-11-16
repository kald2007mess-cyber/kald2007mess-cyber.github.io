import { json } from "./_lib/session.js";
import { ensurePlatformTables } from "./_lib/platform-schema.js";

const R2_PUBLIC_URL = "https://pub-052cdf3a8da44cd2bb81e3b138ebcb45.r2.dev";

function publicTutorialUrl(platform, value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    if (url.origin === R2_PUBLIC_URL) {
      return "/api/tutorial?platform=" + encodeURIComponent(platform);
    }
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export async function onRequestGet({ env }) {
  try {
    if (!env.DB) return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    await ensurePlatformTables(env.DB);
    const result = await env.DB.prepare(`
      SELECT
        id, platform, title, version, description,
        file_name, file_size,
        enabled, created_at, updated_at, slot
      FROM platform_files
      ORDER BY platform, slot ASC, created_at DESC
    `).all();

    const platforms = {
      android: [],
      ios: [],
      beta: []
    };

    for (const row of (result.results || [])) {
      const key = String(row.platform || "").toLowerCase();

      if (!Object.prototype.hasOwnProperty.call(platforms, key)) {
        continue;
      }

      platforms[key].push({
        id: String(row.id),
        platform: key,
        slot: Number(row.slot || 1),
        title: row.title || "",
        version: row.version || "",
        description: row.description || "",
        file_name: row.file_name || "",
         file_size: Number(row.file_size || 0),
        enabled: Number(row.enabled) === 1,
        created_at: Number(row.created_at || 0),
        updated_at: Number(row.updated_at || 0)
      });
    }

    const legacy = await env.DB.prepare(`
      SELECT
        platform, title, version, description,
        file_name, file_size,
        enabled, updated_at
      FROM platform_downloads
      ORDER BY platform
    `).all();

    for (const row of (legacy.results || [])) {
      const key = String(row.platform || "").toLowerCase();

      if (
        Object.prototype.hasOwnProperty.call(platforms, key) &&
        platforms[key].length === 0
      ) {
        platforms[key].push({
          id: "legacy-" + key,
          platform: key,
          slot: 1,
          title: row.title || "",
          version: row.version || "",
          description: row.description || "",
          file_name: row.file_name || "",
           file_size: Number(row.file_size || 0),
          enabled: Number(row.enabled) === 1,
          created_at: 0,
          updated_at: Number(row.updated_at || 0),
          legacy: true
        });
      }
    }

    const tutorialResult = await env.DB.prepare(`
      SELECT platform, video_url, updated_at
      FROM platform_tutorials
    `).all();

    const tutorials = {
      android: "",
      ios: "",
      beta: ""
    };

    for (const row of (tutorialResult.results || [])) {
      const key = String(row.platform || "").toLowerCase();

      if (Object.prototype.hasOwnProperty.call(tutorials, key)) {
        tutorials[key] = publicTutorialUrl(key, row.video_url);
      }
    }

    return json({
      success: true,
      platforms,
      tutorials
    });

  } catch (error) {
    console.error("Platforms API error:", error);

    return json({
      success: false,
      error: "PLATFORM_STATUS_UNAVAILABLE"
    }, 500);
  }
}
