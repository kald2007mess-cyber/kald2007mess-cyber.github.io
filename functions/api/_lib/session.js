const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  );
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function getVisitor(request, env) {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("Missing SESSION_SECRET");

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)oxide_visitor=([^;]+)/);

  if (match) {
    try {
      const [id, signature] = decodeURIComponent(match[1]).split(".");
      if (id && signature) {
        const expected = toBase64Url(await hmac(secret, id));
        if (signature === expected) return id;
      }
    } catch {}
  }

  return null;
}

export async function createVisitorCookie(env) {
  const id = crypto.randomUUID();
  const signature = toBase64Url(
    await hmac(env.SESSION_SECRET, id)
  );

  return `oxide_visitor=${encodeURIComponent(id + "." + signature)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}
