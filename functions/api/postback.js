
function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const data = [...bytes, 0x80];

  while (data.length % 64 !== 56) data.push(0);

  const low = bitLength >>> 0;
  const high = Math.floor(bitLength / 4294967296);

  for (let i = 0; i < 4; i++) data.push((low >>> (i * 8)) & 255);
  for (let i = 0; i < 4; i++) data.push((high >>> (i * 8)) & 255);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const shifts = [
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
  ];

  const K = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0
  );

  for (let offset = 0; offset < data.length; offset += 64) {
    const M = [];

    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      M[i] = (
        data[p] |
        (data[p + 1] << 8) |
        (data[p + 2] << 16) |
        (data[p + 3] << 24)
      ) >>> 0;
    }

    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F, g;

      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      const sum = (A + F + K[i] + M[g]) >>> 0;
      const rotated = (sum << shifts[i]) | (sum >>> (32 - shifts[i]));
      const next = (B + rotated) >>> 0;

      A = D;
      D = C;
      C = B;
      B = next;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return [a0, b0, c0, d0]
    .map(n =>
      [0, 8, 16, 24]
        .map(s => ((n >>> s) & 255).toString(16).padStart(2, "0"))
        .join("")
    )
    .join("");
}

async function sendTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) return;

  try {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_ADMIN_ID,
          text: message
        })
      }
    );
  } catch {}
}

