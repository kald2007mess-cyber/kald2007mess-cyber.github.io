
import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return new Response(JSON.stringify({
        success: false,
        error: "SERVER_CONFIGURATION_MISSING"
      }), { status: 500 });
    }

    const body = await request.json();
    const initData = String(body.initData || "");

    if (!initData || initData.length > 10000) {
      return new Response(JSON.stringify({
        success: false,
        error: "INVALID_DATA"
      }), { status: 400 });
    }

    const auth = await authorizeAdmin(initData, env);

    if (!auth.ok) {
      return adminAuthResponse(auth);
    }

    return new Response(JSON.stringify({
      success: true,
      admin: true,
      owner: Boolean(auth.owner),
      permissions: auth.permissions || []
    }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });

  } catch {
    return new Response(JSON.stringify({
      success: false,
      error: "AUTH_FAILED"
    }), { status: 500 });
  }
}
