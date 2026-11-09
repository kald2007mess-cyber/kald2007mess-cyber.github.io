
function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;

  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89;
  let c0 = 0x98badcfe, d0 = 0x10325476;

  const shifts = [
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
  ];

  const k = Array.from({length:64}, (_,i) =>
    Math.floor(Math.abs(Math.sin(i+1)) * 4294967296) >>> 0
  );

  for (let offset=0; offset<paddedLength; offset+=64) {
    const words = Array.from({length:16}, (_,i) =>
      view.getUint32(offset+i*4, true)
    );

    let a=a0, b=b0, c=c0, d=d0;

    for (let i=0; i<64; i++) {
      let f, g;
      if (i<16) { f=(b&c)|(~b&d); g=i; }
      else if (i<32) { f=(d&b)|(~d&c); g=(5*i+1)%16; }
      else if (i<48) { f=b^c^d; g=(3*i+5)%16; }
      else { f=c^(b|~d); g=(7*i)%16; }

      const x=(a+f+k[i]+words[g])|0;
      const rotated=(x<<shifts[i])|(x>>>(32-shifts[i]));
      a=d; d=c; c=b; b=(b+rotated)|0;
    }

    a0=(a0+a)|0; b0=(b0+b)|0;
    c0=(c0+c)|0; d0=(d0+d)|0;
  }

  return [a0,b0,c0,d0].map(n =>
    [0,8,16,24].map(s =>
      ((n>>>s)&255).toString(16).padStart(2,"0")
    ).join("")
  ).join("");
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.OFFERWALL_SECRET) {
      return new Response("Server configuration missing", {status:500});
    }

    const type = request.headers.get("content-type") || "";
    let p;

    if (type.includes("application/json")) {
      p = await request.json();
    } else {
      p = Object.fromEntries(new URLSearchParams(await request.text()));
    }

    const subId = String(p.subId || "");
    const transId = String(p.transId || "");
    const reward = String(p.reward || "");
    const status = Number(p.status);
    const signature = String(p.signature || "").toLowerCase();

    if (!subId || !transId || !reward || ![1,2].includes(status)) {
      return new Response("Invalid parameters", {status:400});
    }

    const expected = md5(
      subId + transId + reward + env.OFFERWALL_SECRET
    );

    if (signature !== expected) {
      return new Response("Invalid signature", {status:403});
    }

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS offerwall_events (
        trans_id TEXT PRIMARY KEY,
        sub_id TEXT NOT NULL,
        reward TEXT NOT NULL,
        offer_type TEXT,
        status INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    await env.DB.prepare(`
      INSERT OR IGNORE INTO offerwall_events
      (trans_id, sub_id, reward, offer_type, status)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      transId, subId, reward,
      String(p.offer_type || ""), status
    ).run();

    if (status === 2) {
      await env.DB.prepare(`
        UPDATE offerwall_events SET status = 2
        WHERE trans_id = ?
      `).bind(transId).run();
    }

    return new Response("ok", {status:200});

  } catch (error) {
    console.error("Postback error:", error);
    return new Response("Server error", {status:500});
  }
}
