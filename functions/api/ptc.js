
import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "No visitor session" }, 401);
    }

    if (
      !env.OFFERWALL_BEARER_TOKEN ||
      !env.OFFERWALL_PUBLIC_KEY ||
      !env.OFFERWALL_SECRET
    ) {
      return json({ error: "Missing server configuration" }, 500);
    }

    const ip = request.headers.get("CF-Connecting-IP");
    const country = (
      request.headers.get("CF-IPCountry") || ""
    ).toUpperCase();

    if (!ip || !/^[A-Z]{2}$/.test(country)) {
      return json({ error: "User location unavailable" }, 400);
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

    const response = await fetch(apiUrl.toString());
    const result = await response.json();

    if (!response.ok || result.status !== 200) {
      return json({ error: "PTC API request failed" }, 502);
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

    return json({
      success: true,
      count: ads.length,
      ads
    });

  } catch {
    return json({ error: "PTC service error" }, 500);
  }
}
