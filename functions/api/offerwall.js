
export async function onRequestGet({ request, env }) {
  try {
    if (
      !env.OFFERWALL_SECRET ||
      !env.OFFERWALL_PUBLIC_KEY ||
      !env.SESSION_SECRET
    ) {
      return new Response("Server configuration missing", {
        status: 500
      });
    }

    const encoder = new TextEncoder();
    const cookieName = "oxide_visitor";
    const cookies = request.headers.get("Cookie") || "";
    const match = cookies.match(/(?:^|;\s*)oxide_visitor=([^;]+)/);

    const sessionKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    let userId = null;
    let newCookie = null;

    if (match) {
      const parts = match[1].split(".");

      if (parts.length === 2) {
        try {
          const encodedSignature = parts[1]
            .replace(/-/g, "+")
            .replace(/_/g, "/");

          const signature = Uint8Array.from(
            atob(encodedSignature + "=".repeat((4 - encodedSignature.length % 4) % 4)),
            c => c.charCodeAt(0)
          );

          const valid = await crypto.subtle.verify(
            "HMAC",
            sessionKey,
            signature,
            encoder.encode(parts[0])
          );

          if (valid) userId = parts[0];
        } catch {
          userId = null;
        }
      }
    }

    if (!userId) {
      userId = crypto.randomUUID();

      const signedCookie = await crypto.subtle.sign(
        "HMAC",
        sessionKey,
        encoder.encode(userId)
      );

      const cookieSignature = btoa(
        String.fromCharCode(...new Uint8Array(signedCookie))
      )
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      newCookie =
        `${cookieName}=${userId}.${cookieSignature}; ` +
        "HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000";
    }

    const expiry = Math.floor(Date.now() / 1000) + 3600;

    const message = [
      "offerwall-user-v1",
      env.OFFERWALL_PUBLIC_KEY,
      userId,
      String(expiry)
    ].join("\n");

    const offerwallKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.OFFERWALL_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signed = await crypto.subtle.sign(
      "HMAC",
      offerwallKey,
      encoder.encode(message)
    );

    const signature = Array.from(new Uint8Array(signed))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    const url = new URL(
      `https://offerwall.me/offerwall/${env.OFFERWALL_PUBLIC_KEY}/${userId}`
    );

    url.searchParams.set("identityExpires", String(expiry));
    url.searchParams.set("identitySignature", signature);

    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });

    if (newCookie) {
      headers.set("Set-Cookie", newCookie);
    }

    return new Response(
      JSON.stringify({ url: url.toString() }),
      { status: 200, headers }
    );

  } catch (error) {
    return new Response("Offerwall error", { status: 500 });
  }
}
