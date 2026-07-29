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
  return env.ADMIN_TOKEN && auth.slice(7).trim() === env.ADMIN_TOKEN.trim();
};

// Master token = billing/agency only. Controls the suspend flag. The shop's
// ADMIN_TOKEN can NOT flip suspend, so the owner can't reactivate themselves.
const isMaster = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.MASTER_TOKEN && auth.slice(7).trim() === env.MASTER_TOKEN.trim();
};

// When the store is suspended (billing kill-switch), the owner keeps READ access
// to the admin but every WRITE is frozen. MASTER (agency) can still write so the
// store can be maintained while suspended. Returns a 403 Response when the caller
// is blocked, or null when the write may proceed. Authoritative gate: the admin
// UI also blocks these, but this is the real lock the owner can't bypass.
// suspended KV: "0"/absent = active; "1" = FULL pause (public offline overlay +
// admin write-locked, for prospect/demo sites); "admin" = ADMIN-ONLY pause (admin
// write-locked but the public storefront stays fully live, for real clients we
// don't want to embarrass in front of their buyers). Writes are frozen in BOTH
// paused states — the difference is only whether the public site goes dark.
const suspendBlock = async (req, env) => {
  if (isMaster(req, env)) return null;
  const s = await env.BAGS.get("suspended");
  if (s === "1" || s === "admin") {
    return json({ error: "account suspended; contact billing to restore the store" }, 403);
  }
  return null;
};

// SHA-256 hex helper for the owner password flow (Web Crypto, available in
// Workers). Used by /api/check-password and /api/set-password.
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

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

// ---- Caption → brand/category heuristics for IG bulk-sync ----
// Ryker Luxury is MEN'S clothing + footwear (broad catalog). Order matters:
// specific models before generic brand fallbacks; brands before generic types.
const MENSWEAR_BRANDS = [
  // Sneakers — specific models first
  ["nike air force",   "Nike Air Force",     "Sneakers"],
  ["air force",        "Nike Air Force",     "Sneakers"],
  ["nike air max",     "Nike Air Max",       "Sneakers"],
  ["air max",          "Nike Air Max",       "Sneakers"],
  ["nike dunk",        "Nike Dunk",          "Sneakers"],
  ["nike cortez",      "Nike Cortez",        "Sneakers"],
  ["cortez",           "Nike Cortez",        "Sneakers"],
  ["nike sb",          "Nike SB",            "Sneakers"],
  ["jordan 1",         "Jordan 1",           "Sneakers"],
  ["jordan 4",         "Jordan 4",           "Sneakers"],
  ["jordan 11",        "Jordan 11",          "Sneakers"],
  ["jordan",           "Jordan",             "Sneakers"],
  ["adidas yeezy",     "Adidas Yeezy",       "Sneakers"],
  ["yeezy",            "Adidas Yeezy",       "Sneakers"],
  ["adidas samba",     "Adidas Samba",       "Sneakers"],
  ["samba",            "Adidas Samba",       "Sneakers"],
  ["adidas gazelle",   "Adidas Gazelle",     "Sneakers"],
  ["gazelle",          "Adidas Gazelle",     "Sneakers"],
  ["stan smith",       "Adidas Stan Smith",  "Sneakers"],
  ["adidas superstar", "Adidas Superstar",   "Sneakers"],
  ["adidas ultraboost","Adidas Ultraboost",  "Sneakers"],
  ["adidas",           "Adidas",             "Sneakers"],
  ["puma",             "Puma",               "Sneakers"],
  ["new balance",      "New Balance",        "Sneakers"],
  [/\bnb\b/,           "New Balance",        "Sneakers"],
  ["asics",            "Asics",              "Sneakers"],
  ["reebok",           "Reebok",             "Sneakers"],
  ["fila",             "Fila",               "Sneakers"],
  ["vans",             "Vans",               "Sneakers"],
  ["converse",         "Converse",           "Sneakers"],
  // Boots
  ["timberland",       "Timberland",         "Boots"],
  ["dr martens",       "Dr Martens",         "Boots"],
  ["doc martens",      "Dr Martens",         "Boots"],
  ["ugg",              "UGG",                "Boots"],
  [/\bcat\b/,          "CAT",                "Boots"],
  // Clothing — denim
  ["levi's",           "Levi's",             "Jeans"],
  ["levis",            "Levi's",             "Jeans"],
  ["diesel",           "Diesel",             "Jeans"],
  ["wrangler",         "Wrangler",           "Jeans"],
  ["true religion",    "True Religion",      "Jeans"],
  // Clothing — designer suits / shirts
  ["hugo boss",        "Hugo Boss",          "Suits"],
  [/\bboss\b/,         "Hugo Boss",          "Suits"],
  ["armani",           "Armani",             "Suits"],
  ["versace",          "Versace",            "Shirts"],
  // Polos / shirts
  ["polo ralph lauren","Polo Ralph Lauren",  "Polos"],
  ["ralph lauren",     "Polo Ralph Lauren",  "Polos"],
  ["lacoste",          "Lacoste",            "Polos"],
  ["fred perry",       "Fred Perry",         "Polos"],
  // Casual / streetwear
  ["tommy hilfiger",   "Tommy Hilfiger",     "Shirts"],
  [/\btommy\b/,        "Tommy Hilfiger",     "Shirts"],
  ["calvin klein",     "Calvin Klein",       "Tshirts"],
  [/\bck\b/,           "Calvin Klein",       "Tshirts"],
  ["gucci",            "Gucci",              "Tshirts"],
  ["louis vuitton",    "Louis Vuitton",      "Tshirts"],
  [/\blv\b/,           "Louis Vuitton",      "Tshirts"],
  ["balenciaga",       "Balenciaga",         "Tshirts"],
  ["off white",        "Off-White",          "Tshirts"],
  ["off-white",        "Off-White",          "Tshirts"],
  ["supreme",          "Supreme",            "Hoodies"],
  ["champion",         "Champion",           "Hoodies"],
  ["stussy",           "Stüssy",             "Tshirts"],
  ["stüssy",           "Stüssy",             "Tshirts"],
  // Outerwear
  ["north face",       "The North Face",     "Jackets"],
  [/\btnf\b/,          "The North Face",     "Jackets"],
  ["carhartt",         "Carhartt",           "Jackets"],
  ["patagonia",        "Patagonia",          "Jackets"],
  // Tracksuits
  ["kappa",            "Kappa",              "Tracksuits"],
  ["ellesse",          "Ellesse",            "Tracksuits"],
  ["sergio tacchini",  "Sergio Tacchini",    "Tracksuits"],
  // Generic type fallbacks (when no brand)
  ["tracksuit",        null,                 "Tracksuits"],
  ["jogger",           null,                 "Joggers"],
  ["hoodie",           null,                 "Hoodies"],
  ["sweatshirt",       null,                 "Hoodies"],
  ["jacket",           null,                 "Jackets"],
  ["bomber",           null,                 "Jackets"],
  ["parka",            null,                 "Jackets"],
  ["overcoat",         null,                 "Jackets"],
  [/\bcoat\b/,         null,                 "Jackets"],
  [/\bsuit\b/,         null,                 "Suits"],
  ["blazer",           null,                 "Suits"],
  [/\bpolo\b/,         null,                 "Polos"],
  [/\btee\b/,          null,                 "Tshirts"],
  ["tshirt",           null,                 "Tshirts"],
  ["t-shirt",          null,                 "Tshirts"],
  [/\bshirt\b/,        null,                 "Shirts"],
  ["denim",            null,                 "Jeans"],
  [/\bjeans?\b/,       null,                 "Jeans"],
  [/\bshorts?\b/,      null,                 "Shorts"],
  ["sneaker",          null,                 "Sneakers"],
  ["trainer",          null,                 "Sneakers"],
  [/\bboots?\b/,       null,                 "Boots"],
  [/\bcaps?\b/,        null,                 "Caps"],
  [/\bhats?\b/,        null,                 "Caps"],
  // Generic "shoes" last — only used if no other footwear type matched
  [/\bshoes?\b/,       null,                 "Shoes"],
];

