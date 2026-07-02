// ============================================================
//  GamePrice — Steam vs GOG price comparison  (server · v3)
//  - Multi-currency (base: USD)
//  - Top deals per platform (Summer Sale)
//  - Steam multi-region comparison (top 5 cheapest + Saudi)
//  - In-memory cache (GOG rate-limits aggressively)
//  - Security: headers, rate limiting, input validation
//  - Keep-alive self-ping for free hosting (Render)
// ============================================================

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
//  Security headers
// ------------------------------------------------------------
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' https: data:; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

// ------------------------------------------------------------
//  Simple per-IP rate limiter (60 API requests / minute)
// ------------------------------------------------------------
const hits = new Map();
app.use("/api/", (req, res, next) => {
  const ip = req.ip || "unknown";
  const now = Date.now();
  let e = hits.get(ip);
  if (!e || e.reset < now) {
    e = { count: 0, reset: now + 60_000 };
    hits.set(ip, e);
  }
  if (++e.count > 60) {
    return res.status(429).json({ error: "Too many requests — slow down a little." });
  }
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }
  next();
});

app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "1h",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  })
);

// Health check — used by UptimeRobot / self-ping to keep the app awake
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ------------------------------------------------------------
//  Currencies (display) — Steam returns local prices per cc,
//  GOG always returns USD so we convert with live FX rates.
// ------------------------------------------------------------
const CURRENCIES = {
  USD: { symbol: "$", steamCC: "us", pos: "before" },
  EUR: { symbol: "€", steamCC: "de", pos: "before" },
  GBP: { symbol: "£", steamCC: "gb", pos: "before" },
  SAR: { symbol: "SAR", steamCC: "sa", pos: "after" },
  AED: { symbol: "AED", steamCC: "ae", pos: "after" },
};

// ------------------------------------------------------------
//  Cache + FX rates
// ------------------------------------------------------------
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (e && e.exp > Date.now()) return e.val;
  cache.delete(key);
  return null;
}
function cacheSet(key, val, ttlMs) {
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

// Fallback rates if the FX API is down (SAR/AED are pegged to USD)
const FALLBACK_RATES = {
  USD: 1, EUR: 0.92, GBP: 0.79, SAR: 3.75, AED: 3.6725,
  UAH: 41, RUB: 80, KZT: 520, INR: 86, BRL: 5.5,
  CNY: 7.2, PHP: 58, PLN: 3.9, TRY: 40, ARS: 1200, JPY: 155,
};
let fxCache = null;

async function getRates() {
  if (fxCache && fxCache.exp > Date.now()) return fxCache.rates;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const j = await r.json();
    if (j && j.result === "success" && j.rates) {
      const rates = { ...FALLBACK_RATES, ...j.rates };
      fxCache = { rates, exp: Date.now() + 6 * 3600 * 1000 }; // 6 hours
      return rates;
    }
  } catch (e) {
    /* fall through to fallback */
  }
  return FALLBACK_RATES;
}

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------
function cleanQuery(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 100);
}
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[™®©:\-–—_'’".,!?()]/g, " ")
    .replace(
      /\b(game of the year|goty|complete edition|definitive edition|enhanced edition|deluxe|edition|remastered)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}
function isSameGame(a, b) {
  if (a === b) return true;
  if (a.length > 4 && b.length > 4 && (a.startsWith(b) || b.startsWith(a)))
    return true;
  return false;
}
function pct(base, final) {
  if (base == null || final == null || base <= 0 || final >= base) return 0;
  return Math.round((1 - final / base) * 100);
}

// GOG rate-limits quickly → retry once with a small delay
async function fetchGog(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.ok) return await r.json();
    } catch (e) {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  throw new Error("GOG unavailable");
}

// ------------------------------------------------------------
//  Search
// ------------------------------------------------------------
async function searchSteam(q, cc) {
  const url =
    "https://store.steampowered.com/api/storesearch/?term=" +
    encodeURIComponent(q) +
    "&cc=" + cc + "&l=en";
  const r = await fetch(url);
  const j = await r.json();
  return (j.items || [])
    .filter((i) => i.type === "app")
    .map((i) => {
      let base = null, final = null;
      if (i.price) { base = i.price.initial / 100; final = i.price.final / 100; }
      return {
        id: i.id,
        name: i.name,
        image: i.tiny_image || null,
        base, final,
        url: "https://store.steampowered.com/app/" + i.id,
        norm: normalize(i.name),
      };
    });
}

