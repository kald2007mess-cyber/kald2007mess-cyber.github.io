import {
  getVisitor,
  json,
  createVisitorCookie
} from "./_lib/session.js";

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  );
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
      const newCookie = await createVisitorCookie(env);
      userId = newCookie.split("=")[1].split(".")[0];
      cookie = newCookie;
    }

    const expiry = Math.floor(Date.now() / 1000) + 3600;

    const message = [
      "offerwall-user-v1",
      env.OFFERWALL_PUBLIC_KEY,
      userId,
      String(expiry)
    ].join("\n");

    const signature = toBase64Url(
      await sign(env.OFFERWALL_SECRET, message)
    );

    const url = new URL("https://offerwall.me/offerwall");
    url.searchParams.set("apiKey", env.OFFERWALL_PUBLIC_KEY);
    url.searchParams.set("userId", userId);
    url.searchParams.set("identityExpires", String(expiry));
    url.searchParams.set("identitySignature", signature);

    const headers = {
      "Cache-Control": "no-store"
    };

    if (cookie) {
      headers["Set-Cookie"] = cookie;
    }

    return new Response(
      JSON.stringify({ url: url.toString() }),
      {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "application/json; charset=utf-8"
        }
      }
    );

  } catch (error) {
    return json({ error: "Could not create offerwall link" }, 500);
  }
}
