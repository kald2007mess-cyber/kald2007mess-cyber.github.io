
import { json } from "./_lib/session.js";

export async function onRequestGet({ env }) {
  try {
    const result = await env.DB.prepare(`
      SELECT
        id,
        platform,
        title,
        version,
        description,
        file_name,
        download_url,
        file_size,
        enabled,
        created_at,
        updated_at
      FROM platform_files
      ORDER BY platform, created_at DESC
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
        title: row.title || "",
        version: row.version || "",
        description: row.description || "",
        file_name: row.file_name || "",
        download_url: row.download_url || "",
        file_size: Number(row.file_size || 0),
        enabled: Number(row.enabled) === 1,
        created_at: Number(row.created_at || 0),
        updated_at: Number(row.updated_at || 0)
      });
    }

    // Keep legacy files visible when no new files exist.
    const legacy = await env.DB.prepare(`
      SELECT
        platform,
        title,
        version,
        description,
        file_name,
        download_url,
        file_size,
        enabled,
        updated_at
      FROM platform_downloads
      ORDER BY platform
    `).all();

    for (const row of (legacy.results || [])) {
      const key = String(row.platform || "").toLowerCase();

      if (!Object.prototype.hasOwnProperty.call(platforms, key)) {
        continue;
      }

      if (platforms[key].length === 0) {
        platforms[key].push({
          id: "legacy-" + key,
          platform: key,
          title: row.title || "",
          version: row.version || "",
          description: row.description || "",
          file_name: row.file_name || "",
          download_url: row.download_url || "",
          file_size: Number(row.file_size || 0),
          enabled: Number(row.enabled) === 1,
          created_at: 0,
          updated_at: Number(row.updated_at || 0),
          legacy: true
        });
      }
    }

    return json({
      success: true,
      platforms
    });

  } catch (error) {
    return json({
      success: false,
      error: "PLATFORM_STATUS_UNAVAILABLE"
    }, 500);
  }
}
