
import {
  getVisitor,
  json,
  createVisitorCookie
} from "./_lib/session.js";

const encoder = new TextEncoder();

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message)
  );

  return Array.from(new Uint8Array(signature))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestGet({ request, env }) {
  try {
    if (
      !env.OFFERWALL_PUBLIC_KEY ||
      !env.OFFERWALL_SECRET ||
      !env.SESSION_SECRET
    ) {
      return json({ error: "Server configuration missing" }, 500);
    }

    let userId = await getVisitor(request, env);
    let cookie = null;

    if (!userId) {
      cookie = await createVisitorCookie(env);
      userId = cookie.split("=")[1].split(".")[0];
    }

    const expiry = String(
      Math.floor(Date.now() / 1000) + 3600
    );

    const message = [
      "offerwall-user-v1",
      env.OFFERWALL_PUBLIC_KEY,
      userId,
      expiry
    ].join("\n");

    const signature = await sign(
      env.OFFERWALL_SECRET,
      message
    );

    const url =
      "https://offerwall.me/offerwall/" +
      encodeURIComponent(env.OFFERWALL_PUBLIC_KEY) +
      "/" +
      encodeURIComponent(userId) +
      "?identityExpires=" +
      encodeURIComponent(expiry) +
      "&identitySignature=" +
      encodeURIComponent(signature);

    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    };

    if (cookie) {
      headers["Set-Cookie"] = cookie;
    }

    return new Response(
      JSON.stringify({ url }),
      { status: 200, headers }
    );

  } catch (error) {
    return json({
      error: "Could not create offerwall link"
    }, 500);
  }
}
