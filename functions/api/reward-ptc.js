import { getVisitor, createVisitorCookie, json } from "./_lib/session.js";

const MAX_ADS = 10;
const CYCLE_SECONDS = 5 * 60 * 60;

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB || !env.SESSION_SECRET) {
      return json({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    let userUuid = await getVisitor(request, env);
    let cookie = null;
    if (!userUuid) {
      cookie = await createVisitorCookie(env);
      const match = cookie.match(/^oxide_visitor=([^;]+)/);
      if (!match) return json({ error: "SESSION_CREATE_FAILED" }, 500);
      userUuid = decodeURIComponent(match[1]).split(".")[0];
    }

    // PTC ads are intentionally unavailable: keep the API response empty
    // and do not create cycles or award points while the UI shows SOON.
    const response = json({
      success: true,
      count: 0,
      ads: [],
      completedAds: 0,
      requiredAds: MAX_ADS,
      remainingAds: MAX_ADS,
      cycleStartedAt: null,
      remainingSeconds: CYCLE_SECONDS,
      pointsPerAd: 0,
      cycleSeconds: CYCLE_SECONDS,
      disabled: true
    });

    if (!cookie) return response;
    const headers = new Headers(response.headers);
    headers.set("Set-Cookie", cookie);
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    console.error("PTC endpoint failed:", error);
    return json({ error: "PTC_DISABLED" }, 503);
  }
}
