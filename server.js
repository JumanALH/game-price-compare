// ============================================================
//  مقارنة أسعار الألعاب  —  Steam  vs  GOG   (الخادم · v2)
//  - عملات متعددة (الأساسي: دولار)
//  - تبويب أقوى الخصومات لكل منصة
//  - تخزين مؤقت (cache) لأن GOG يحجب بسرعة تحت الضغط
// ============================================================

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// --- العملات المدعومة ---
// steamCC = رمز الدولة اللي يخلّي ستيم يرجّع السعر بهالعملة.
// GOG يرجّع دولار دايم، فنحوّله بسعر الصرف.
const CURRENCIES = {
  USD: { symbol: "$", steamCC: "us", pos: "before" },
  EUR: { symbol: "€", steamCC: "de", pos: "before" },
  GBP: { symbol: "£", steamCC: "gb", pos: "before" },
  SAR: { symbol: "﷼", steamCC: "sa", pos: "after" },
  AED: { symbol: "د.إ", steamCC: "ae", pos: "after" },
};

// ============================================================
//  تخزين مؤقت بسيط + أسعار الصرف
// ============================================================
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

// أسعار احتياطية لو فشل API الصرف (SAR و AED ثابتة مربوطة بالدولار)
const FALLBACK_RATES = { USD: 1, EUR: 0.92, GBP: 0.79, SAR: 3.75, AED: 3.6725 };
let fxCache = null;

async function getRates() {
  if (fxCache && fxCache.exp > Date.now()) return fxCache.rates;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const j = await r.json();
    if (j && j.result === "success" && j.rates) {
      const rates = {};
      for (const c of Object.keys(CURRENCIES))
        rates[c] = j.rates[c] ?? FALLBACK_RATES[c];
      fxCache = { rates, exp: Date.now() + 6 * 3600 * 1000 }; // 6 ساعات
      return rates;
    }
  } catch (e) {
    /* نستخدم الاحتياطي */
  }
  return FALLBACK_RATES;
}

// ============================================================
//  أدوات مساعدة
// ============================================================
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

// GOG يحجب بسرعة → نحاول مرتين مع مهلة صغيرة
async function fetchGog(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.ok) return await r.json();
    } catch (e) {
      /* نعيد المحاولة */
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  throw new Error("GOG unavailable");
}

// ============================================================
//  البحث
// ============================================================
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
        name: i.name,
        image: i.tiny_image || null,
        base, final,
        url: "https://store.steampowered.com/app/" + i.id,
        norm: normalize(i.name),
      };
    });
}

// GOG دايم بالدولار، والتحويل يصير عند العرض
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
  const q = (req.query.q || "").trim();
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

    // GOG قد يفشل → ما نوقف الموقع، نكمّل بنتائج ستيم
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
    cacheSet(key, payload, 10 * 60 * 1000); // 10 دقائق
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "صار خطأ أثناء جلب الأسعار: " + e.message });
  }
});

// ============================================================
//  أقوى الخصومات لكل منصة
// ============================================================
async function steamDiscounts(cc) {
  const url =
    "https://store.steampowered.com/api/featuredcategories?cc=" + cc + "&l=en";
  const r = await fetch(url);
  const j = await r.json();
  const items = (j.specials && j.specials.items) || [];
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push({
      name: it.name,
      image: it.large_capsule_image || it.header_image || null,
      discount: it.discount_percent || 0,
      base: it.original_price != null ? it.original_price / 100 : null,
      final: it.final_price != null ? it.final_price / 100 : null,
      url: "https://store.steampowered.com/app/" + it.id,
    });
  }
  return out.sort((a, b) => b.discount - a.discount);
}

async function gogDiscounts(rate) {
  const url =
    "https://catalog.gog.com/v1/catalog?order=desc:discount&productType=in:game" +
    "&price=discounted:eq:true&countryCode=US&currencyCode=USD&locale=en-US&limit=24";
  const j = await fetchGog(url);
  return (j.products || []).map((p) => {
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
}

app.get("/api/discounts", async (req, res) => {
  const platform = req.query.platform === "gog" ? "gog" : "steam";
  const cur = (req.query.cur || "USD").toUpperCase();
  const c = CURRENCIES[cur] || CURRENCIES.USD;

  const key = "disc:" + platform + ":" + cur;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const rates = await getRates();
    const rate = rates[cur] || 1;
    let items = [];
    if (platform === "steam") items = await steamDiscounts(c.steamCC);
    else items = await gogDiscounts(rate);

    const payload = {
      platform, currency: cur, symbol: c.symbol, pos: c.pos,
      converted: platform === "gog" && cur !== "USD", items,
    };
    cacheSet(key, payload, 20 * 60 * 1000); // 20 دقيقة
    res.json(payload);
  } catch (e) {
    res.json({
      platform, currency: cur, symbol: c.symbol, items: [],
      error: "تعذّر جلب الخصومات من هذي المنصة حاليًا (جرّبي بعد شوي).",
    });
  }
});

app.listen(PORT, () => {
  console.log("\n  ✅ الموقع شغّال على:  http://localhost:" + PORT);
  console.log("  (Ctrl+C للإيقاف)\n");
});
