
import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    if (
      !env.OFFERWALL_BEARER_TOKEN ||
      !env.OFFERWALL_PUBLIC_KEY ||
      !env.OFFERWALL_SECRET
    ) {
      return json({ error: "Server configuration missing" }, 500);
    }

    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "Open OXIDE HUB first" }, 401);
    }

    const ip = request.headers.get("CF-Connecting-IP");
    const country = (
      request.headers.get("CF-IPCountry") || ""
    ).toUpperCase();

    if (!ip || !/^[A-Z]{2}$/.test(country)) {
      return json({ error: "Could not detect user location" }, 400);
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

    const apiUrl = new URL("https://offerwall.me/api.php");

    apiUrl.search = new URLSearchParams({
      api: env.OFFERWALL_PUBLIC_KEY,
      id: userId,
      ip,
      token: env.OFFERWALL_BEARER_TOKEN,
      country,
      identityExpires: expiry,
      identitySignature: signature
    }).toString();

    const response = await fetch(apiUrl.toString(), {
      headers: { "Accept": "application/json" }
    });

    const result = await response.json();

    if (!response.ok || result.status !== 200) {
      return json({
        error: "Offerwall API request failed",
        status: result.status || response.status
      }, 502);
    }

    const ads = (result.data || []).filter(ad =>
      Number(ad.type) === 0 &&
      [30, 60].includes(Number(ad.duration))
    );

    return json({
      success: true,
      count: ads.length,
      ads: ads.map(ad => ({
        title: ad.title,
        duration: Number(ad.duration),
        reward: ad.reward,
        url: ad.url
      }))
    });

  } catch (error) {
    return json({ error: "PTC service error" }, 500);
  }
}
