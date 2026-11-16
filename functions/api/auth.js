import {
  getVisitor,
  createVisitorCookie,
  createVisitorCookieForId,
  json
} from "./_lib/session.js";

const ITERATIONS = 210000;
const encoder = new TextEncoder();

function b64(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(value) {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function makeResponse(data, cookie = null, status = 200) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}
function displayId(id) {
  return "OX-" + String(id).replace(/-/g, "").slice(0, 8).toUpperCase();
}
async function ensureAuthSchema(DB) {
  const columns = await DB.prepare("PRAGMA table_info(visitors)").all();
  const names = new Set((columns.results || []).map(column => column.name));
  const additions = [
    ["email", "TEXT"],
    ["password_hash", "TEXT"],
    ["google_sub", "TEXT"],
    ["email_verified", "INTEGER NOT NULL DEFAULT 0"],
    ["auth_created_at", "INTEGER"]
  ];
  for (const [name, type] of additions) {
    if (!names.has(name)) await DB.prepare(`ALTER TABLE visitors ADD COLUMN ${name} ${type}`).run();
  }
  await DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_visitors_email_unique ON visitors(email COLLATE NOCASE) WHERE email IS NOT NULL").run();
  await DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_visitors_google_sub_unique ON visitors(google_sub) WHERE google_sub IS NOT NULL").run();
}
async function newOrCurrentVisitor(request, env) {
  let id = await getVisitor(request, env);
  let cookie = null;
  if (!id) {
    cookie = await createVisitorCookie(env);
    const match = cookie.match(/^oxide_visitor=([^;]+)/);
    if (!match) throw new Error("SESSION_CREATE_FAILED");
    id = decodeURIComponent(match[1]).split(".")[0];
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO visitors (user_id, progress, points, created_at)
    VALUES (?, 0, 0, ?)
  `).bind(id, now).run();
  return { id, cookie: await createVisitorCookieForId(env, id) };
}
async function passwordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, key, 256
  ));
  return "pbkdf2$" + ITERATIONS + "$" + b64(salt) + "$" + b64(bits);
}
async function verifyPassword(password, stored) {
  try {
    const [scheme, rounds, saltText, hashText] = String(stored || "").split("$");
    if (scheme !== "pbkdf2" || Number(rounds) !== ITERATIONS || !saltText || !hashText) return false;
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: unb64(saltText), iterations: ITERATIONS, hash: "SHA-256" }, key, 256
    ));
    const expected = unb64(hashText);
    if (bits.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
    return diff === 0;
  } catch { return false; }
}
async function currentPoints(DB, id) {
  const row = await DB.prepare("SELECT points FROM visitors WHERE user_id = ?").bind(id).first();
  return Number(row?.points || 0);
}
async function successFor(DB, id, cookie, method) {
  return makeResponse({
    success: true,
    authenticated: true,
    method,
    userId: id,
    displayId: displayId(id),
    points: await currentPoints(DB, id)
  }, cookie || await createVisitorCookieForId({ SESSION_SECRET: "" }, id));
}
export async function onRequestGet({ env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    await ensureAuthSchema(env.DB);
    const googleClientId = String(env.GOOGLE_CLIENT_ID || "");
    return json({ success: true, googleClientId });
  } catch (error) {
    console.error("Auth config error", error);
    return json({ success: false, error: "AUTH_SETUP_FAILED" }, 500);
  }
}
export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    await ensureAuthSchema(env.DB);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").toLowerCase();

    if (action === "register" || action === "login") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return json({ success: false, error: "INVALID_EMAIL" }, 400);
      }
      if (password.length < 8 || password.length > 128) {
        return json({ success: false, error: "INVALID_PASSWORD" }, 400);
      }

      if (action === "register") {
        const existing = await env.DB.prepare("SELECT user_id FROM visitors WHERE email = ? COLLATE NOCASE LIMIT 1").bind(email).first();
        if (existing) return json({ success: false, error: "ACCOUNT_EXISTS" }, 409);
        const { id, cookie } = await newOrCurrentVisitor(request, env);
        const current = await env.DB.prepare("SELECT email, google_sub FROM visitors WHERE user_id = ?").bind(id).first();
        if (current?.email) return json({ success: false, error: "ACCOUNT_ALREADY_LINKED" }, 409);
        const hash = await passwordHash(password);
        const now = Math.floor(Date.now() / 1000);
        const updated = await env.DB.prepare(`
          UPDATE visitors
          SET email = ?, password_hash = ?, email_verified = 0, auth_created_at = ?
          WHERE user_id = ? AND email IS NULL
        `).bind(email, hash, now, id).run();
        if (Number(updated.meta?.changes || 0) !== 1) return json({ success: false, error: "ACCOUNT_LINK_FAILED" }, 409);
        return makeResponse({
          success: true, authenticated: true, method: "email",
          userId: id, displayId: displayId(id), points: await currentPoints(env.DB, id)
        }, cookie);
      }

      const user = await env.DB.prepare(`
        SELECT user_id, password_hash FROM visitors
        WHERE email = ? COLLATE NOCASE LIMIT 1
      `).bind(email).first();
      if (!user || !await verifyPassword(password, user.password_hash)) {
        return json({ success: false, error: "INVALID_CREDENTIALS" }, 401);
      }
      const cookie = await createVisitorCookieForId(env, user.user_id);
      return makeResponse({
        success: true, authenticated: true, method: "email",
        userId: user.user_id, displayId: displayId(user.user_id),
        points: await currentPoints(env.DB, user.user_id)
      }, cookie);
    }

    if (action === "google") {
      if (!env.GOOGLE_CLIENT_ID) return json({ success: false, error: "GOOGLE_NOT_CONFIGURED" }, 503);
      const credential = String(body.credential || "");
      if (!credential || credential.length > 10000) return json({ success: false, error: "INVALID_GOOGLE_CREDENTIAL" }, 400);
      const verifyResponse = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
      if (!verifyResponse.ok) return json({ success: false, error: "GOOGLE_TOKEN_INVALID" }, 401);
      const profile = await verifyResponse.json();
      if (profile.aud !== env.GOOGLE_CLIENT_ID || !profile.sub || !profile.email ||
          String(profile.email_verified) !== "true" ||
          !["accounts.google.com", "https://accounts.google.com"].includes(profile.iss)) {
        return json({ success: false, error: "GOOGLE_TOKEN_INVALID" }, 401);
      }

      const email = String(profile.email).trim().toLowerCase();
      const byGoogle = await env.DB.prepare("SELECT user_id, email FROM visitors WHERE google_sub = ? LIMIT 1").bind(profile.sub).first();
      const byEmail = await env.DB.prepare("SELECT user_id, google_sub FROM visitors WHERE email = ? COLLATE NOCASE LIMIT 1").bind(email).first();
      if (byGoogle && byEmail && byGoogle.user_id !== byEmail.user_id) {
        return json({ success: false, error: "GOOGLE_ACCOUNT_CONFLICT" }, 409);
      }
      let id = byGoogle?.user_id || byEmail?.user_id || null;
      let cookie = null;

      if (id) {
        if (byEmail?.google_sub && byEmail.google_sub !== profile.sub) {
          return json({ success: false, error: "EMAIL_LINKED_TO_ANOTHER_GOOGLE" }, 409);
        }
        await env.DB.prepare(`
          UPDATE visitors SET google_sub = ?, email = COALESCE(email, ?), email_verified = 1
          WHERE user_id = ?
        `).bind(profile.sub, email, id).run();
      } else {
        const current = await newOrCurrentVisitor(request, env);
        id = current.id;
        cookie = current.cookie;
        const existing = await env.DB.prepare("SELECT google_sub, email FROM visitors WHERE user_id = ?").bind(id).first();
        if (existing?.google_sub && existing.google_sub !== profile.sub) {
          return json({ success: false, error: "ACCOUNT_ALREADY_LINKED" }, 409);
        }
        const update = await env.DB.prepare(`
          UPDATE visitors SET google_sub = ?, email = ?, email_verified = 1,
            auth_created_at = COALESCE(auth_created_at, ?)
          WHERE user_id = ?
        `).bind(profile.sub, email, Math.floor(Date.now() / 1000), id).run();
        if (Number(update.meta?.changes || 0) !== 1) return json({ success: false, error: "ACCOUNT_LINK_FAILED" }, 409);
      }
      cookie = await createVisitorCookieForId(env, id);
      return makeResponse({
        success: true, authenticated: true, method: "google",
        userId: id, displayId: displayId(id), points: await currentPoints(env.DB, id)
      }, cookie);
    }
    return json({ success: false, error: "UNKNOWN_AUTH_ACTION" }, 400);
  } catch (error) {
    console.error("Authentication request failed", error);
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      return json({ success: false, error: "ACCOUNT_EXISTS" }, 409);
    }
    return json({ success: false, error: "AUTHENTICATION_FAILED" }, 500);
  }
}
