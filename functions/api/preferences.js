import { getVisitor, json } from "./_lib/session.js";

const LANGUAGES = ["ar", "en", "fr", "es", "de"];

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ success: false, error: "USER_NOT_FOUND" }, 401);
    }

    const visitor = await env.DB.prepare(
      "SELECT language FROM visitors WHERE user_id = ?"
    ).bind(userId).first();

    if (!visitor) {
      return json({ success: false, error: "USER_NOT_FOUND" }, 404);
    }

    const language = LANGUAGES.includes(visitor.language)
      ? visitor.language
      : "ar";

    return json({ success: true, language });

  } catch (error) {
    console.error("Preferences GET error:", error);
    return json({ success: false, error: "Could not load preferences" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ success: false, error: "USER_NOT_FOUND" }, 401);
    }

    const body = await request.json();
    const language = String(body.language || "").trim();

    if (!LANGUAGES.includes(language)) {
      return json({ success: false, error: "INVALID_LANGUAGE" }, 400);
    }

    const result = await env.DB.prepare(
      "UPDATE visitors SET language = ? WHERE user_id = ?"
    ).bind(language, userId).run();

    if (result.meta?.changes === 0) {
      return json({ success: false, error: "USER_NOT_FOUND" }, 404);
    }

    return json({ success: true, language });

  } catch (error) {
    console.error("Preferences POST error:", error);
    return json({ success: false, error: "Could not save preferences" }, 500);
  }
}