// GOG is always USD; conversion happens at render time
async function searchGogUSD(q) {
  const url =
    "https://catalog.gog.com/v1/catalog?query=" +
    encodeURIComponent(q) +
    "&countryCode=US&currencyCode=USD&locale=en-US&limit=20";
  const j = await fetchGog(url);
  return (j.products || []).map((i) => {
    let baseUSD = null, finalUSD = null;
    if (i.price && i.price.finalMoney) {
      finalUSD = parseFloat(i.price.finalMoney.amount);
      baseUSD = parseFloat(i.price.baseMoney.amount);
    }
    return {
      name: i.title,
      image: i.coverHorizontal || null,
      baseUSD, finalUSD,
      url: "https://www.gog.com/en/game/" + (i.slug || ""),
      norm: normalize(i.title),
    };
  });
}

function buildRow(name, image, steam, gog, rate) {
  const s = steam
    ? { base: steam.base, final: steam.final, discount: pct(steam.base, steam.final), url: steam.url }
    : null;
  const g = gog
    ? {
        base: gog.baseUSD != null ? gog.baseUSD * rate : null,
        final: gog.finalUSD != null ? gog.finalUSD * rate : null,
        discount: pct(gog.baseUSD, gog.finalUSD),
        url: gog.url,
      }
    : null;

  let cheaper = null, diff = null;
  if (s && g && s.final != null && g.final != null) {
    if (Math.abs(s.final - g.final) < 0.01) cheaper = "same";
    else cheaper = s.final < g.final ? "steam" : "gog";
    diff = Math.abs(s.final - g.final);
  }
  return { name, image, steam: s, gog: g, cheaper, diff };
}

app.get("/api/search", async (req, res) => {
  const q = cleanQuery(req.query.q);
  const cur = (req.query.cur || "USD").toUpperCase();
  const c = CURRENCIES[cur] || CURRENCIES.USD;
  if (!q) return res.json({ results: [] });

  const key = "search:" + cur + ":" + q.toLowerCase();
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const rates = await getRates();
    const rate = rates[cur] || 1;

    const steam = await searchSteam(q, c.steamCC);

    // GOG may fail → keep going with Steam-only results
    let gog = [];
    let gogError = false;
    try { gog = await searchGogUSD(q); }
    catch (e) { gogError = true; }

    const usedGog = new Set();
    const results = [];
    for (const s of steam) {
      let idx = -1;
      for (let i = 0; i < gog.length; i++) {
        if (usedGog.has(i)) continue;
        if (isSameGame(s.norm, gog[i].norm)) { idx = i; break; }
      }
      const g = idx >= 0 ? gog[idx] : null;
      if (idx >= 0) usedGog.add(idx);
      results.push(buildRow(s.name, s.image, s, g, rate));
    }
    gog.forEach((g, i) => {
      if (!usedGog.has(i)) results.push(buildRow(g.name, g.image, null, g, rate));
    });

    results.sort((a, b) => {
      const both = (r) => (r.steam && r.gog ? 1 : 0);
      if (both(a) !== both(b)) return both(b) - both(a);
      return (b.diff || 0) - (a.diff || 0);
    });

    const payload = {
      results, currency: cur, symbol: c.symbol, pos: c.pos,
      converted: cur !== "USD", gogError,
    };
    cacheSet(key, payload, 10 * 60 * 1000); // 10 minutes
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "Something went wrong while fetching prices. Please try again." });
  }
});

// ------------------------------------------------------------
//  Seasonal sale name — rotates automatically, no manual edits
// ------------------------------------------------------------
function saleName() {
  const m = new Date().getMonth(); // 0-11
  if (m >= 5 && m <= 7) return "Summer Sale";
  if (m >= 2 && m <= 4) return "Spring Sale";
  if (m >= 8 && m <= 10) return "Autumn Sale";
  return "Winter Sale";
}

// ------------------------------------------------------------
//  Full Steam deals catalog, filterable by genre (like Steam's
//  own store search). Covers EVERY discounted game, paginated.
// ------------------------------------------------------------
const GENRES = {
  all: null,
  action: 19,
  rpg: 122,
  adventure: 21,
  strategy: 9,
  simulation: 599,
  shooter: 1774,
  horror: 1667,
  racing: 699,
  sports: 701,
  indie: 492,
  casual: 597,
};

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function steamAllDeals(cc, tag, start) {
  const url =
    "https://store.steampowered.com/search/results/?query&start=" + start +
    "&count=48&specials=1&infinite=1&json=1&ndl=1&cc=" + cc + "&l=en" +
    (tag ? "&tags=" + tag : "");
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j = await r.json();
  const html = (j && j.results_html) || "";
  const items = [];
  for (const chunk of html.split('<a href="').slice(1)) {
    const appid = (chunk.match(/data-ds-appid="(\d+)"/) || [])[1];
    const title = (chunk.match(/<span class="title">([^<]+)<\/span>/) || [])[1];
    const finalC = (chunk.match(/data-price-final="(\d+)"/) || [])[1];
    const disc = (chunk.match(/data-discount="(\d+)"/) || [])[1];
    const img = (chunk.match(/<img src="([^"]+)"/) || [])[1];
    if (!appid || !title) continue;
    const discount = disc ? parseInt(disc, 10) : 0;
    if (discount <= 0) continue;
    const final = finalC ? parseInt(finalC, 10) / 100 : null;
    // Steam only exposes the final price in data attributes; derive the base
    const base =
      final != null && discount > 0 && discount < 100
        ? Math.round((final / (1 - discount / 100)) * 100) / 100
        : null;
    items.push({
      name: decodeEntities(title),
      image: img || null,
      discount, base, final,
      url: "https://store.steampowered.com/app/" + appid,
    });
  }
  return { total: (j && j.total_count) || items.length, items };
}