async function handleIslandPostback({
  env,
  subId,
  transId,
  reward,
  status,
  offerType,
  now
}) {
  const userId = subId.slice("island_".length);

  if (!userId || offerType !== "ptc") {
    return new Response("Invalid island identity", { status: 400 });
  }

  const visitor = await env.DB.prepare(`
    SELECT user_id FROM visitors WHERE user_id = ?
  `).bind(userId).first();

  if (!visitor) {
    return new Response("Unknown island user", { status: 400 });
  }

  if (status === 1) {
    const inserted = await env.DB.prepare(`
      INSERT OR IGNORE INTO reward_ad_events
      (trans_id, user_id, credited_points, created_at, status)
      VALUES (?, ?, 0, ?, 1)
    `).bind(transId, userId, now).run();

    if (inserted.meta?.changes !== 1) {
      return new Response("ok", { status: 200 });
    }

    await env.DB.prepare(`
      INSERT OR IGNORE INTO reward_ad_cycles
      (user_id, completed_ads, cycle_started_at)
      VALUES (?, 0, ?)
    `).bind(userId, now).run();

    let cycle = await env.DB.prepare(`
      SELECT completed_ads, cycle_started_at
      FROM reward_ad_cycles
      WHERE user_id = ?
    `).bind(userId).first();

    let startedAt = Number(cycle?.cycle_started_at || now);

    if (now - startedAt >= 18000) {
      await env.DB.prepare(`
        UPDATE reward_ad_cycles
        SET completed_ads = 0, cycle_started_at = ?
        WHERE user_id = ?
      `).bind(now, userId).run();

      startedAt = now;
    }

    const updated = await env.DB.prepare(`
      UPDATE reward_ad_cycles
      SET completed_ads = completed_ads + 1
      WHERE user_id = ?
        AND cycle_started_at = ?
        AND completed_ads < 10
    `).bind(userId, startedAt).run();

    if (updated.meta?.changes === 1) {
      await env.DB.prepare(`
        UPDATE visitors
        SET points = points + 5
        WHERE user_id = ?
      `).bind(userId).run();

      await env.DB.prepare(`
        UPDATE reward_ad_events
        SET credited_points = 5, cycle_started_at = ?
        WHERE trans_id = ? AND user_id = ?
      `).bind(startedAt, transId, userId).run();

      await sendTelegram(
        env,
        "🏝️ OXIDE ISLAND\n\n" +
        "🎬 Reward ad completed\n" +
        "👤 User: " + userId + "\n" +
        "⭐ Points: +5\n" +
        "🧾 Transaction: " + transId
      );
    }

  } else {
    const existing = await env.DB.prepare(`
      SELECT status, credited_points, cycle_started_at
      FROM reward_ad_events
      WHERE trans_id = ?
    `).bind(transId).first();

    if (existing && Number(existing.status) === 1) {
      await env.DB.prepare(`
        UPDATE reward_ad_events
        SET status = 2
        WHERE trans_id = ? AND status = 1
      `).bind(transId).run();

      const points = Number(existing.credited_points || 0);

      if (points > 0) {
        await env.DB.prepare(`
          UPDATE visitors
          SET points = MAX(0, points - ?)
          WHERE user_id = ?
        `).bind(points, userId).run();

        if (existing.cycle_started_at !== null) {
          await env.DB.prepare(`
            UPDATE reward_ad_cycles
            SET completed_ads = MAX(0, completed_ads - 1)
            WHERE user_id = ?
              AND cycle_started_at = ?
          `).bind(userId, Number(existing.cycle_started_at)).run();
        }
      }

    } else if (!existing) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO reward_ad_events
        (trans_id, user_id, credited_points, created_at, status)
        VALUES (?, ?, 0, ?, 2)
      `).bind(transId, userId, now).run();
    }
  }

  return new Response("ok", { status: 200 });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.OFFERWALL_SECRET) {
      return new Response("Configuration missing", { status: 500 });
    }

    const contentType = request.headers.get("content-type") || "";
    let params = {};

    if (contentType.includes("application/json")) {
      params = await request.json();
    } else {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        params[key] = String(value);
      }
    }

    const subId = String(params.subId || "");
    const transId = String(params.transId || "");
    const reward = String(params.reward || "");
    const status = Number(params.status);
    const signature = String(params.signature || "");
    const offerType = String(params.offer_type || "").toLowerCase();

    if (
      !subId ||
      !transId ||
      !reward ||
      !signature ||
      ![1, 2].includes(status) ||
      !Number.isFinite(Number(reward))
    ) {
      return new Response("Invalid data", { status: 400 });
    }

    const expected = md5(
      subId + transId + reward + env.OFFERWALL_SECRET
    );

    if (signature.toLowerCase() !== expected) {
      return new Response("Invalid signature", { status: 403 });
    }

    const isTest =
      String(params.debug || "") === "1" ||
      transId.toUpperCase().startsWith("TEST-");

    if (isTest) {
      return new Response("ok", { status: 200 });
    }

    const now = Math.floor(Date.now() / 1000);

    if (subId.startsWith("island_")) {
      return await handleIslandPostback({
        env,
        subId,
        transId,
        reward,
        status,
        offerType,
        now
      });
    }

    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors
      (user_id, progress, cycle_started_at, created_at)
      VALUES (?, 0, ?, ?)
    `).bind(subId, now, now).run();

    await env.DB.prepare(`
      UPDATE visitors
      SET created_at = ?
      WHERE user_id = ?
      AND created_at IS NULL
    `).bind(now, subId).run();

    if (status === 1) {
      const result = await env.DB.prepare(`
        INSERT OR IGNORE INTO offerwall_events
        (trans_id, user_id, reward, status, offer_type, created_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).bind(
        transId,
        subId,
        Number(reward),
        offerType,
        now
      ).run();

      if (result.meta?.changes > 0 && offerType === "ptc") {
        await env.DB.prepare(`
          UPDATE visitors
          SET
            progress = CASE
              WHEN cycle_started_at IS NULL
                OR (? - cycle_started_at) >= 1800
              THEN 1
              ELSE MIN(3, progress + 1)
            END,
            cycle_started_at = CASE
              WHEN cycle_started_at IS NULL
                OR (? - cycle_started_at) >= 1800
              THEN ?
              ELSE cycle_started_at
            END
          WHERE user_id = ?
        `).bind(now, now, now, subId).run();

        const visitor = await env.DB.prepare(`
          SELECT progress FROM visitors WHERE user_id = ?
        `).bind(subId).first();

        const stage = Math.min(
          3,
          Math.max(1, Number(visitor?.progress || 1))
        );

        const message =
          `🎉 إعلان مكتمل في OXIDE HUB!\n\n` +
          `📺 المرحلة: ${stage}/3\n` +
          `👤 الزائر: ${subId}\n` +
          `💰 المكافأة: ${reward}\n` +
          `🧾 رقم العملية: ${transId}\n\n` +
          (stage === 3
            ? "🏆 أكمل الزائر المراحل الثلاث!"
            : `⏳ المتبقي: ${3 - stage} مرحلة`);

        await sendTelegram(env, message);
      }

    } else {
      const existing = await env.DB.prepare(`
        SELECT status, offer_type, created_at
        FROM offerwall_events
        WHERE trans_id = ? AND user_id = ?
      `).bind(transId, subId).first();

      if (existing && Number(existing.status) === 1) {
        await env.DB.prepare(`
          UPDATE offerwall_events
          SET status = 2
          WHERE trans_id = ?
            AND user_id = ?
            AND status = 1
        `).bind(transId, subId).run();

        if (existing.offer_type === "ptc") {
          await env.DB.prepare(`
            UPDATE visitors
            SET progress = MAX(0, progress - 1)
            WHERE user_id = ?
              AND cycle_started_at <= ?
              AND ? - cycle_started_at < 1800
          `).bind(
            subId,
            Number(existing.created_at),
            now
          ).run();
        }

      } else if (!existing) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO offerwall_events
          (trans_id, user_id, reward, status, offer_type, created_at)
          VALUES (?, ?, ?, 2, ?, ?)
        `).bind(
          transId,
          subId,
          Number(reward),
          offerType,
          now
        ).run();
      }
    }

    return new Response("ok", { status: 200 });

  } catch (error) {
    return new Response("Server error", { status: 500 });
  }
}
