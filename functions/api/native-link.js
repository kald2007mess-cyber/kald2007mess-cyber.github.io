import {
  getVisitor,
  createVisitorCookieForId,
  json
} from "./_lib/session.js";

const encoder = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hashCode(code) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(code));
  return toHex(new Uint8Array(digest));
}

async function ensureTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_native_link_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();

  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_oxide_native_link_expiry
    ON oxide_native_link_tokens(expires_at)
  `).run();
}

function responseWithCookie(data, cookie) {
  const response = json(data);
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

// Open this URL in the browser where the OXIDE HUB account is already active.
// The generated one-time code expires after five minutes.
export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const userId = await getVisitor(request, env);
    if (!userId) {
      return json({
        success: false,
        error: "OPEN_THIS_PAGE_FROM_YOUR_LOGGED_IN_OXIDE_HUB_BROWSER"
      }, 401);
    }

    const user = await env.DB.prepare(
      "SELECT user_id FROM visitors WHERE user_id = ?"
    ).bind(userId).first();

    if (!user) {
      return json({ success: false, error: "USER_NOT_FOUND" }, 404);
    }

    await ensureTable(env.DB);

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "DELETE FROM oxide_native_link_tokens WHERE expires_at <= ?"
    ).bind(now).run();

    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    const code = toHex(random);
    const tokenHash = await hashCode(code);

    await env.DB.prepare(`
      INSERT INTO oxide_native_link_tokens
        (token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(tokenHash, userId, now + 300, now).run();

    return json({
      success: true,
      code,
      expiresInSeconds: 300,
      message: "Enter this one-time code in the OXIDE HUB Android app. Do not share it."
    });
  } catch (error) {
    return json({ success: false, error: "NATIVE_LINK_CODE_FAILED" }, 500);
  }
}

// The Android app exchanges the one-time code for a signed oxide_visitor cookie.
// DELETE ... RETURNING makes the code single-use even if two requests race.
export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const code = String(body.code || "").trim().toLowerCase();

    if (!/^[0-9a-f]{32}$/.test(code)) {
      return json({ success: false, error: "INVALID_OR_EXPIRED_LINK_CODE" }, 400);
    }

    await ensureTable(env.DB);

    const now = Math.floor(Date.now() / 1000);
    const tokenHash = await hashCode(code);
    const linked = await env.DB.prepare(`
      DELETE FROM oxide_native_link_tokens
      WHERE token_hash = ? AND expires_at > ?
      RETURNING user_id
    `).bind(tokenHash, now).first();

    if (!linked?.user_id) {
      return json({ success: false, error: "INVALID_OR_EXPIRED_LINK_CODE" }, 400);
    }

    const user = await env.DB.prepare(
      "SELECT user_id FROM visitors WHERE user_id = ?"
    ).bind(linked.user_id).first();

    if (!user) {
      return json({ success: false, error: "USER_NOT_FOUND" }, 404);
    }

    const cookie = await createVisitorCookieForId(env, user.user_id);
    return responseWithCookie({
      success: true,
      linked: true,
      displayId: "OX-" + String(user.user_id).replace(/-/g, "").slice(0, 8).toUpperCase()
    }, cookie);
  } catch (error) {
    return json({ success: false, error: "NATIVE_LINK_EXCHANGE_FAILED" }, 500);
  }
}
