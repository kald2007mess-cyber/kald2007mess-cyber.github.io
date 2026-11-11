
import {
  getVisitor,
  createVisitorCookie,
  json
} from "./_lib/session.js";

function response(data, cookie = null, status = 200) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (cookie) headers["Set-Cookie"] = cookie;

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

export async function onRequestGet({ request, env }) {
  try {
    if (
      !env.DB ||
      !env.SESSION_SECRET ||
      !env.OFFERWALL_BEARER_TOKEN ||
      !env.OFFERWALL_PUBLIC_KEY ||
      !env.OFFERWALL_SECRET
    ) {
      return json({ error: "Server configuration missing" }, 500);
    }

    let userId = await getVisitor(request, env);
    let cookie = null;

    if (!userId) {
      cookie = await createVisitorCookie(env);
      const match = cookie.match(/^oxide_visitor=([^;]+)/);

      if (!match) {
        return json({ error: "Session creation failed" }, 500);
      }

      userId = decodeURIComponent(match[1]).split(".")[0];
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
      (user_id, progress, points, created_at)
      VALUES (?, 0, 0, ?)
    `).bind(userId, now).run();

    const islandId = "island_" + userId;
    const expiry = String(now + 3600);

    const message = [
      "offerwall-user-v1",
      env.OFFERWALL_PUBLIC_KEY,
      islandId,
      expiry
    ].join("\n");

    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.OFFERWALL_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signed = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(message)
    );

    const signature = Array.from(new Uint8Array(signed))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    const ip = request.headers.get("CF-Connecting-IP");
    const country = (
      request.headers.get("CF-IPCountry") || ""
    ).toUpperCase();

    if (!ip || !/^[A-Z]{2}$/.test(country)) {
      return response({ error: "User location unavailable" }, cookie, 400);
    }

    const apiUrl = new URL("https://offerwall.me/api.php");

    apiUrl.search = new URLSearchParams({
      api: env.OFFERWALL_PUBLIC_KEY,
      id: islandId,
      ip,
      token: env.OFFERWALL_BEARER_TOKEN,
      country,
      identityExpires: expiry,
      identitySignature: signature
    }).toString();

    const apiResponse = await fetch(apiUrl.toString());
    const result = await apiResponse.json();

    if (!apiResponse.ok || result.status !== 200) {
      return response({ error: "PTC API request failed" }, cookie, 502);
    }

    const ads = (result.data || [])
      .filter(ad =>
        typeof ad.url === "string" &&
        ad.url.startsWith("https://") &&
        Number.isFinite(Number(ad.duration)) &&
        Number(ad.duration) > 0 &&
        Number.isFinite(Number(ad.reward)) &&
        Number(ad.reward) > 0
      )
      .map(ad => ({
        title: ad.title || "PTC Advertisement",
        duration: Number(ad.duration),
        reward: ad.reward,
        type: Number(ad.type),
        url: ad.url
      }));

    return response({
      success: true,
      count: ads.length,
      ads
    }, cookie);

  } catch {
    return json({ error: "Reward PTC service error" }, 500);
  }
}