function deriveBrand(caption) {
  let text = (caption || "").toLowerCase().trim();
  text = text.replace(/^[a-z0-9._]+ /, "");  // strip leading "username "
  const padded = " " + text + " ";
  for (const [key, name, cat] of MENSWEAR_BRANDS) {
    if (key instanceof RegExp) {
      if (key.test(padded)) return [name, cat];
    } else if (padded.includes(key)) {
      return [name, cat];
    }
  }
  return [null, null];
}

// Ryker is NEW-STOCK — captions like "Sizes M, L, XL" or "S/M/L/XL" mean the
// owner has stock in each of those sizes. Default qty=1 per detected size;
// owner adjusts in admin. Returns { name, category, stock: { sz: qty }, description }.
// Pull a price out of a caption — ONLY when it's unambiguous, so the auto-sync
// never puts a WRONG number on the live shop. We trust a number only if it sits
// next to a money marker (Ksh / KES / @ / trailing /= /-) or a "k" thousands
// suffix, or after price/bei/now. A bare number with no marker (could be a size,
// phone, quantity) is ignored — those posts land blank ("Price on request"),
// which is the ONLY time we show no price (owner's rule, 2026-06-16). Returns an
// integer KES amount, or 0 when the caption carries no clear price.
function parsePriceFromCaption(caption) {
  const text = (caption || "").replace(/\s+/g, " ").trim();
  if (!text) return 0;
  const cands = [];
  const push = (raw, mult, index) => {
    if (raw == null) return;
    const n = Math.round(parseFloat(String(raw).replace(/,/g, "")) * (mult || 1));
    // Sane Nairobi fashion range — rejects misread sizes/quantities/years.
    if (Number.isFinite(n) && n >= 100 && n <= 1000000) cands.push({ n, index });
  };
  let m, re;
  // Ksh / Kshs / KES + number (+ optional k)
  re = /(?:ksh?s?|kes)\s*\.?\s*([\d,]+(?:\.\d+)?)\s*(k)?/gi;
  while ((m = re.exec(text))) push(m[1], m[2] ? 1000 : 1, m.index);
  // @ + number (+ optional k) — "@1200", "@1.2k"
  re = /@\s*([\d,]+(?:\.\d+)?)\s*(k)?/gi;
  while ((m = re.exec(text))) push(m[1], m[2] ? 1000 : 1, m.index);
  // number + trailing /= or /-  — "1800/=", "1,500/-"
  re = /([\d,]+(?:\.\d+)?)\s*\/[=\-]/gi;
  while ((m = re.exec(text))) push(m[1], 1, m.index);
  // price/bei/now/going for + number
  re = /(?:price|bei|now|going for)\s*:?\s*(?:ksh?s?\s*)?([\d,]+(?:\.\d+)?)\s*(k)?/gi;
  while ((m = re.exec(text))) push(m[1], m[2] ? 1000 : 1, m.index);
  // standalone thousands suffix — "1.8k", "15k" — unless right after a size word
  re = /(?:^|[^a-z0-9.])(\d{1,3}(?:\.\d+)?)\s*k\b/gi;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 6), m.index).toLowerCase();
    if (/siz|sz/.test(before)) continue;
    push(m[1], 1000, m.index);
  }
  if (!cands.length) return 0;
  // First clearly-marked price by position — captions state the price once;
  // the owner edits the rare "was X now Y" case in admin.
  cands.sort((a, b) => a.index - b.index);
  return cands[0].n;
}

// Build a public product description from an IG caption. Keep the descriptive
// text the owner wrote, but strip the parts that don't belong on the storefront:
// hashtags, the price (it has its own field — prices must NOT appear in the
// description), contact/CTA tails, and SOLD flags. Em/en dashes go to commas per
// the copy standard. Falls back to the canned line when nothing useful survives.
// Do NOT strip a leading word as an "IG handle" here — feed-API captions have no
// handle prefix, so that strip eats the first real product word.
const DEFAULT_DESC = "Premium menswear, hand-selected. Photographed exactly as it is. Pick your size below to enquire.";
function captionToDescription(caption) {
  let t = (caption || "").replace(/\r/g, "").trim();
  if (!t) return DEFAULT_DESC;
  t = t.split(/whastup|whatsapp|wa\.me|dm to order|dm to buy|inbox|order now|0\d{8,9}|\+?254\d{6,}/i)[0];
  t = t
    .replace(/#[^\s#]+/g, "")
    .replace(/\d[\d,]*(?:\.\d+)?\s*\/[=\-]/g, "")                      // 4500/= 4500/-
    .replace(/(?:ksh?s?\.?|kes)\s*\.?\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi, "") // Ksh 4500 / KES4500
    .replace(/@\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi, "")                    // @4500
    .replace(/\b(?:price|bei|now|going for)\s*:?\s*(?:ksh?s?\s*)?\d[\d,]*\s*k?\b/gi, "")
    .replace(/\s*\/[=\-]/g, "")                                        // orphan /= /-
    .replace(/\s*@(?!\w)/g, "")                                        // orphan @
    .replace(/\bsold(?:\s*out)?\b/gi, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[•|]+/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.,\-:;]+|[\s.,\-:;]+$/g, "")
    .trim();
  return t.length >= 8 ? t : DEFAULT_DESC;
}

function parseCaptionForBag(caption) {
  const text = (caption || "").trim();
  const lower = text.toLowerCase();
  let [brand, category] = deriveBrand(caption);
  // Name + description from the price-stripped caption, so no "@1750/=" ever
  // lands in the NAME (the fallback used to take the raw caption clause).
  const desc = captionToDescription(caption);
  const hasCaption = desc !== DEFAULT_DESC;
  let name, description;
  if (brand) {
    name = brand;
    description = hasCaption ? desc : DEFAULT_DESC;
  } else if (hasCaption) {
    // No brand — the descriptor is the name (first clause, Title Case); the rest
    // becomes the description, falling back to the canned line when there's none.
    const head = (desc.split(/[.!?\n]|,(?=\s)/)[0] || "").trim();
    name = (head || desc).slice(0, 70).replace(/\b\w/g, c => c.toUpperCase());
    const rest = desc.slice(head.length).replace(/^[\s.,!?]+/, "").trim();
    description = rest.length >= 10 ? rest : DEFAULT_DESC;
  } else {
    name = "New Item";
    description = DEFAULT_DESC;
  }

  const stock = {};

  // --- Apparel letter sizes: XS, S, M, L, XL, XXL, 3XL, 4XL, 5XL ---
  // Match any standalone size token. Captions: "Sizes M, L, XL", "S/M/L/XL",
  // "available in M L XL", "sizes: S to XXL".
  // New products start at 3 of each size FOUND in the caption — the owner
  // restocks up/down from there instead of starting every size at 1 (owner ask
  // 2026-06-18). The "One Size" fallback below stays at 1: it's a "no size info"
  // placeholder, not a size the caption actually provided.
  const NEW_SIZE_QTY = 3;
  const APPAREL = ["XS", "XXL", "XXXL", "3XL", "4XL", "5XL", "S", "M", "L", "XL"];
  // Use a tagged scan so "size XS" isn't double-counted as XS + S.
  const padded = " " + lower.replace(/[,/|·]+/g, " ").replace(/\s+/g, " ") + " ";
  for (const sz of APPAREL) {
    const re = new RegExp(`(?:^|\\s|[^a-z0-9])${sz.toLowerCase()}(?=$|\\s|[^a-z0-9])`, "g");
    if (re.test(padded)) {
      // Normalise XXXL → 3XL for consistency with admin stock grid
      const key = sz === "XXXL" ? "3XL" : sz;
      stock[key] = NEW_SIZE_QTY;
    }
  }

  // --- Numeric jeans waist sizes (28-44) — only when category looks like jeans/shorts/joggers ---
  const isLowerBody = /jeans?|denim|shorts?|joggers?|trouser|pants|chinos|waist/i.test(text);
  if (isLowerBody) {
    const seen = new Set();
    // Lookahead for the trailing boundary so consecutive numbers ("32 34 36")
    // don't get skipped by the regex consuming the space between them.
    const numRe = /(?<![0-9])(\d{2})(?![0-9])/g;
    let m;
    while ((m = numRe.exec(padded)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 28 && n <= 44 && !seen.has(n)) {
        stock[String(n)] = NEW_SIZE_QTY;
        seen.add(n);
      }
    }
  }

  // --- Shoe sizes UK4-UK13 — only when category looks like footwear ---
  const isFoot = /sneaker|trainer|boots?|shoes?|sandal|slide/i.test(text)
    || /^(Sneakers|Boots|Shoes)$/.test(category || "");
  if (isFoot) {
    // "UK 9", "UK9", "9uk", "size 9"
    const ukRe = /(?:uk\s*(\d{1,2})|(\d{1,2})\s*uk)/gi;
    let m;
    while ((m = ukRe.exec(lower)) !== null) {
      const n = parseInt(m[1] || m[2], 10);
      if (n >= 4 && n <= 13) stock[`UK${n}`] = NEW_SIZE_QTY;
    }
  }

  // Default to One Size only if literally nothing matched. Owner edits in admin.
  if (!Object.keys(stock).length) stock["One Size"] = 1;

  return {
    name: name || "New Item",
    category: category || null,
    stock,
    price: parsePriceFromCaption(caption),
    description,
  };
}

