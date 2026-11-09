
import { getVisitor, json } from "./_lib/session.js";

export async function onRequestGet({ request, env }) {
  try {
    const userId = await getVisitor(request, env);

    if (!userId) {
      return json({ error: "No visitor session" }, 401);
    }

    if (!env.OFFERWALL_BEARER_TOKEN) {
      return json({ error: "Missing API token" }, 500);
    }

    const ip = request.headers.get("CF-Connecting-IP");
    const country = (
      request.headers.get("CF-IPCountry") || ""
    ).toUpperCase();

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
      ip: ip || "",
      token: env.OFFERWALL_BEARER_TOKEN,
      country,
      identityExpires: expiry,
      identitySignature: signature
    }).toString();

    const response = await fetch(apiUrl.toString(), {
      headers: { Accept: "application/json" }
    });

    const result = await response.json();

    if (!response.ok) {
      return json({
        error: "API request failed",
        status: response.status
      }, 502);
    }

    const ads = result.data || [];

    return json({
      success: true,
      apiStatus: result.status,
      total: ads.length,
      ads: ads.map(ad => ({
        title: ad.title,
        type: ad.type,
        duration: ad.duration,
        reward: ad.reward
      }))
    });

  } catch (error) {
    return json({
      error: "PTC test failed",
      message: String(error.message || error)
    }, 500);
  }
}
