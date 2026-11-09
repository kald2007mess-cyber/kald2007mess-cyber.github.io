export async function onRequestGet({ request, env }) {
  try {
    if (!env.OFFERWALL_SECRET || !env.OFFERWALL_PUBLIC_KEY) {
      return new Response("Server configuration missing", {
        status: 500
      });
    }

    const cookieName = "oxide_visitor";
    const cookies = request.headers.get("Cookie") || "";
    const match = cookies.match(
      new RegExp("(?:^|;\\s*)" + cookieName + "=([^;]+)")
    );

    let userId;

    if (match) {
      const token = match[1];
      const parts = token.split(".");
      if (parts.length === 2) {
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(env.SESSION_SECRET),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"]
        );

        const valid = await crypto.subtle.verify(
          "HMAC",
          key,
          Uint8Array.from(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
            c => c.charCodeAt(0)
          ),
          new TextEncoder().encode(parts[0])
        );

        if (valid) userId = parts[0];
      }
    }

    let cookie = "";

    if (!userId) {
      userId = crypto.randomUUID();

      const sessionKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.SESSION_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const signature = await crypto.subtle.sign(
        "HMAC",
        sessionKey,
        new TextEncoder().encode(userId)
      );

      const encoded = btoa(
        String.fromCharCode(...new Uint8Array(signature))
      ).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      cookie = `${cookieName}=${userId}.${encoded}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
    }

    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const message = [
      "offerwall-user-v1",
      env.OFFERWALL_PUBLIC_KEY,
      userId,
      String(expiry)
    ].join("\n");

    const signingKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.OFFERWALL_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      signingKey,
      new TextEncoder().encode(message)
    );

    const hex = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    const url = new URL(
      `https://offerwall.me/offerwall/${env.OFFERWALL_PUBLIC_KEY}/${userId}`
    );

    url.searchParams.set("identityExpires", String(expiry));
    url.searchParams.set("identitySignature", hex);

    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    };

    if (cookie) headers["Set-Cookie"] = cookie;

    return new Response(JSON.stringify({
      url: url.toString()
    }), { headers });

  } catch (error) {
    return new Response("Offerwall error", { status: 500 });
  }
  }