// Is this caption plausibly a product post?
function looksLikeProduct(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase();
  // Size signal (apparel letter, jeans waist number, or UK shoe size)
  if (/(?:^|\s|[,/|·])(?:xs|s|m|l|xl|xxl|3xl|4xl|5xl)(?:$|\s|[,/|·])/i.test(" " + lower + " ")) return true;
  if (/\b(?:uk\s*\d{1,2}|\d{1,2}\s*uk|size\s+\d{2,})\b/i.test(lower)) return true;
  if (/\bsizes?\s*[:\-]?\s*/i.test(lower)) return true;
  for (const [key] of MENSWEAR_BRANDS) {
    if (key instanceof RegExp ? key.test(lower) : lower.includes(key)) return true;
  }
  return false;
}

// ---- IG response normalisers (module-level so endpoints share them) ----
function extractFromTimelineNode(node) {
  const shortcode = node.shortcode || node.code;
  let imageUrls = [];
  const children = node.edge_sidecar_to_children?.edges || [];
  if (children.length) {
    imageUrls = children.map(({ node: c }) => c.display_url || c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (node.display_url) {
    imageUrls = [node.display_url];
  } else if (node.image_versions2?.candidates?.length) {
    imageUrls = [node.image_versions2.candidates[0].url];
  }
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : (node.taken_at ? new Date(node.taken_at * 1000).toISOString() : null),
  };
}

function extractFromFeedItem(m) {
  const carousel = m.carousel_media || [];
  let imageUrls = [];
  if (carousel.length) {
    imageUrls = carousel.map(c => c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (m.image_versions2?.candidates?.length) {
    imageUrls = [m.image_versions2.candidates[0].url];
  }
  const shortcode = m.code;
  const caption = m.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : null,
  };
}

// 3-tier IG feed pull: embedded timeline → GraphQL pagination → /api/v1/feed/user/.
// Always prefer user_id over username — username triggers a rate-limited profile call.
async function fetchIgFeed({ username, userId: directUserId, count = 50, maxId = "" } = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
    "X-IG-App-ID": "936619743392459",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.instagram.com/${username || ""}/`,
  };
  let userId, user = null, profile = null;
  if (directUserId) {
    userId = directUserId;
    profile = { id: userId, username: username || null };
  } else {
    const pRes = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { headers });
    if (!pRes.ok) return { error: `profile lookup ${pRes.status}` };
    const pData = await pRes.json();
    user = pData?.data?.user;
    if (!user?.id) return { error: "user id not found" };
    userId = user.id;
    profile = {
      id: userId,
      username: user.username,
      fullName: user.full_name,
      biography: user.biography,
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
      followers: user.edge_followed_by?.count,
    };
  }
  const qsTail = `?count=${count}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;
  let items = [];
  let moreAvailable = false;
  let nextMaxId = null;
  const embedded = user?.edge_owner_to_timeline_media;
  if (!maxId && embedded?.edges?.length) {
    items = embedded.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl);
    moreAvailable = !!embedded.page_info?.has_next_page;
    nextMaxId = embedded.page_info?.end_cursor || null;
  }
  if (items.length < count && (maxId || moreAvailable || directUserId)) {
    const cursor = maxId || nextMaxId;
    const variables = encodeURIComponent(JSON.stringify({ id: userId, first: count, after: cursor || null }));
    const gqlRes = await fetch(`https://www.instagram.com/graphql/query/?query_hash=003056d32c2554def87228bc3fd9668a&variables=${variables}`, { headers });
    if (gqlRes.ok) {
      const gData = await gqlRes.json();
      const media = gData?.data?.user?.edge_owner_to_timeline_media;
      if (media?.edges?.length) {
        items = items.concat(media.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl));
        moreAvailable = !!media.page_info?.has_next_page;
        nextMaxId = media.page_info?.end_cursor || null;
      }
    }
  }
  if (!items.length) {
    let fRes = await fetch(`https://www.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) fRes = await fetch(`https://i.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) return { error: `feed fetch ${fRes.status}`, profile };
    const fData = await fRes.json();
    items = (fData.items || []).map(extractFromFeedItem).filter(it => it.imageUrl);
    moreAvailable = !!fData.more_available;
    nextMaxId = fData.next_max_id || null;
  }
  return { profile, items, count: items.length, more_available: moreAvailable, next_max_id: nextMaxId };
}

// Base64-encode a Uint8Array in chunks (avoids call-stack overflow on large images).
function arrayToB64(buf) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Vision-model classifier — Llama 3.2 11B Vision sees the photo so it can
// distinguish polos vs t-shirts vs shirts, sneakers vs boots vs formal shoes.
// Returns { is_product, name, category, reason, via } or { _debug } on failure.
async function classifyPostWithVision(env, caption, imageUrl) {
  if (!env.AI || !imageUrl) return null;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return { _debug: `img fetch ${imgRes.status}` };
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    const trimmed = (caption || "").replace(/\s+/g, " ").slice(0, 400);
    const prompt = `You sort Instagram posts from Ryker Luxury — a Nairobi men's fashion shop selling clothing AND footwear. You're given ONE photo + ONE caption. Decide:
1. Is this a single product (one specific item or one stocked SKU) for sale? (is_product true|false)
2. What brand / model is it? (name — short, e.g. "Tommy Hilfiger Polo", "Nike Air Force", or "New Item" if unknown)
3. What category? Pick EXACTLY one from this list — never invent another:
   Tshirts, Shirts, Polos, Jeans, Shorts, Joggers, Tracksuits, Hoodies, Jackets, Suits, Shoes, Sneakers, Boots, Caps

Category guide (look carefully — this is the hardest call):
- Tshirts: short-sleeve crew/v-neck pullover, NO collar, NO buttons. Plain tees, graphic tees.
- Polos: short-sleeve pullover WITH a soft fold-down collar + 2-3 buttons at the neck. Lacoste-style.
- Shirts: long-sleeve OR short-sleeve with FULL button-up front + structured collar. Includes oxfords, casual button-downs, formal shirts.
- Hoodies: pullover or zip with a HOOD; also sweatshirts (crewnecks without zips).
- Jackets: outerwear — bombers, denim/leather jackets, parkas, puffers, blazers count as Suits if matched to trousers, otherwise Jackets.
- Suits: matched jacket + trousers, or formal suits/blazers.
- Jeans: denim trousers (any wash).
- Shorts: above-the-knee bottoms (denim, cargo, sweat).
- Joggers: tapered casual sweatpants with elastic ankle cuffs.
- Tracksuits: matching top + bottom athletic set (Kappa, Ellesse).
- Sneakers: casual athletic / lifestyle shoes — Air Force, Jordan, Yeezy, Adidas, Puma, Nike, dunks, basketball shoes, running.
- Boots: ankle-high or taller — Timberland, Dr Martens, work boots, hiking boots, chukkas.
- Shoes: formal/dress shoes ONLY — Oxford, derby, brogue, loafers, monk-strap. Never use "Shoes" for sneakers.
- Caps: caps, hats, beanies.

NEVER use Crossbody, Tote, Clutch, Hobo, Heels, Sandals, Bags, Handbags — Ryker only sells men's clothing and footwear. If the photo shows a women's bag or women's heels, set is_product=false.

is_product=false ONLY for: shop intros, marketing banners, owner photos, restock teasers, holiday greetings, "DM us" announcements without a specific item.

Caption: """${trimmed}"""

Reply with strict minified JSON, no prose, no code fences:
{"is_product":true|false,"name":"<brand+model or New Item>","category":"<exactly one from the list>","reason":"<3-6 words>"}`;
    const result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      prompt,
      image: Array.from(imgBytes),
      max_tokens: 220,
      temperature: 0.1,
    });
    let parsed = null;
    if (result?.response && typeof result.response === "object") {
      parsed = result.response;
    } else {
      let text = "";
      if (typeof result?.response === "string") text = result.response;
      else if (typeof result?.description === "string") text = result.description;
      else if (typeof result === "string") text = result;
      text = text.trim();
      if (text) {
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (_) {}
        }
      }
    }
    if (!parsed) return { _debug: "could not parse vision output", raw: JSON.stringify(result).slice(0, 400) };
    return {
      is_product: !!(parsed.is_product ?? parsed.is_shoe ?? parsed.is_item),
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
      via: "vision",
    };
  } catch (err) {
    return { _debug: `vision throw: ${err.message}` };
  }
}

