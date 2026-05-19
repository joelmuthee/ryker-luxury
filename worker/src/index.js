// Ryker Luxury API Worker
// Public:   GET  /api/bags          → { bags, settings }
//           GET  /img/:name         → image binary
// Admin:    POST /api/bulk          → replace { bags, settings }
//           POST /api/image         → upload image → { path }
//           POST /api/buyer         → forward buyer to GHL

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

const isAuthed = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.ADMIN_TOKEN && auth.slice(7).trim() === env.ADMIN_TOKEN;
};

const b64ToBytes = b64 => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

// Decode HTML entities IG slathers across og:description and the embed Caption
// div. Named entities + decimal (&#064;) + hex (&#x40;). Per CATALOG-STANDARDS
// "Instagram quick-add — Caption pre-processing" rules. Mostly cosmetic for
// ryker (new-stock model, no @<price> parser) but keeps descriptions clean.
const decodeEntities = (s) => (s || "")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Public: catalog data
    if (request.method === "GET" && path === "/api/bags") {
      const raw = await env.BAGS.get("data");
      const data = raw ? JSON.parse(raw) : { bags: [], settings: {} };
      return json(data, 200, { "Cache-Control": "public, max-age=10" });
    }

    // Public: serve images
    const imgMatch = path.match(/^\/img\/(.+)$/);
    if (request.method === "GET" && imgMatch) {
      const name = decodeURIComponent(imgMatch[1]);
      const b64 = await env.BAGS.get(`img:${name}`);
      if (!b64) return new Response("Not found", { status: 404, headers: CORS });
      const mime = (await env.BAGS.get(`mime:${name}`)) || "image/jpeg";
      return new Response(b64ToBytes(b64), {
        status: 200,
        headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable", ...CORS },
      });
    }

    if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });

    // Buyer → GHL proxy
    if (request.method === "POST" && path === "/api/buyer") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const { name, phone, notes, bag_name, bag_price, captchaV3 } = body;
      if (!name && !phone) return json({ error: "name or phone required" }, 400);
      const fd = new FormData();
      fd.append("formData", JSON.stringify({
        first_name: name || "",
        phone: phone || "",
        multi_line_280v: [notes, bag_name && `Item: ${bag_name} (Ksh ${bag_price})`].filter(Boolean).join(" | "),
      }));
      fd.append("locationId", "aTZHRdo8ius6WBzGQ5GD");
      fd.append("formId", "BWrG36c6p56ATDThPdN7");
      fd.append("eventData", JSON.stringify({ source: "rykerluxury-admin", type: "page-visit", domain: "rykerluxury.github.io" }));
      if (captchaV3) fd.append("captchaV3", captchaV3);
      try {
        const r = await fetch("https://backend.leadconnectorhq.com/forms/submit", {
          method: "POST",
          headers: {
            "Origin": "https://link.essenceautomations.com",
            "Referer": "https://link.essenceautomations.com/widget/form/BWrG36c6p56ATDThPdN7",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          body: fd,
        });
        const text = await r.text().catch(() => "");
        return json({ ok: r.ok, status: r.status, body: text.slice(0, 200) });
      } catch (err) { return json({ ok: false, error: err.message }, 502); }
    }

    // Admin: replace all data
    if (request.method === "POST" && path === "/api/bulk") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!Array.isArray(body.bags)) return json({ error: "bags must be array" }, 400);
      const payload = {
        bags: body.bags,
        settings: body.settings || {},
      };
      if (Array.isArray(body.sets)) payload.sets = body.sets;
      await env.BAGS.put("data", JSON.stringify(payload));
      return json({ ok: true, count: body.bags.length, sets: payload.sets?.length || 0 });
    }

    // Admin: upload image
    if (request.method === "POST" && path === "/api/image") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const { base64, ext } = body;
      if (!base64) return json({ error: "base64 required" }, 400);
      const safeExt = (ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const name = `item_${Date.now()}.${safeExt}`;
      const mime = safeExt === "png" ? "image/png" : safeExt === "webp" ? "image/webp" : "image/jpeg";
      await env.BAGS.put(`img:${name}`, base64);
      await env.BAGS.put(`mime:${name}`, mime);
      return json({ path: `/img/${name}`, name });
    }

    // ---- IG quick-add: server-side fetch of an Instagram public post ----
    // Lets the admin paste an IG URL and auto-fill the form (name, image, caption).
    // We can't fetch IG from a browser due to CORS; the Worker is server-side so it can.
    if (request.method === "GET" && path === "/api/ig-fetch") {
      const igUrl = url.searchParams.get("url");
      if (!igUrl) return json({ error: "url required" }, 400);

      // Accept all IG public URL shapes that carry a shortcode:
      //   /p/<code>/         photo posts
      //   /reel/<code>/      single reel
      //   /reels/<code>/     plural — some share sheets emit this
      //   /tv/<code>/        IGTV
      //   /share/reel/<code>/, /share/p/<code>/   share-sheet shortlinks
      const m = igUrl.match(/instagram\.com\/(?:share\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
      if (!m) return json({ error: "not an Instagram post URL" }, 400);
      const code = m[1];

      const headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      };

      try {
        let caption = "", imageUrl = "", imageUrls = [];

        // Try the embed page first (designed to be embeddable, more bot-friendly)
        const embedRes = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, { headers });
        if (embedRes.ok) {
          const html = await embedRes.text();
          const img = html.match(/<img[^>]+class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/i)
            || html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
          if (img) imageUrl = img[1].replace(/&amp;/g, "&");
          const capDiv = html.match(/<div[^>]+class=["'][^"']*Caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          if (capDiv) caption = decodeEntities(capDiv[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
          if (!caption) {
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (desc) caption = decodeEntities(desc[1]);
          }
        }

        // Try the GraphQL-ish JSON endpoint for the full post data (gives all carousel images)
        // This URL works for some public posts — IG has been gradually restricting it.
        try {
          const jsonRes = await fetch(`https://www.instagram.com/p/${code}/?__a=1&__d=dis`, {
            headers: { ...headers, "X-IG-App-ID": "936619743392459" },
          });
          if (jsonRes.ok) {
            const text = await jsonRes.text();
            if (text.trim().startsWith("{")) {
              const data = JSON.parse(text);
              const media = data?.graphql?.shortcode_media || data?.items?.[0] || data?.shortcode_media;
              if (media) {
                // Carousel — sidecar children each have image_versions2 / display_url
                const children = media.edge_sidecar_to_children?.edges?.map(e => e.node) || media.carousel_media || [];
                if (children.length) {
                  imageUrls = children.map(c =>
                    c.display_url
                    || c.image_versions2?.candidates?.[0]?.url
                  ).filter(Boolean);
                }
                // Single-image post — display_url
                if (!imageUrls.length) {
                  const single = media.display_url || media.image_versions2?.candidates?.[0]?.url;
                  if (single) imageUrls = [single];
                }
                // Caption
                if (!caption) {
                  const cap = media.edge_media_to_caption?.edges?.[0]?.node?.text
                    || media.caption?.text;
                  if (cap) caption = cap;
                }
              }
            }
          }
        } catch (_) { /* fall through to whatever we got from embed */ }

        // Final fallback: the public post page OG tags
        if (!imageUrl && !imageUrls.length) {
          const pageRes = await fetch(`https://www.instagram.com/p/${code}/`, { headers });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const img = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (img) imageUrl = img[1].replace(/&amp;/g, "&");
            if (desc && !caption) {
              caption = decodeEntities(desc[1]);
              const m1 = caption.match(/^"(.+)"\s*-\s*@/s);
              if (m1) caption = m1[1];
            }
          }
        }

        // Normalize: prefer the JSON-derived list (full carousel) over the single embed cover
        if (!imageUrls.length && imageUrl) imageUrls = [imageUrl];
        if (!imageUrls.length) return json({ error: "Instagram blocked the request. Paste images manually instead." }, 502);

        return json({
          code,
          imageUrl: imageUrls[0],
          imageUrls,
          caption,
          postUrl: `https://www.instagram.com/p/${code}/`,
          isCarousel: imageUrls.length > 1,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG image proxy: pipe an IG CDN image through the worker so the admin
    //      can download it without hitting CORS (IG CDN doesn't send ACAO).
    if (request.method === "GET" && path === "/api/ig-proxy") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "url required" }, 400);
      try {
        const u = new URL(target);
        if (!/cdninstagram\.com$|fbcdn\.net$/.test(u.hostname)) {
          return json({ error: "host not allowed" }, 400);
        }
        const res = await fetch(target, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://www.instagram.com/",
          },
        });
        if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);
        return new Response(res.body, {
          headers: {
            "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  },
};