app.get("/api/deals", async (req, res) => {
  const genre = Object.prototype.hasOwnProperty.call(GENRES, req.query.genre)
    ? req.query.genre : "all";
  const start = Math.min(Math.max(parseInt(req.query.start, 10) || 0, 0), 2000);
  const cur = (req.query.cur || "USD").toUpperCase();
  const c = CURRENCIES[cur] || CURRENCIES.USD;

  const key = "deals:" + genre + ":" + start + ":" + cur;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const { total, items } = await steamAllDeals(c.steamCC, GENRES[genre], start);
    const payload = {
      genre, start, total, items,
      currency: cur, symbol: c.symbol, pos: c.pos,
      saleName: saleName(),
    };
    cacheSet(key, payload, 20 * 60 * 1000); // auto-refreshes every 20 min
    res.json(payload);
  } catch (e) {
    res.json({
      genre, start, total: 0, items: [],
      currency: cur, symbol: c.symbol, pos: c.pos, saleName: saleName(),
      error: "Couldn't fetch deals right now — try again in a bit.",
    });
  }
});

// ------------------------------------------------------------
//  Top deals per platform (GOG tab)
// ------------------------------------------------------------
async function steamDiscounts(cc) {
  const url =
    "https://store.steampowered.com/api/featuredcategories?cc=" + cc + "&l=en";
  const r = await fetch(url);
  const j = await r.json();

  // Merge every category that carries discounted items to get a
  // much bigger list than "specials" alone.
  const buckets = [];
  for (const k of Object.keys(j)) {
    const cat = j[k];
    if (cat && Array.isArray(cat.items)) buckets.push(cat.items);
  }
  const seen = new Set();
  const out = [];
  for (const items of buckets) {
    for (const it of items) {
      if (!it || it.id == null || seen.has(it.id)) continue;
      if (!it.discounted || !it.discount_percent) continue;
      seen.add(it.id);
      out.push({
        name: it.name,
        image: it.large_capsule_image || it.header_image || it.small_capsule_image || null,
        discount: it.discount_percent || 0,
        base: it.original_price != null ? it.original_price / 100 : null,
        final: it.final_price != null ? it.final_price / 100 : null,
        url: "https://store.steampowered.com/app/" + it.id,
      });
    }
  }
  return out.sort((a, b) => b.discount - a.discount).slice(0, 48);
}

async function gogDiscounts(rate, page) {
  const url =
    "https://catalog.gog.com/v1/catalog?order=desc:discount&productType=in:game" +
    "&price=discounted:eq:true&countryCode=US&currencyCode=USD&locale=en-US&limit=48" +
    "&page=" + page;
  const j = await fetchGog(url);
  const total = j.productCount || 0;
  const items = (j.products || []).map((p) => {
    const pm = p.price || {};
    let baseUSD = null, finalUSD = null;
    if (pm.finalMoney) {
      finalUSD = parseFloat(pm.finalMoney.amount);
      baseUSD = parseFloat(pm.baseMoney.amount);
    }
    const disc = pm.discount
      ? parseInt(String(pm.discount).replace(/[-%]/g, ""), 10)
      : pct(baseUSD, finalUSD);
    return {
      name: p.title,
      image: p.coverHorizontal || null,
      discount: disc || 0,
      base: baseUSD != null ? baseUSD * rate : null,
      final: finalUSD != null ? finalUSD * rate : null,
      url: "https://www.gog.com/en/game/" + (p.slug || ""),
    };
  });
  return { total, items };
}

