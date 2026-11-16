import { json } from "../_lib/session.js";
export async function onRequestGet({ env }) {
  return json({ success: true, googleClientId: String(env.GOOGLE_CLIENT_ID || "") });
}
