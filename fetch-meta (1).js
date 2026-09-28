// Ambil judul, deskripsi, dan gambar dari link halaman (og:tags).
// Env di Netlify: SUPABASE_URL, SUPABASE_ANON_KEY  (opsional: ALLOWED_HOSTS="a.com,b.com")
const dns = require("dns").promises;
const net = require("net");

const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const UA = "Mozilla/5.0 (compatible; AnakEmakAddonBot/1.0)";

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith("::ffff:127.");
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
async function assertPublic(urlStr) {
  const u = new URL(urlStr);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Link harus http/https");
  const allowed = (process.env.ALLOWED_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.some(h => u.hostname === h || u.hostname.endsWith("." + h))) throw new Error("Domain tidak diizinkan");
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error("Alamat tidak diizinkan");
  return u;
}
async function get(urlStr, maxBytes, accept, timeoutMs = 6500) {
  let cur = urlStr;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(cur);
    const res = await fetch(cur, { redirect: "manual", headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "id,en;q=0.8" }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { cur = new URL(res.headers.get("location"), cur).href; continue; }
    if (!res.ok) throw new Error("Situs membalas status " + res.status);
    const chunks = []; let size = 0;
    for await (const c of res.body) { size += c.length; if (size > maxBytes) throw new Error("File terlalu besar"); chunks.push(c); }
    return { buf: Buffer.concat(chunks), type: res.headers.get("content-type") || "", url: cur };
  }
  throw new Error("Terlalu banyak redirect");
}
const decode = s => (s || "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
function meta(html, keys) {
  for (const k of keys) {
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (key && key.toLowerCase() === k) {
        const c = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
        if (c) return decode(c);
      }
    }
  }
  return "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  try {
    // hanya admin yang sudah login
    const token = (event.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "Belum login" });
    const who = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", { headers: { Authorization: "Bearer " + token, apikey: process.env.SUPABASE_ANON_KEY } });
    if (!who.ok) return json(401, { error: "Sesi login tidak valid" });

    const { url } = JSON.parse(event.body || "{}");
    if (!url) return json(400, { error: "Link kosong" });
    const start = Date.now();
    const left = () => Math.max(800, 9300 - (Date.now() - start));

    // 1) baca langsung halamannya, 2) cadangan lewat Microlink (jalan paralel supaya tidak kena batas 10 detik)
    const direct = async () => {
      const page = await get(url, 1.5 * 1024 * 1024, "text/html,application/xhtml+xml", 6500);
      const html = page.buf.toString("utf8");
      return {
        title: meta(html, ["og:title", "twitter:title"]) || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]),
        description: meta(html, ["og:description", "twitter:description", "description"]),
        imgUrl: meta(html, ["og:image", "og:image:url", "twitter:image"]),
        base: page.url,
      };
    };
    const micro = async () => {
      const r = await fetch("https://api.microlink.io/?url=" + encodeURIComponent(url), { signal: AbortSignal.timeout(7500) });
      const j = await r.json();
      if (j.status !== "success") throw new Error("Microlink: " + (j.message || j.status));
      const d = j.data || {};
      return { title: d.title || "", description: d.description || "", imgUrl: (d.image && d.image.url) || "", base: url };
    };
    const [d, m] = await Promise.allSettled([direct(), micro()]);
    const A = d.status === "fulfilled" ? d.value : {};
    const B = m.status === "fulfilled" ? m.value : {};
    const title = A.title || B.title || "";
    const description = A.description || B.description || "";
    let imgUrl = A.imgUrl || B.imgUrl || "";
    const base = A.imgUrl ? A.base : B.base || url;
    if (!title && !description && !imgUrl) {
      const why = [d.reason && d.reason.message, m.reason && m.reason.message].filter(Boolean).join(" | ");
      return json(422, { error: "Tidak ada data yang bisa dibaca. " + (why || "Halaman mungkin dibangun dengan JavaScript.") });
    }
    let image = null;
    if (imgUrl) {
      try {
        imgUrl = new URL(imgUrl, base).href;
        const img = await get(imgUrl, 3 * 1024 * 1024, "image/*", Math.min(4000, left()));
        const mime = img.type.split(";")[0].trim();
        if (mime.startsWith("image/")) image = { mime, base64: img.buf.toString("base64") };
      } catch (e) { /* gambar gagal diambil, lanjut tanpa gambar */ }
    }
    return json(200, { title, description, image });
  } catch (e) {
    return json(500, { error: e.message || "Gagal mengambil data" });
  }
};