app.get("/api/discounts", async (req, res) => {
  const platform = req.query.platform === "gog" ? "gog" : "steam";
  const cur = (req.query.cur || "USD").toUpperCase();
  const c = CURRENCIES[cur] || CURRENCIES.USD;
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 200);

  const key = "disc:" + platform + ":" + cur + ":" + page;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const rates = await getRates();
    const rate = rates[cur] || 1;
    let items = [], total = 0;
    if (platform === "steam") {
      items = await steamDiscounts(c.steamCC);
      total = items.length;
    } else {
      ({ total, items } = await gogDiscounts(rate, page));
    }

    const payload = {
      platform, currency: cur, symbol: c.symbol, pos: c.pos,
      converted: platform === "gog" && cur !== "USD",
      saleName: saleName(), items, total, page,
    };
    cacheSet(key, payload, 20 * 60 * 1000); // 20 minutes
    res.json(payload);
  } catch (e) {
    res.json({
      platform, currency: cur, symbol: c.symbol, items: [], total: 0, page,
      error: "Couldn't fetch deals from this store right now — try again in a bit.",
    });
  }
});

// ------------------------------------------------------------
//  Steam multi-region price comparison
//  Fetches the game's price across popular cheap regions,
//  converts to USD and returns the top 5 cheapest + Saudi Arabia.
// ------------------------------------------------------------
const REGIONS = [
  { cc: "ua", name: "Ukraine", flag: "🇺🇦" },
  { cc: "tr", name: "Turkey", flag: "🇹🇷" },
  { cc: "ar", name: "Argentina", flag: "🇦🇷" },
  { cc: "kz", name: "Kazakhstan", flag: "🇰🇿" },
  { cc: "ru", name: "Russia", flag: "🇷🇺" },
  { cc: "in", name: "India", flag: "🇮🇳" },
  { cc: "br", name: "Brazil", flag: "🇧🇷" },
  { cc: "cn", name: "China", flag: "🇨🇳" },
  { cc: "ph", name: "Philippines", flag: "🇵🇭" },
  { cc: "pl", name: "Poland", flag: "🇵🇱" },
  { cc: "us", name: "United States", flag: "🇺🇸" },
];
const SAUDI = { cc: "sa", name: "Saudi Arabia", flag: "🇸🇦" };

async function regionPrice(appid, region, rates) {
  try {
    const url =
      "https://store.steampowered.com/api/appdetails?appids=" + appid +
      "&cc=" + region.cc + "&filters=price_overview&l=en";
    const r = await fetch(url);
    const j = await r.json();
    const d = j && j[appid];
    if (!d || !d.success || !d.data || !d.data.price_overview) return null;
    const p = d.data.price_overview;
    const amount = p.final / 100;
    const rate = rates[p.currency];
    if (!rate) return null;
    return {
      ...region,
      currency: p.currency,
      local: amount,
      usd: amount / rate,
      discount: p.discount_percent || 0,
    };
  } catch (e) {
    return null;
  }
}

app.get("/api/regions", async (req, res) => {
  const q = cleanQuery(req.query.q);
  if (!q) return res.json({ error: "Type a game name first." });

  const key = "regions:" + q.toLowerCase();
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const rates = await getRates();

    // Find the game on Steam (US catalog) and take the best match
    const matches = await searchSteam(q, "us");
    const game = matches[0];
    if (!game) return res.json({ error: "Couldn't find that game on Steam." });

    const [saudi, ...others] = await Promise.all([
      regionPrice(game.id, SAUDI, rates),
      ...REGIONS.map((rg) => regionPrice(game.id, rg, rates)),
    ]);

    const priced = others.filter(Boolean).sort((a, b) => a.usd - b.usd);
    if (!priced.length && !saudi) {
      return res.json({ error: "No regional prices available for this game (it may be free or unreleased)." });
    }

    const top5 = priced.slice(0, 5);
    const rounded = (r) => ({ ...r, usd: Math.round(r.usd * 100) / 100 });

    const payload = {
      game: { name: game.name, image: game.image, url: game.url },
      saudi: saudi ? rounded(saudi) : null,
      regions: top5.map(rounded),
    };
    cacheSet(key, payload, 60 * 60 * 1000); // 1 hour
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "Something went wrong while comparing regions. Please try again." });
  }
});

// ------------------------------------------------------------
//  Keep-alive: on Render free tier the app sleeps after 15 min
//  without traffic. If we know our public URL, ping /health
//  every 10 minutes so it stays awake. Render sets
//  RENDER_EXTERNAL_URL automatically.
// ------------------------------------------------------------
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL.replace(/\/$/, "") + "/health").catch(() => {});
  }, 10 * 60 * 1000);
  console.log("  ⏰ Keep-alive enabled → pinging " + SELF_URL + "/health every 10 min");
}

app.listen(PORT, () => {
  console.log("\n  ✅ GamePrice is running at:  http://localhost:" + PORT);
  console.log("  (Ctrl+C to stop)\n");
});
