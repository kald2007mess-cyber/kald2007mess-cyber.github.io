
function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const data = [...bytes, 0x80];

  while (data.length % 64 !== 56) data.push(0);

  const low = bitLength >>> 0;
  const high = Math.floor(bitLength / 4294967296);

  for (let i = 0; i < 4; i++) {
    data.push((low >>> (i * 8)) & 255);
  }

  for (let i = 0; i < 4; i++) {
    data.push((high >>> (i * 8)) & 255);
  }

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
      const rotated =
        (sum << shifts[i]) | (sum >>> (32 - shifts[i]));

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
        .map(s =>
          ((n >>> s) & 255).toString(16).padStart(2, "0")
        )
        .join("")
    )
    .join("");
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.OFFERWALL_SECRET) {
      return new Response("Configuration missing", {
        status: 500
      });
    }

    const contentType =
      request.headers.get("content-type") || "";

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
    const offerType = String(
      params.offer_type || ""
    ).toLowerCase();

    if (
      !subId ||
      !transId ||
      !reward ||
      !signature ||
      ![1, 2].includes(status) ||
      !Number.isFinite(Number(reward))
    ) {
      return new Response("Invalid data", {
        status: 400
      });
    }

    const expected = md5(
      subId + transId + reward + env.OFFERWALL_SECRET
    );

    if (signature.toLowerCase() !== expected) {
      return new Response("Invalid signature", {
        status: 403
      });
    }

    const isTest =
      String(params.debug || "") === "1" ||
      transId.toUpperCase().startsWith("TEST-");

    if (isTest) {
      return new Response("ok", { status: 200 });
    }

    await env.DB.prepare(`
      INSERT OR IGNORE INTO visitors (user_id, progress)
      VALUES (?, 0)
    `).bind(subId).run();

    if (status === 1) {
      const result = await env.DB.prepare(`
        INSERT OR IGNORE INTO offerwall_events
        (trans_id, user_id, reward, status, offer_type)
        VALUES (?, ?, ?, 1, ?)
      `).bind(
        transId,
        subId,
        Number(reward),
        offerType
      ).run();

      if (
        result.meta.changes > 0 &&
        offerType === "ptc"
      ) {
        await env.DB.prepare(`
          UPDATE visitors
          SET progress = MIN(3, progress + 1)
          WHERE user_id = ?
        `).bind(subId).run();
      }

    } else {
      const existing = await env.DB.prepare(`
        SELECT status, offer_type
        FROM offerwall_events
        WHERE trans_id = ? AND user_id = ?
      `).bind(transId, subId).first();

      if (existing && existing.status === 1) {
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
          `).bind(subId).run();
        }

      } else if (!existing) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO offerwall_events
          (trans_id, user_id, reward, status, offer_type)
          VALUES (?, ?, ?, 2, ?)
        `).bind(
          transId,
          subId,
          Number(reward),
          offerType
        ).run();
      }
    }

    return new Response("ok", { status: 200 });

  } catch (error) {
    return new Response("Server error", {
      status: 500
    });
  }
}