// Text-only LLM classifier — fallback when vision call fails. Best for decoding
// caption shorthand (brand names) when the photo can't carry the call.
async function classifyPostWithAi(env, caption) {
  if (!env.AI || !caption) return null;
  const trimmed = caption.replace(/\s+/g, " ").slice(0, 400);
  const prompt = `You sort Instagram posts from Ryker Luxury — a Nairobi men's fashion shop selling clothing AND footwear. Each post is either ONE specific product (or one stocked SKU) listed for sale, OR a non-product post.

Reply with strict minified JSON only, no prose, no code fences.

Schema:
{"is_product": true|false, "name": "<short brand + model OR generic descriptor>", "category": "<exactly one of: Tshirts, Shirts, Polos, Jeans, Shorts, Joggers, Tracksuits, Hoodies, Jackets, Suits, Shoes, Sneakers, Boots, Caps>", "reason": "<3-6 words>"}

NEVER output Crossbody, Tote, Clutch, Hobo, Heels, Sandals, Bags, Handbags — Ryker only sells men's clothing and footwear.

Rules:
- is_product = true when the caption mentions a clothing/footwear item and at least one size signal (S, M, L, XL, "size 32", "UK 9", "Sizes M L XL", etc.) OR a known brand/model.
- is_product = false for shop intros, owner photos, marketing banners, holiday greetings, generic "DM us" announcements with no specific product.
- Decode shorthand: "Tommy" → Tommy Hilfiger; "CK" → Calvin Klein; "LV" → Louis Vuitton; "Polo" alone usually = Polo Ralph Lauren when capitalised at the start; "NB" → New Balance; "TNF" → The North Face.
- name MUST be brand+model when known. Strip prices, sizes, phone numbers, hashtags. If brand unknown but item type clear, name = generic description (e.g. "Slim-Fit Jeans", "Cargo Shorts"). If truly unknown, name = "New Item".
- category: match the product to the EXACT list. T-shirts and tees → Tshirts. Anything with a soft collar + neck buttons → Polos. Button-up shirts → Shirts. Generic "shoes" mention with no clear sneaker/boot signal → Shoes (use sparingly — most are Sneakers).

Caption: """${trimmed}"""`;
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 160,
    });
    const text = (result?.response || "").trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      is_product: !!(parsed.is_product ?? parsed.is_shoe ?? parsed.is_item),
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
    };
  } catch (_) {
    return null;
  }
}

// Ryker stocks men's clothing + footwear only. Coerce any AI-suggested category
// that's outside the allowed list to either the closest legal option or null.
const RYKER_CATEGORIES = new Set([
  "Tshirts","Shirts","Polos","Jeans","Shorts","Joggers","Tracksuits",
  "Hoodies","Jackets","Suits","Shoes","Sneakers","Boots","Caps",
]);
function coerceCategory(c) {
  if (!c) return null;
  const raw = String(c).trim();
  if (RYKER_CATEGORIES.has(raw)) return raw;
  const lower = raw.toLowerCase();
  // Strip the bag / women's categories outright
  if (/^(cross\s*body|tote|clutch|hobo|bags?|handbags?|purse|heels?|sandals?|stilettos?|wedges?|pumps?)$/i.test(lower)) return null;
  // Plural / singular / spelling variants
  if (/^(tee|tees|t[\s\-]?shirts?)$/i.test(lower)) return "Tshirts";
  if (/^(shirts?|button[\s\-]?ups?|oxfords?)$/i.test(lower)) return "Shirts";
  if (/^polos?$/i.test(lower)) return "Polos";
  if (/^(jeans?|denim)$/i.test(lower)) return "Jeans";
  if (/^shorts?$/i.test(lower)) return "Shorts";
  if (/^joggers?$/i.test(lower)) return "Joggers";
  if (/^(tracksuits?|track\s*suits?)$/i.test(lower)) return "Tracksuits";
  if (/^(hoodies?|sweatshirts?|sweaters?|pullovers?)$/i.test(lower)) return "Hoodies";
  if (/^(jackets?|coats?|bombers?|parkas?|puffers?)$/i.test(lower)) return "Jackets";
  if (/^(suits?|blazers?)$/i.test(lower)) return "Suits";
  if (/^(sneakers?|trainers?)$/i.test(lower)) return "Sneakers";
  if (/^boots?$/i.test(lower)) return "Boots";
  if (/^(formal|dress|oxford|derby|brogue|loafers?|moccasins?|monk[\s\-]?straps?)$/i.test(lower)) return "Shoes";
  if (/^(caps?|hats?|beanies?|snapbacks?)$/i.test(lower)) return "Caps";
  // Don't invent — return null so the owner picks
  return null;
}

// ---- Daily closing report (WhatsApp via WaSender) ----
// Once a day the scheduled() cron reads the day's sales + insights from KV,
// builds a plain-language summary, and WhatsApps it to the owner. Config lives
// in its OWN KV key "reportcfg" = { phone, enabled } — never in "data" (which
// is public via /api/bags). WaSender token is a worker secret WASENDER_TOKEN.
const SHOP_NAME = "Ryker Luxury";              // per-fork: shop's display name
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;      // Africa/Nairobi = UTC+3, no DST

