import { getVisitor, json } from "./_lib/session.js";

function logPTC(event, details = {}) {
  // Never log visitor IDs, IP addresses, ad URLs, or API credentials.
  console.log(JSON.stringify({
    service: "ptc",
    event,
    timestamp: new Date().toISOString(),
    ...details
  }));
}

export async function onRequestGet({ request, env }) {
  const startedAt = Date.now();
  let country = "";

  try {
    const userId = await getVisitor(request, env);

    if (!userId) {
      logPTC("no_session", { durationMs: Date.now() - startedAt });
      return json({ error: "No visitor session" }, 401);
    }

    if (
      !env.OFFERWALL_BEARER_TOKEN ||
      !env.OFFERWALL_PUBLIC_KEY ||
      !env.OFFERWALL_SECRET
    ) {
      logPTC("configuration_missing", { durationMs: Date.now() - startedAt });
      return json({ error: "Missing server configuration" }, 500);
    }

    const ip = request.headers.get("CF-Connecting-IP");
    country = (
      request.headers.get("CF-IPCountry") || ""
    ).toUpperCase();

    if (!ip || !/^[A-Z]{2}$/.test(country)) {
      logPTC("location_unavailable", {
        country: /^[A-Z]{2}$/.test(country) ? country : "unknown",
        durationMs: Date.now() - startedAt
      });
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

    if (!response.ok) {
      logPTC("provider_http_error", {
        country,
        providerStatus: response.status,
        durationMs: Date.now() - startedAt
      });
      return json({ error: "PTC API request failed" }, 502);
    }

    const result = await response.json();

    if (result.status !== 200) {
      logPTC("provider_rejected_request", {
        country,
        providerStatus: Number(result.status) || "unknown",
        durationMs: Date.now() - startedAt
      });
      return json({ error: "PTC API request failed" }, 502);
    }

    const rawAds = Array.isArray(result.data) ? result.data : [];
    const ads = rawAds
      .filter(ad =>
        [0, 1].includes(Number(ad.type)) &&
        Number.isFinite(Number(ad.duration)) &&
        Number(ad.duration) > 0 &&
        typeof ad.url === "string" &&
        ad.url.startsWith("https://")
      )
      .map(ad => ({
        type: Number(ad.type),
        title: ad.title || "PTC Ad",
        duration: Number(ad.duration),
        reward: ad.reward,
        url: ad.url
      }));

    logPTC(ads.length > 0 ? "ads_available" : "no_ads_available", {
      country,
      rawCount: rawAds.length,
      validCount: ads.length,
      durationMs: Date.now() - startedAt
    });

    return json({
      success: true,
      count: ads.length,
      ads
    });

  } catch (error) {
    logPTC("internal_error", {
      country: /^[A-Z]{2}$/.test(country) ? country : "unknown",
      errorType: error?.name || "Error",
      durationMs: Date.now() - startedAt
    });
    return json({ error: "PTC service error" }, 500);
  }
}
