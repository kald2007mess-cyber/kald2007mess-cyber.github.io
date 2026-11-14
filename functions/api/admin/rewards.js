import {
  authorizeAdmin,
  adminAuthResponse
} from "../_lib/admin-auth.js";

const OFFERS = {
  1: "55 COINS",
  2: "145 COINS",
  3: "PREMIUM",
  4: "25 BP COINS"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({ success: false, error: "DATABASE_NOT_CONFIGURED" }, 500);
    }

    const body = await request.json();
    const auth = await authorizeAdmin(
      String(body.initData || ""),
      env,
      "users"
    );

    if (!auth.ok) return adminAuthResponse(auth);

    if (body.action === "list") {
      const status = String(body.status || "pending");
      const page = Math.max(1, Math.min(10000, Number.parseInt(body.page, 10) || 1));
      const limit = 50;
      const offset = (page - 1) * limit;

      let count, rows;

      if (status === "all") {
        count = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM reward_orders"
        ).first();

        rows = await env.DB.prepare(`
          SELECT id, user_id, offer_id, points_cost, status, created_at
          FROM reward_orders
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `).bind(limit, offset).all();
      } else if (["pending", "completed", "rejected"].includes(status)) {
        count = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM reward_orders WHERE status = ?"
        ).bind(status).first();

        rows = await env.DB.prepare(`
          SELECT id, user_id, offer_id, points_cost, status, created_at
          FROM reward_orders
          WHERE status = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `).bind(status, limit, offset).all();
      } else {
        return json({ success: false, error: "INVALID_STATUS" }, 400);
      }

      return json({
        success: true,
        status,
        page,
        total: Number(count?.total || 0),
        orders: (rows.results || []).map(order => ({
          ...order,
          id: Number(order.id),
          offer_id: Number(order.offer_id),
          points_cost: Number(order.points_cost || 0),
          created_at: Number(order.created_at || 0),
          offer_name: OFFERS[Number(order.offer_id)] || "Unknown reward"
        }))
      });
    }

    const orderId = Number(body.orderId);
    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return json({ success: false, error: "INVALID_ORDER_ID" }, 400);
    }

    if (body.action === "complete") {
      const result = await env.DB.prepare(`
        UPDATE reward_orders
        SET status = 'completed'
        WHERE id = ? AND status = 'pending'
      `).bind(orderId).run();

      if (Number(result.meta?.changes || 0) !== 1) {
        return json({ success: false, error: "ORDER_NOT_PENDING" }, 409);
      }

      return json({ success: true, status: "completed" });
    }

    if (body.action === "reject") {
      const order = await env.DB.prepare(`
        SELECT user_id, points_cost, status
        FROM reward_orders
        WHERE id = ?
        LIMIT 1
      `).bind(orderId).first();

      if (!order || order.status !== "pending") {
        return json({ success: false, error: "ORDER_NOT_PENDING" }, 409);
      }

      const user = await env.DB.prepare(
        "SELECT user_id FROM visitors WHERE user_id = ?"
      ).bind(order.user_id).first();

      if (!user) {
        return json({ success: false, error: "ORDER_USER_NOT_FOUND" }, 409);
      }

      const cost = Math.max(0, Math.floor(Number(order.points_cost) || 0));

      const results = await env.DB.batch([
        env.DB.prepare(`
          UPDATE visitors
          SET points = COALESCE(points, 0) + ?
          WHERE user_id = ?
            AND EXISTS (
              SELECT 1 FROM reward_orders
              WHERE id = ? AND status = 'pending'
            )
        `).bind(cost, order.user_id, orderId),

        env.DB.prepare(`
          UPDATE reward_orders
          SET status = 'rejected'
          WHERE id = ? AND status = 'pending'
        `).bind(orderId)
      ]);

      if (
        Number(results[0]?.meta?.changes || 0) !== 1 ||
        Number(results[1]?.meta?.changes || 0) !== 1
      ) {
        return json({ success: false, error: "ORDER_UPDATE_CONFLICT" }, 409);
      }

      return json({
        success: true,
        status: "rejected",
        refundedPoints: cost
      });
    }

    return json({ success: false, error: "INVALID_ACTION" }, 400);
  } catch (error) {
    console.error("Admin reward orders error:", error);
    return json({ success: false, error: "REWARD_ORDERS_FAILED" }, 500);
  }
}