// EAT calendar date (YYYY-MM-DD) for an epoch-ms instant
const eatDateKey = (ms) => new Date(ms + EAT_OFFSET_MS).toISOString().slice(0, 10);
const fmtKshReport = (n) => "Ksh " + Number(n || 0).toLocaleString("en-US");

// WaSender wants a bare MSISDN. Storage may be 07.., 7.., +254.., 254..
function waNormPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "254" + d.slice(1);
  else if (d.startsWith("7") || d.startsWith("1")) d = "254" + d;
  return d;
}

// Build the owner's report text for "today" (EAT) from the data + stats blobs.
function buildDailyReport(data, stats, nowMs) {
  const today = eatDateKey(nowMs);
  const bags = Array.isArray(data.bags) ? data.bags : [];
  let count = 0, units = 0, revenue = 0, cash = 0, mpesa = 0;
  const perItem = {};
  for (const b of bags) {
    for (const s of (b.sales || [])) {
      if (!s || !s.soldAt || eatDateKey(Date.parse(s.soldAt)) !== today) continue;
      const qty = Number(s.qty) || 1;
      const amt = (Number(s.salePrice) || 0) * qty;
      count++; units += qty; revenue += amt;
      if (s.paymentMethod === "mpesa") mpesa += amt; else cash += amt;
      perItem[b.name] = (perItem[b.name] || 0) + qty;
    }
  }
  const low = [];
  for (const b of bags) {
    const st = b.stock && typeof b.stock === "object" ? b.stock : null;
    if (!st || !Object.keys(st).length) continue;
    const total = Object.values(st).reduce((a, n) => a + (Number(n) || 0), 0);
    if (total >= 1 && total <= 3) low.push(`${b.name} (${total} left)`);
  }
  const topItems = Object.entries(perItem).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, q]) => `${n} x${q}`);
  const noRes = (stats && stats.searchNoResults) || {};
  const wanted = Object.entries(noRes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);

  const L = [`*${SHOP_NAME} — today's report*`, today, ""];
  if (count === 0) {
    L.push("No sales recorded today yet.");
  } else {
    L.push(`🧾 ${count} ${count === 1 ? "sale" : "sales"} · ${units} ${units === 1 ? "item" : "items"}`);
    L.push(`💰 ${fmtKshReport(revenue)}`);
    L.push(`   💵 Cash ${fmtKshReport(cash)} · 📱 M-Pesa ${fmtKshReport(mpesa)}`);
    if (topItems.length) L.push(`🔥 Top: ${topItems.join(", ")}`);
  }
  if (low.length) { L.push(""); L.push(`📦 Low stock: ${low.slice(0, 5).join(", ")}`); }
  if (wanted.length) { L.push(""); L.push(`🔎 Searched but not found: ${wanted.join(", ")}`); }
  return L.join("\n");
}

async function sendViaWaSender(env, phone, text) {
  const token = (env.WASENDER_TOKEN || "").trim();
  if (!token) return { ok: false, error: "WASENDER_TOKEN not set" };
  const to = waNormPhone(phone);
  if (!to) return { ok: false, error: "no phone" };
  try {
    const r = await fetch("https://wasenderapi.com/api/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ to, text }),
    });
    const body = await r.text().catch(() => "");
    return { ok: r.ok, status: r.status, body: body.slice(0, 300) };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function runDailyReport(env, force) {
  let cfg;
  try { cfg = JSON.parse(await env.BAGS.get("reportcfg")) || {}; } catch { cfg = {}; }
  if (!force && !cfg.enabled) return { ok: false, skipped: "disabled" };
  if (!cfg.phone) return { ok: false, skipped: "no phone" };
  let data, stats;
  try { data = JSON.parse(await env.BAGS.get("data")) || {}; } catch { data = {}; }
  try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
  return await sendViaWaSender(env, cfg.phone, buildDailyReport(data, stats, Date.now()));
}

// ---- IG auto-sync (cron) ----
// Same pipeline as the admin's "Check for new posts" widget, minus the human
// review step: fetch the feed, AI-classify (heuristic + vision + text), parse
// name/category/sizes from the caption, download the cover image into KV,
// prepend to the catalog. Runs twice a day (afternoon + evening waves — owners
// post during the day, so a morning-only sync would mostly catch yesterday's
// posts); the owner can still edit/delete from the admin.
// 3k+ tier feature (owner directive 2026-06-12). Cap 20/run on Workers Paid
// (~112 of ~1,000 subrequests) — the cap keeps IG fetch volume gentle.
// Kill switch: KV key `autosync` = {"enabled":false}. Suspended shops skip.
// Stagger offset: :10 past the wave hour (Iman holds :00 [disabled],
// ThriftLux :20) — IG rate-limits by source IP and the fleet shares
// Cloudflare egress IPs, so shops must not all fetch at the same second.
const IG_AUTOSYNC_USER_ID = "47659611317"; // @rykerluxury
const API_ORIGIN = "https://rykerluxury-api.stawisystems.workers.dev";
const AUTOSYNC_MAX_ITEMS = 20;

async function runIgAutoSync(env) {
  if ((await env.BAGS.get("suspended")) === "1") return { ok: false, skipped: "suspended" };
  let cfg;
  try { cfg = JSON.parse(await env.BAGS.get("autosync")) || {}; } catch { cfg = {}; }
  if (cfg.enabled === false) return { ok: false, skipped: "disabled" };

  const existingRaw = await env.BAGS.get("data");
  const data = existingRaw ? JSON.parse(existingRaw) : { bags: [], settings: {} };
  const existingIds = new Set((data.bags || []).map(b => b.id));
  // Permanent "already pulled" ledger — the tombstone the in-catalog check can't
  // be. An item synced once stays here even after the owner DELETES it, so the
  // cron never resurrects deleted items (the bug Joyce hit twice, 2026-06-16).
  const ledgerRaw = await env.BAGS.get("ig_synced_codes");
  const syncedCodes = new Set(ledgerRaw ? JSON.parse(ledgerRaw) : []);

  const feed = await fetchIgFeed({ userId: IG_AUTOSYNC_USER_ID, count: 24 });
  if (!feed.items) return { ok: false, error: feed.error || "feed empty" };

  // A few extra candidates beyond the cap so non-product posts don't eat the run.
  const fresh = feed.items
    .filter(it => it.imageUrl && it.shortcode && !existingIds.has(`ig_${it.shortcode}`) && !syncedCodes.has(it.shortcode))
    .slice(0, AUTOSYNC_MAX_ITEMS + 3);

  const newBags = [];
  const skipped = [];
  for (const it of fresh) {
    if (newBags.length >= AUTOSYNC_MAX_ITEMS) break;
    const heuristic = looksLikeProduct(it.caption);
    const [vision, text] = await Promise.all([
      classifyPostWithVision(env, it.caption, it.imageUrl),
      classifyPostWithAi(env, it.caption),
    ]);
    const visionOk = vision && !vision._debug;
    const isProduct = heuristic || (visionOk && vision.is_product) || (text && text.is_product);
    if (!isProduct) { skipped.push({ shortcode: it.shortcode, reason: "not a product" }); continue; }

    // Same name/category resolution order as /api/ig-discover.
    const sug = parseCaptionForBag(it.caption);
    const looksLikeFragment = (n) => !n || /^(size|sizes|tn|hh|nb)$/i.test(String(n).trim());
    let name = sug.name;
    if (text?.is_product && !looksLikeFragment(text.name) && text.name !== "New Item") {
      name = text.name.trim();
    } else if (visionOk && vision.is_product && !looksLikeFragment(vision.name) && vision.name !== "New Item") {
      name = vision.name.trim();
    }
    let category = coerceCategory(sug.category);
    if (visionOk && vision.is_product && vision.category) {
      const c = coerceCategory(vision.category);
      if (c) category = c;
    } else if (text?.is_product && text.category) {
      const c = coerceCategory(text.category);
      if (c) category = c;
    }
    if (!category) category = "Shirts";

    // Cover image only on auto-sync; the owner can add carousel extras from
    // the admin's edit form whenever they want.
    try {
      const r = await fetch(it.imageUrl);
      if (!r.ok) throw new Error(`image fetch ${r.status}`);
      const b64 = arrayToB64(new Uint8Array(await r.arrayBuffer()));
      const fname = `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
      await env.BAGS.put(`img:${fname}`, b64);
      await env.BAGS.put(`mime:${fname}`, "image/jpeg");

      const stock = Object.keys(sug.stock || {}).length ? sug.stock : { "One Size": 1 };
      const bag = {
        id: `ig_${it.shortcode}`,
        name: (name || "New Item").slice(0, 80),
        category,
        description: sug.description,
        price: sug.price || 0, // parsed from caption; 0 (blank) only when no price posted
        stock,
        sales: [],
        image: `${API_ORIGIN}/img/${fname}`,
        createdAt: it.takenAt || new Date().toISOString(),
        instagramUrl: `https://www.instagram.com/p/${it.shortcode}/`,
        autoSynced: true,
      };
      newBags.push(bag);
      existingIds.add(bag.id);
    } catch (e) {
      skipped.push({ shortcode: it.shortcode, reason: e.message });
    }
  }

  if (newBags.length) {
    data.bags = newBags.concat(data.bags);
    await env.BAGS.put("data", JSON.stringify(data));
    // Tombstone every committed shortcode so deleting it later can't bring it back.
    for (const b of newBags) syncedCodes.add(b.id.slice(3));
    await env.BAGS.put("ig_synced_codes", JSON.stringify([...syncedCodes]));
  }
  return { ok: true, added: newBags.length, names: newBags.map(b => b.name), skipped };
}

export default {
  // Cloudflare Cron Triggers (see wrangler.toml [triggers]).
  //   "0 17 * * *" (20:00 EAT) → daily WhatsApp report (no-ops unless enabled)
  //   any other cron → IG auto-sync (afternoon + evening waves)
  async scheduled(event, env, ctx) {
    if (event.cron === "0 17 * * *") {
      ctx.waitUntil(runDailyReport(env, false));
      return;
    }
    ctx.waitUntil(runIgAutoSync(env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Public: catalog data
    if (request.method === "GET" && path === "/api/bags") {
      const raw = await env.BAGS.get("data");
      const data = raw ? JSON.parse(raw) : { bags: [], settings: {} };
      // Billing kill-switch: stored in its own KV key so the owner's admin
      // publishes (which only write "data") can never clear it. `suspended` is
      // true in BOTH paused states (so the admin write-locks either way);
      // `suspendMode` tells the PUBLIC site whether to go dark ("full") or stay
      // live ("admin"). Absent when active.
      const _sus = await env.BAGS.get("suspended");
      data.suspended = _sus === "1" || _sus === "admin";
      data.suspendMode = _sus === "admin" ? "admin" : (_sus === "1" ? "full" : null);
      // PRIVACY: strip buyer PII (sales[].buyerName/buyerPhone/notes, soldTo) for
      // unauthed callers. The storefront only reads sold/price/salePrice/sales.length,
      // never buyer details. The admin sends a Bearer token and gets the full data.
      const admin = isAuthed(request, env);
      if (!admin && Array.isArray(data.bags)) {
        data.bags = data.bags.map(b => {
          if (!b || typeof b !== "object") return b;
          let nb = b;
          if ("soldTo" in nb) { const { soldTo, ...r } = nb; nb = r; }
          if (Array.isArray(nb.sales)) nb = { ...nb, sales: nb.sales.map(s => {
            if (!s || typeof s !== "object") return s;
            const { buyerName, buyerPhone, notes, name, phone, buyer, ...keep } = s;
            return keep;
          }) };
          return nb;
        });
      }
      // The manually-added clients list is owner-only CRM data (names + phones) —
      // never expose it publicly. Admin (Bearer) keeps it for the Clients tab.
      if (!admin && data.clients) delete data.clients;
      // Expenses are the owner's private books (ad spend, costs) — never public.
      if (!admin && data.expenses) delete data.expenses;
      return json(data, 200, admin ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=10" });
    }

    // Billing only: flip the suspend flag. Authed by MASTER_TOKEN (not the shop admin token).
    // body.mode: "admin" = admin-only pause (public site stays live, for real
    // clients); anything else (default) = "full" pause (public offline overlay,
    // for prospect/demo sites). Ignored when suspended is false.
    if (request.method === "POST" && path === "/api/suspend") {
      if (!isMaster(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const suspended = !!body.suspended;
      const val = suspended ? (body.mode === "admin" ? "admin" : "1") : "0";
      await env.BAGS.put("suspended", val);
      return json({ ok: true, suspended, mode: suspended ? (val === "admin" ? "admin" : "full") : null });
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

    // Per-item share page for WhatsApp/social link previews. The catalog Enquire
    // link ends with `${API_BASE}/p/<id>`; WhatsApp crawls this HTML, reads the OG
    // tags, and renders a preview card with the product photo + name + price.
    // A bare image URL doesn't preview reliably; an OG-tagged page always does.
    if (request.method === "GET" && path.startsWith("/p/")) {
      const SITE = "https://rykerluxury.co.ke";
      const esc = (s) => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const id = decodeURIComponent(path.slice(3));
      const raw = await env.BAGS.get("data");
      const bags = raw ? (JSON.parse(raw).bags || []) : [];
      const item = bags.find(b => b.id === id);
      if (!item) return Response.redirect(SITE + "/#shop", 302);
      const img = item.image || (item.images && item.images[0]) || `${SITE}/images/og-image.jpg`;
      const mime = /\.png$/i.test(img) ? "image/png" : /\.webp$/i.test(img) ? "image/webp" : "image/jpeg";
      const price = item.price > 0 ? ` · Ksh ${Number(item.price).toLocaleString("en-US")}` : "";
      const title = esc(item.name + price);
      const desc = esc((item.description || "Premium menswear in Nairobi. Tap to view and enquire on WhatsApp.").slice(0, 160));
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Ryker Luxury">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:secure_url" content="${esc(img)}">
<meta property="og:image:type" content="${mime}">
<meta property="og:image:width" content="1080">
<meta property="og:image:height" content="1080">
<meta property="og:url" content="${SITE}/#shop">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:image" content="${esc(img)}">
<title>${title} · Ryker Luxury</title>
<meta http-equiv="refresh" content="0; url=${SITE}/#shop">
</head><body style="font-family:system-ui;background:#0d0a07;color:#e8dcc4;text-align:center;padding:40px">Opening Ryker Luxury…</body></html>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    }

    if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });

    // Owner password — check via worker so the same flow works on every device.
    // Owner password stored as SHA-256 hex in KV "adminpass"; empty KV → fall
    // back to FALLBACK_OWNER_PASSWORD so a fresh install can sign in. Master
    // logins (MASTER_PASSWORD / MASTER_TOKEN) ALWAYS work for agency recovery.
    if (request.method === "POST" && path === "/api/check-password") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const pw = String(body.password || "");
      if (!pw) return json({ ok: false, source: null });
      const mp = (env.MASTER_PASSWORD || "").trim();
      const mt = (env.MASTER_TOKEN || "").trim();
      if ((mp && pw === mp) || (mt && pw === mt)) return json({ ok: true, source: "master" });
      const hashHex = await sha256Hex(pw);
      const stored = await env.BAGS.get("adminpass");
      const FALLBACK_OWNER_PASSWORD = "ryker123";
      const ownerOk = stored ? (stored === hashHex) : (pw === FALLBACK_OWNER_PASSWORD);
      if (ownerOk) return json({ ok: true, source: "owner" });
      // Assistant (staff) login — limited role, set by the owner. Can sell and
      // manage stock but the admin UI hides money/report views for this role.
      const staff = await env.BAGS.get("staffpass");
      if (staff && staff === hashHex) return json({ ok: true, source: "assistant" });
      return json({ ok: false, source: null });
    }

    if (request.method === "POST" && path === "/api/set-password") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const current = String(body.current || "");
      const next = String(body.next || "");
      if (!next || next.length < 8) return json({ error: "new password must be at least 8 characters" }, 400);
      const mp = (env.MASTER_PASSWORD || "").trim();
      const mt = (env.MASTER_TOKEN || "").trim();
      let ok = (mp && current === mp) || (mt && current === mt);
      if (!ok) {
        const stored = await env.BAGS.get("adminpass");
        const curHash = await sha256Hex(current);
        if (stored) ok = stored === curHash;
        else ok = current === "ryker123";
      }
      if (!ok) return json({ error: "current password is wrong" }, 401);
      await env.BAGS.put("adminpass", await sha256Hex(next));
      return json({ ok: true });
    }

    // Set (or remove) the assistant/staff password. OWNER-authenticated: `current`
    // must be a valid owner or master password. Empty `next` removes staff login.
    if (request.method === "POST" && path === "/api/set-staff-password") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const current = String(body.current || "");
      const next = String(body.next || "");
      const mp = (env.MASTER_PASSWORD || "").trim();
      const mt = (env.MASTER_TOKEN || "").trim();
      let ok = (mp && current === mp) || (mt && current === mt);
      if (!ok) {
        const stored = await env.BAGS.get("adminpass");
        const curHash = await sha256Hex(current);
        ok = stored ? stored === curHash : current === "ryker123";
      }
      if (!ok) return json({ error: "current password is wrong" }, 401);
      if (!next) { await env.BAGS.delete("staffpass"); return json({ ok: true, removed: true }); }
      if (next.length < 4) return json({ error: "staff password must be at least 4 characters" }, 400);
      await env.BAGS.put("staffpass", await sha256Hex(next));
      return json({ ok: true });
    }

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

    // ---- Insights: site-wide event tracking (aggregated in KV) ----
    // Public visitors POST events here; the admin reads the aggregate back.
    // Unlike the old per-browser localStorage counters, this sums every
    // visitor on every device into one shared tally under the "stats" key.
    const TRACK_METRICS = new Set(["itemViews", "itemEnquiries", "itemWishlist", "itemIgClicks", "searchNoResults"]);
    if (request.method === "POST" && path === "/api/track") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const metric = String(body.metric || "");
      const key = String(body.key || "").slice(0, 80).trim();
      if (!TRACK_METRICS.has(metric) || !key) return json({ error: "bad metric/key" }, 400);
      // KV read-modify-write. Low-traffic shop, so the occasional lost
      // concurrent increment is acceptable; KV has no atomic counter.
      let stats;
      try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
      stats[metric] = stats[metric] || {};
      // Cap free-text search keys so a bot can't bloat the blob unbounded.
      if (metric === "searchNoResults" && !(key in stats[metric]) && Object.keys(stats[metric]).length >= 800) {
        return json({ ok: true, capped: true });
      }
      stats[metric][key] = (stats[metric][key] || 0) + 1;
      stats._lastUpdated = new Date().toISOString();
      await env.BAGS.put("stats", JSON.stringify(stats));
      return json({ ok: true });
    }

    // Admin: read aggregated site-wide insights
    if (request.method === "GET" && path === "/api/insights") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let stats;
      try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
      return json(stats);
    }

    // Admin: reset aggregated insights (clears the shop-wide tally)
    if (request.method === "POST" && path === "/api/insights-reset") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      await env.BAGS.put("stats", JSON.stringify({ _lastUpdated: new Date().toISOString() }));
      return json({ ok: true });
    }

    // Daily report config — owner sets their phone + on/off. Stored in its own
    // KV key (NOT "data"), so it's never exposed by the public /api/bags.
    if (path === "/api/report-config") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      if (request.method === "GET") {
        let cfg; try { cfg = JSON.parse(await env.BAGS.get("reportcfg")) || {}; } catch { cfg = {}; }
        return json({ phone: cfg.phone || "", enabled: !!cfg.enabled });
      }
      if (request.method === "POST") {
        const blocked = await suspendBlock(request, env); if (blocked) return blocked;
        let body; try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
        const cfg = { phone: String(body.phone || "").trim(), enabled: !!body.enabled };
        await env.BAGS.put("reportcfg", JSON.stringify(cfg));
        return json({ ok: true, ...cfg });
      }
    }

    // Admin/agency: run the IG auto-sync on demand (same code the morning cron runs).
    if (request.method === "POST" && path === "/api/autosync-run") {
      if (!isAuthed(request, env) && !isMaster(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      const res = await runIgAutoSync(env);
      return json(res, res.ok ? 200 : 400);
    }

    // Owner-triggered "send a test report right now" (also used to preview copy).
    if (request.method === "POST" && path === "/api/report-test") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      const res = await runDailyReport(env, true);
      return json(res, res.ok ? 200 : 400);
    }

    // Admin: replace all data
    if (request.method === "POST" && path === "/api/bulk") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!Array.isArray(body.bags)) return json({ error: "bags must be array" }, 400);
      const payload = {
        bags: body.bags,
        settings: body.settings || {},
      };
      if (Array.isArray(body.sets)) payload.sets = body.sets;
      if (Array.isArray(body.clients)) payload.clients = body.clients;
      // Operating expenses (ad spend, packaging, etc.) — admin-only records ledger.
      if (Array.isArray(body.expenses)) payload.expenses = body.expenses;
      await env.BAGS.put("data", JSON.stringify(payload));
      return json({ ok: true, count: body.bags.length, sets: payload.sets?.length || 0 });
    }

    // Admin: upload image
    if (request.method === "POST" && path === "/api/image") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
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

    // ---- IG feed: server-side profile-feed pull ----
    // GET /api/ig-feed?username=...&user_id=...&count=50&max_id=...
    if (request.method === "GET" && path === "/api/ig-feed") {
      const username = url.searchParams.get("username");
      const count = Math.min(parseInt(url.searchParams.get("count") || "50", 10), 100);
      const maxId = url.searchParams.get("max_id") || "";
      const directUserId = url.searchParams.get("user_id") || "";
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);
      try {
        const result = await fetchIgFeed({ username, userId: directUserId, count, maxId });
        return json(result, result.error ? 502 : 200);
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // One-time Llama vision license acceptance. CF Workers AI requires
    // calling the model with prompt='agree' once to accept the EULA before
    // any further inference works.
    if (request.method === "GET" && path === "/api/ig-accept-license") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      try {
        const r = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree", max_tokens: 8 });
        return json({ ok: true, response: r });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // Debug: classify a single IG shortcode through both vision + text models.
    // GET /api/ig-classify?shortcode=...&caption=... (caption optional, admin auth)
    if (request.method === "GET" && path === "/api/ig-classify") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const sc = url.searchParams.get("shortcode");
      const capOverride = url.searchParams.get("caption");
      const userIdQ = url.searchParams.get("user_id") || "47659611317";
      if (!sc) return json({ error: "shortcode required" }, 400);
      try {
        const feed = await fetchIgFeed({ userId: userIdQ, count: 50 });
        const found = (feed.items || []).find(i => i.shortcode === sc);
        const imageUrl = found?.imageUrl || null;
        const caption = capOverride || found?.caption || "";
        const vision = await classifyPostWithVision(env, caption, imageUrl);
        const text = await classifyPostWithAi(env, caption);
        const heuristic = parseCaptionForBag(caption);
        return json({ shortcode: sc, caption, imageUrl, vision, text_only: text, heuristic });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG sync: discover new posts (admin preview) ----
    // GET /api/ig-discover?user_id=...&limit=20  (or username=...)
    // Returns up to `limit` posts whose ig_<shortcode> isn't already in the
    // catalog, each with a suggested name/category/stock from the hybrid
    // vision + text + heuristic classifier. No images downloaded yet.
    if (request.method === "GET" && path === "/api/ig-discover") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const username = url.searchParams.get("username");
      const directUserId = url.searchParams.get("user_id");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);

      try {
        const existingRaw = await env.BAGS.get("data");
        const existing = existingRaw ? JSON.parse(existingRaw) : { bags: [] };
        const existingIds = new Set((existing.bags || []).map(b => b.id));
        // Hide posts already pulled once (even if since deleted) so the widget
        // shows only genuinely-new posts, never re-surfaces what the owner removed.
        const ledgerRaw = await env.BAGS.get("ig_synced_codes");
        const syncedCodes = new Set(ledgerRaw ? JSON.parse(ledgerRaw) : []);

        const feedData = await fetchIgFeed({ username, userId: directUserId, count: 50 });
        if (!feedData.items) return json({ error: feedData.error || "feed empty" }, 502);

        const fresh = feedData.items.filter(it => !existingIds.has(`ig_${it.shortcode}`) && !syncedCodes.has(it.shortcode)).slice(0, limit * 2);
        const classified = await Promise.all(fresh.map(async (it) => {
          const heuristic = looksLikeProduct(it.caption);
          const [vision, text] = await Promise.all([
            classifyPostWithVision(env, it.caption, it.imageUrl),
            classifyPostWithAi(env, it.caption),
          ]);
          const visionOk = vision && !vision._debug;
          const isProduct = heuristic || (visionOk && vision.is_product) || (text && text.is_product);
          if (!isProduct) return null;
          const heuristicSuggestion = parseCaptionForBag(it.caption);

          // Name: text LLM is best at brand shorthand. Strip caption-fragment
          // names like bare "Size" or "Polo" if they slip through.
          const looksLikeFragment = (n) => !n || /^(size|sizes|tn|hh|nb)$/i.test(String(n).trim());
          let name = heuristicSuggestion.name;
          if (text?.is_product && !looksLikeFragment(text.name) && text.name !== "New Item") {
            name = text.name.trim();
          } else if (visionOk && vision.is_product && !looksLikeFragment(vision.name) && vision.name !== "New Item") {
            name = vision.name.trim();
          } else if (visionOk && vision.is_product && vision.name === "New Item") {
            name = "New Item";
          }

          // Category: vision wins (it sees the photo — best at polos vs tshirts
          // vs shirts). Text LLM second. Heuristic last. Coerce through the
          // allowed-categories whitelist so we never publish a phantom filter.
          let category = coerceCategory(heuristicSuggestion.category);
          if (visionOk && vision.is_product && vision.category) {
            const c = coerceCategory(vision.category);
            if (c) category = c;
          } else if (text?.is_product && text.category) {
            const c = coerceCategory(text.category);
            if (c) category = c;
          }
          if (!category) category = "Shirts"; // safest default for menswear if all signals failed

          const reason = visionOk ? vision.reason : (text?.reason || (heuristic ? "matched product heuristic" : ""));
          let classifier = "heuristic";
          if (visionOk && text) classifier = "vision+text";
          else if (visionOk) classifier = "vision";
          else if (text) classifier = "text";

          return {
            ...it,
            suggested: {
              name,
              category,
              stock: heuristicSuggestion.stock,
              price: heuristicSuggestion.price,
              description: heuristicSuggestion.description,
            },
            ai_reason: reason,
            classifier,
          };
        }));
        const candidates = classified.filter(Boolean).slice(0, limit);

        return json({
          count: candidates.length,
          scanned: fresh.length,
          items: candidates,
          profile: feedData.profile,
          ai_enabled: !!env.AI,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG sync: commit approved posts ----
    // POST /api/ig-sync (auth) body: { items: [{ shortcode, name, category, stock, description, imageUrls, takenAt }] }
    // Downloads each item's images directly from IG CDN, uploads to KV, and
    // prepends new-stock bag objects to the catalog. Ryker schema:
    //   { id: 'ig_<shortcode>', name, category, description, price: 0,
    //     stock: { sz: qty, ... }, sales: [], image, images?, createdAt,
    //     instagramUrl }
    if (request.method === "POST" && path === "/api/ig-sync") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ error: "items required" }, 400);

      const existingRaw = await env.BAGS.get("data");
      const data = existingRaw ? JSON.parse(existingRaw) : { bags: [], settings: {} };
      const existingIds = new Set(data.bags.map(b => b.id));
      const existingIgUrls = new Set(data.bags.map(b => b.instagramUrl).filter(Boolean));
      const ledgerRaw = await env.BAGS.get("ig_synced_codes");
      const syncedCodes = new Set(ledgerRaw ? JSON.parse(ledgerRaw) : []);

      const added = [];
      const errors = [];
      const newBags = [];

      for (const it of items) {
        const id = `ig_${it.shortcode}`;
        const igUrl = `https://www.instagram.com/p/${it.shortcode}/`;
        if (existingIds.has(id) || syncedCodes.has(it.shortcode) || existingIgUrls.has(igUrl)) { errors.push({ shortcode: it.shortcode, reason: "already synced" }); continue; }
        const urls = (it.imageUrls || []).slice(0, 4);
        if (!urls.length) { errors.push({ shortcode: it.shortcode, reason: "no images" }); continue; }
        const uploaded = [];
        for (const u of urls) {
          try {
            const r = await fetch(u);
            if (!r.ok) throw new Error(`fetch ${r.status}`);
            const buf = new Uint8Array(await r.arrayBuffer());
            const b64 = arrayToB64(buf);
            const name = `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
            await env.BAGS.put(`img:${name}`, b64);
            await env.BAGS.put(`mime:${name}`, "image/jpeg");
            uploaded.push(`${url.origin}/img/${name}`);
          } catch (e) {
            errors.push({ shortcode: it.shortcode, reason: `image fetch: ${e.message}` });
          }
        }
        if (!uploaded.length) continue;

        // Normalise stock — strip any sizes the admin set to 0 or null, default
        // to { "One Size": 1 } if nothing valid came through.
        let stock = {};
        if (it.stock && typeof it.stock === "object") {
          for (const [k, v] of Object.entries(it.stock)) {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) stock[k] = n;
          }
        }
        if (!Object.keys(stock).length) stock["One Size"] = 1;

        const category = coerceCategory(it.category) || "Shirts";

        const bag = {
          id,
          name: (it.name || "New Item").slice(0, 80),
          category,
          description: it.description || "Premium menswear, hand-selected. Photographed exactly as it is. Pick your size below to enquire.",
          price: Number(it.price) > 0 ? Number(it.price) : 0, // owner-confirmed or caption-parsed
          stock,
          sales: [],
          image: uploaded[0],
          createdAt: it.takenAt || new Date().toISOString(),
          instagramUrl: `https://www.instagram.com/p/${it.shortcode}/`,
        };
        if (uploaded.length > 1) bag.images = uploaded;
        newBags.push(bag);
        added.push({ shortcode: it.shortcode, id });
        existingIds.add(id);
      }

      // Newest first — prepend to the catalog
      data.bags = newBags.concat(data.bags);
      await env.BAGS.put("data", JSON.stringify(data));
      for (const it of items) syncedCodes.add(it.shortcode);
      await env.BAGS.put("ig_synced_codes", JSON.stringify([...syncedCodes]));
      return json({ ok: true, added: added.length, errors, items: added });
    }

    return json({ error: "not found" }, 404);
  },
};
