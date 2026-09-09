"use strict";

const $ = (id) => document.getElementById(id);
const curSel = $("cur");
const statusEl = $("status");
const contentEl = $("content");
const searchArea = $("searchArea");
const searchInput = $("q");
const chips = $("chips");
const heroTitle = $("heroTitle");
const heroSub = $("heroSub");

let mode = "search";
let deals = { genre: "all", start: 0, total: 0, items: [], sym: "$", pos: "before", saleName: "Sale" };
let gogSt = { genre: "all", page: 1, total: 0, items: [], sym: "$", pos: "before", saleName: "Sale", converted: false };
let favIndex = {};

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const safeUrl = (u) => /^https:\/\//.test(String(u || "")) ? esc(u) : "#";

const icon = (name, cls) =>
  '<svg class="ico ' + (cls || "") + '" aria-hidden="true"><use href="#i-' + name + '" /></svg>';

/* decimal places for the active currency — JPY has none */
let curDec = 2;
const money = (n, sym, pos) =>
  n == null ? "—" : pos === "after" ? n.toFixed(curDec) + " " + sym : sym + n.toFixed(curDec);

const priceHTML = (n, sym, pos, cls) =>
  '<span class="' + cls + ' num">' + money(n, sym, pos) + "</span>";

/* swap the content area in with an animation */
function paint(html) {
  contentEl.innerHTML = html;
  contentEl.classList.remove("swap");
  void contentEl.offsetWidth; // force reflow so the animation restarts
  contentEl.classList.add("swap");
  staggerGenres();
}

function stagger(nodes, step) {
  nodes.forEach((el, i) => el.style.setProperty("--d", (i * (step || 0.03)).toFixed(3) + "s"));
}
function staggerGenres() {
  stagger([...contentEl.querySelectorAll(".genre")], 0.025);
}

/* ---------- theme ---------- */
const themeBtn = $("themeBtn");
let theme;
try { theme = localStorage.getItem("gp:theme"); } catch (e) {}
if (!theme) theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "dark" ? "🌙" : "☀️";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0a0c18" : "#e7e4f7");
  try { localStorage.setItem("gp:theme", theme); } catch (e) {}
}
themeBtn.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  applyTheme();
});
applyTheme();

/* ---------- favorites ---------- */
function loadFavs() {
  try { return JSON.parse(localStorage.getItem("gp:favs")) || []; }
  catch (e) { return []; }
}
function saveFavs(list) {
  try { localStorage.setItem("gp:favs", JSON.stringify(list.slice(0, 100))); } catch (e) {}
  favIndex = {};
  for (const f of list) favIndex[f.name.toLowerCase()] = true;
}
saveFavs(loadFavs());

const isFav = (name) => !!favIndex[String(name).toLowerCase()];

function toggleFav(item) {
  const list = loadFavs();
  const k = item.name.toLowerCase();
  const i = list.findIndex((f) => f.name.toLowerCase() === k);
  if (i >= 0) list.splice(i, 1);
  else list.unshift({
    name: item.name, image: item.image || null, url: item.url || null,
    price: item.price || null, at: Date.now(),
  });
  saveFavs(list);
  return i < 0;
}

function favBtnHTML(name, cls) {
  const on = isFav(name);
  return '<button class="fav-btn ' + (cls || "") + (on ? " on" : "") + '"' +
    ' data-fav="' + esc(name) + '"' +
    ' aria-label="' + (on ? "Remove from" : "Add to") + ' favorites"' +
    ' aria-pressed="' + on + '">' + icon("heart", "ico-sm") + "</button>";
}

/* ---------- item registry (favoriting works from any view) ---------- */
const itemReg = {};
function regItem(name, image, url, price) {
  itemReg[String(name).toLowerCase()] = { name, image, url, price };
}

/* ---------- scroll reveal ---------- */
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { e.target.classList.add("shown"); io.unobserve(e.target); }
  }
}, { threshold: 0.08 });

function observeReveals() {
  contentEl.querySelectorAll(".reveal").forEach((el, i) => {
    if (el.getBoundingClientRect().bottom < 0) { el.classList.add("shown"); return; }
    el.style.setProperty("--d", (Math.min(i % 6, 5) * 0.05) + "s");
    io.observe(el);
  });
}

/* ---------- status / loading ---------- */
function noteHTML(text, kind) {
  return '<span class="note ' + (kind === "warn" ? "warn" : "") + '">' +
    icon(kind === "warn" ? "alert" : "info", "ico-sm") + "<span>" + text + "</span></span>";
}

function setBusy(msg, kind) {
  statusEl.textContent = msg;
  const n = kind === "grid" ? 8 : 3;
  const cls = kind === "grid" ? "tall" : "row";
  contentEl.innerHTML =
    '<div class="skeletons ' + (kind === "grid" ? "grid3" : "") + '">' +
    Array.from({ length: n }, () => '<div class="sk ' + cls + '"></div>').join("") +
    "</div>";
}
function clearAll() { contentEl.innerHTML = ""; statusEl.textContent = ""; }

const NET_ERROR = "Couldn't reach the server. Make sure it's running.";

/* ---------- compare view ---------- */
function storeHTML(kind, data, sym, pos, isWinner) {
  const label = kind === "steam" ? "Steam" : "GOG";
  const head = '<div class="store-head">' + icon(kind === "steam" ? "flame" : "tag", "ico-sm") + label + "</div>";

  if (!data) {
    return '<div class="store ' + kind + '-col">' + head +
      '<div class="na">Not available</div></div>';
  }

  const old = data.base && data.discount > 0 ? priceHTML(data.base, sym, pos, "price-old") : "";
  const off = data.discount > 0 ? '<div class="badge-off num">-' + data.discount + "%</div>" : "";
  const win = isWinner ? '<span class="tag-win">' + icon("check", "ico-sm") + "Cheapest</span>" : "";

  return '<div class="store ' + kind + "-col" + (isWinner ? " win" : "") + '">' + win + head +
    "<div>" + priceHTML(data.final, sym, pos, "price-now") + old + "</div>" + off +
    '<div><a class="store-link" href="' + safeUrl(data.url) + '" target="_blank" rel="noopener noreferrer">' +
    "Open store page" + icon("out", "ico-sm") + "</a></div></div>";
}

function verdictHTML(row, sym, pos) {
  if (!row.steam || !row.gog) {
    return '<div class="verdict same">Available on<small>' +
      (row.steam ? "Steam only" : "GOG only") + "</small></div>";
  }
  if (!row.cheaper) return '<div class="verdict same">Free / no price</div>';
  if (row.cheaper === "same") return '<div class="verdict same">Same price<small>on both stores</small></div>';
  const who = row.cheaper === "steam" ? "Steam" : "GOG";
  return '<div class="verdict ' + row.cheaper + '">' + who + " is cheaper" +
    '<small>You save ' + money(row.diff, sym, pos) + "</small></div>";
}

function renderSearch(data) {
  const rows = data.results || [];
  if (!rows.length) { statusEl.textContent = "No results found for that game."; return; }

  let notes = "";
  if (data.gogError) notes += noteHTML("GOG prices are unavailable right now — showing Steam only. Try again shortly.", "warn");
  if (data.converted) notes += noteHTML("GOG prices are converted from USD at the current exchange rate.");
  statusEl.innerHTML = notes;

  const sym = data.symbol, pos = data.pos;
  const html = rows.map((row) => {
    const best = row.steam && row.steam.final != null ? row.steam : row.gog;
    regItem(row.name, row.image, (row.steam || row.gog || {}).url,
      best && best.final != null ? money(best.final, sym, pos) : null);

    const img = row.image
      ? '<img class="card-art" src="' + safeUrl(row.image) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()" />'
      : "";

    return '<article class="card reveal">' +
      '<div class="card-top">' + img +
      '<h2 class="card-title">' + esc(row.name) + "</h2>" +
      verdictHTML(row, sym, pos) + favBtnHTML(row.name) +
      "</div>" +
      '<div class="prices">' +
      storeHTML("steam", row.steam, sym, pos, row.cheaper === "steam") +
      '<div class="divider"></div>' +
      storeHTML("gog", row.gog, sym, pos, row.cheaper === "gog") +
      "</div></article>";
  }).join("");

  paint('<div class="results">' + html + "</div>");
  observeReveals();
}

/* ---------- deals ---------- */
function dealCardHTML(it, sym, pos) {
  regItem(it.name, it.image, it.url, money(it.final, sym, pos));
  const img = it.image
    ? '<div class="imgbox"><img src="' + safeUrl(it.image) + '" alt="" loading="lazy" decoding="async" onerror="this.parentNode.remove()" /></div>'
    : "";
  const old = it.base ? priceHTML(it.base, sym, pos, "pold") : "";
  return '<article class="deal reveal">' +
    favBtnHTML(it.name, "float") +
    '<span class="corner num">-' + (it.discount || 0) + "%</span>" + img +
    '<div class="body">' +
    '<h3 class="dname">' + esc(it.name) + "</h3>" +
    '<div class="row">' + priceHTML(it.final, sym, pos, "pnow") + old + "</div>" +
    '<a class="store-link" href="' + safeUrl(it.url) + '" target="_blank" rel="noopener noreferrer">' +
    "Open store page" + icon("out", "ico-sm") + "</a>" +
    "</div></article>";
}

function saleBannerHTML(name, subtitle) {
  return '<div class="sale-banner reveal">' +
    "<h2>" + icon("spark") + esc(name) + "</h2>" +
    "<p>" + subtitle + "</p></div>";
}

const GENRE_LABELS = {
  all: "All", action: "Action", rpg: "RPG", adventure: "Adventure",
  strategy: "Strategy", simulation: "Simulation", shooter: "Shooter",
  horror: "Horror", racing: "Racing", sports: "Sports", indie: "Indie", casual: "Casual",
};
const GOG_GENRE_LABELS = {
  all: "All", action: "Action", adventure: "Adventure", rpg: "RPG",
  strategy: "Strategy", simulation: "Simulation", shooter: "Shooter",
  horror: "Horror", racing: "Racing", sports: "Sports", puzzle: "Puzzle", platformer: "Platformer",
};

function genrePillsHTML(labels, active) {
  return '<div class="genres" role="tablist" aria-label="Game genres">' +
    Object.keys(labels).map((g) =>
      '<button class="genre' + (active === g ? " active" : "") + '" data-genre="' + g + '"' +
      ' role="tab" aria-selected="' + (active === g) + '">' + labels[g] + "</button>"
    ).join("") + "</div>";
}

function loadMoreHTML(shown, total) {
  if (shown >= total) return "";
  return '<div class="load-more-wrap"><button class="load-more">' +
    icon("down", "ico-sm") + "Load more (" + (total - shown).toLocaleString("en-US") + " left)</button></div>";
}

function renderSteamDeals() {
  paint(
    saleBannerHTML(deals.saleName, deals.total.toLocaleString("en-US") + " discounted games on Steam · updates automatically") +
    genrePillsHTML(GENRE_LABELS, deals.genre) +
    '<div class="grid">' + deals.items.map((it) => dealCardHTML(it, deals.sym, deals.pos)).join("") + "</div>" +
    loadMoreHTML(deals.items.length, deals.total)
  );
  observeReveals();
}

function renderGogDeals() {
  if (!gogSt.items.length) {
    statusEl.textContent = "No deals in this genre right now.";
    paint(genrePillsHTML(GOG_GENRE_LABELS, gogSt.genre));
    return;
  }
  statusEl.innerHTML = gogSt.converted
    ? noteHTML("Prices converted from USD at the current exchange rate.") : "";
  paint(
    saleBannerHTML(gogSt.saleName, gogSt.total.toLocaleString("en-US") + " discounted games on GOG · updates automatically") +
    genrePillsHTML(GOG_GENRE_LABELS, gogSt.genre) +
    '<div class="grid">' + gogSt.items.map((it) => dealCardHTML(it, gogSt.sym, gogSt.pos)).join("") + "</div>" +
    loadMoreHTML(gogSt.items.length, gogSt.total)
  );
  observeReveals();
}

/* ---------- favorites view ---------- */
function renderFavs() {
  const list = loadFavs();
  statusEl.innerHTML = "";

  if (!list.length) {
    paint('<div class="empty">' + icon("heart") +
      "<h3>No favorites yet</h3>" +
      "<p>Tap the heart on any game to save it here. No account needed — your list stays on this device.</p></div>");
    return;
  }

  const rows = list.map((f) => {
    regItem(f.name, f.image, f.url, f.price);
    const img = f.image
      ? '<img src="' + safeUrl(f.image) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()" />' : "";
    const meta = (f.price ? f.price + " when saved · " : "") +
      new Date(f.at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return '<div class="fav-row reveal">' + img +
      "<div><div class='fname'>" + esc(f.name) + "</div>" +
      '<div class="fmeta">' + esc(meta) + "</div></div>" +
      '<div class="factions">' +
      '<button class="fbtn cmp" data-cmp="' + esc(f.name) + '">' + icon("compare", "ico-sm") + "Compare now</button>" +
      '<button class="fbtn rm" data-rm="' + esc(f.name) + '">' + icon("trash", "ico-sm") + "Remove</button>" +
      "</div></div>";
  }).join("");

  paint('<div class="results">' + rows + "</div>" +
    '<div class="note-block">' + noteHTML("Saved locally in your browser — no sign-up, no tracking.") + "</div>");
  observeReveals();
}

/* ---------- regions view ---------- */
function regionRowHTML(r, rankLabel, extraClass) {
  return '<div class="region-row reveal ' + extraClass + '">' +
    '<span class="rank">' + rankLabel + "</span>" +
    '<span class="flag" aria-hidden="true">' + r.flag + "</span>" +
    "<div><div class='rn'>" + esc(r.name) + "</div>" +
    '<div class="local num">' + r.local.toFixed(2) + " " + esc(r.currency) +
    (r.discount ? " · -" + r.discount + "% off" : "") + "</div></div>" +
    '<div class="right"><div class="usd num">≈ $' + r.usd.toFixed(2) + "</div></div>" +
    "</div>";
}

function renderRegions(data) {
  if (data.error) { statusEl.textContent = data.error; contentEl.innerHTML = ""; return; }
  statusEl.textContent = "";

  const g = data.game;
  const hero = '<div class="region-hero reveal">' +
    (g.image ? '<img src="' + safeUrl(g.image) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()" />' : "") +
    '<div><div class="rname">' + esc(g.name) + "</div>" +
    '<a class="store-link" href="' + safeUrl(g.url) + '" target="_blank" rel="noopener noreferrer">' +
    "View on Steam" + icon("out", "ico-sm") + "</a></div></div>";

  const rows = (data.regions || [])
    .map((r, i) => regionRowHTML(r, String(i + 1), i === 0 ? "r1" : i === 1 ? "r2" : i === 2 ? "r3" : ""))
    .join("");
  const saudi = data.saudi ? regionRowHTML(data.saudi, icon("home", "ico-sm"), "saudi") : "";

  paint(hero + '<div class="region-list">' + rows + saudi + "</div>" +
    '<div class="note-block">' +
    noteHTML("Top 5 cheapest Steam regions, converted to USD. Prices are estimates and buying cross-region may require a matching payment method.") +
    "</div>");
  observeReveals();
}

/* ---------- requests ---------- */
async function doSearch(term) {
  const q = (term != null ? term : searchInput.value).trim();
  if (!q) return;
  searchInput.value = q;
  syncClearBtn();
  if (mode === "regions") return loadRegions(q);

  setBusy("Fetching live prices…", "list");
  try {
    const r = await fetch("/api/search?q=" + encodeURIComponent(q) + "&cur=" + curSel.value);
    const data = await r.json();
    clearAll();
    if (data.error) { statusEl.textContent = data.error; return; }
    curDec = data.decimals ?? 2;
    renderSearch(data);
  } catch (e) { clearAll(); statusEl.textContent = NET_ERROR; }
}

async function loadSteamDeals(reset, silent) {
  if (reset) { deals.start = 0; deals.items = []; }
  if (!silent) setBusy("Loading " + GENRE_LABELS[deals.genre] + " deals…", "grid");
  try {
    const r = await fetch("/api/deals?genre=" + deals.genre + "&start=" + deals.start + "&cur=" + curSel.value);
    const data = await r.json();
    if (mode !== "steam") return;
    clearAll();
    if (data.error && !data.items.length) { statusEl.textContent = data.error; return; }
    deals.total = data.total;
    deals.items = deals.items.concat(data.items);
    deals.sym = data.symbol; deals.pos = data.pos; deals.saleName = data.saleName;
    curDec = data.decimals ?? 2;
    renderSteamDeals();
  } catch (e) { if (!silent) { clearAll(); statusEl.textContent = NET_ERROR; } }
}

async function loadGogDeals(reset, silent) {
  if (reset) { gogSt.page = 1; gogSt.items = []; }
  if (!silent) setBusy("Loading GOG deals…", "grid");
  try {
    const r = await fetch("/api/discounts?platform=gog&genre=" + gogSt.genre + "&page=" + gogSt.page + "&cur=" + curSel.value);
    const data = await r.json();
    if (mode !== "gog") return;
    clearAll();
    if (data.error && !(data.items || []).length && !gogSt.items.length) { statusEl.textContent = data.error; return; }
    gogSt.total = data.total || 0;
    gogSt.items = gogSt.items.concat(data.items || []);
    gogSt.sym = data.symbol; gogSt.pos = data.pos;
    gogSt.saleName = data.saleName; gogSt.converted = data.converted;
    curDec = data.decimals ?? 2;
    renderGogDeals();
  } catch (e) { if (!silent) { clearAll(); statusEl.textContent = NET_ERROR; } }
}

async function loadRegions(q) {
  setBusy("Comparing prices across regions…", "list");
  try {
    const r = await fetch("/api/regions?q=" + encodeURIComponent(q));
    const data = await r.json();
    clearAll();
    renderRegions(data);
  } catch (e) { clearAll(); statusEl.textContent = NET_ERROR; }
}

/* ---------- modes ---------- */
const HERO = {
  search: {
    title: "Compare game prices across Steam &amp; GOG",
    sub: "Live prices pulled the moment you search — see which store is cheaper and exactly how much you save.",
    hint: "Type a game name to compare Steam vs GOG.",
    placeholder: "Search any game… e.g. Elden Ring",
  },
  steam: {
    title: "Steam deals, straight from the store",
    sub: "Every discounted game on Steam right now, filterable by genre and refreshed automatically.",
  },
  gog: {
    title: "GOG deals, DRM-free",
    sub: "The full GOG discount catalogue, filterable by genre and refreshed automatically.",
  },
  regions: {
    title: "Find the cheapest Steam region",
    sub: "Compare a game's Steam price across regions and see the top 5 cheapest, converted to USD.",
    hint: "Type a game to see the top 5 cheapest Steam regions.",
    placeholder: "Find the cheapest region… e.g. Cyberpunk 2077",
  },
  favs: {
    title: "Your saved games",
    sub: "Everything you've hearted, stored privately on this device.",
  },
};

function switchMode(m) {
  mode = m;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.mode === m;
    t.classList.toggle("active", on);
    t.setAttribute("aria-current", on ? "page" : "false");
  });

  const cfg = HERO[m];
  heroTitle.innerHTML = cfg.title;
  heroSub.textContent = cfg.sub;

  const showSearch = m === "search" || m === "regions";
  searchArea.style.display = showSearch ? "flex" : "none";
  chips.style.display = showSearch ? "flex" : "none";
  clearAll();

  if (showSearch) {
    searchInput.placeholder = cfg.placeholder;
    statusEl.textContent = cfg.hint;
    const q = searchInput.value.trim();
    if (m === "regions" && q) loadRegions(q);
  } else if (m === "favs") {
    renderFavs();
  } else if (m === "steam") {
    loadSteamDeals(true);
  } else {
    loadGogDeals(true);
  }
}

/* ---------- events ---------- */
function syncClearBtn() {
  searchArea.classList.toggle("has-value", searchInput.value.trim().length > 0);
}

$("go").addEventListener("click", () => doSearch());
searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
searchInput.addEventListener("input", syncClearBtn);
$("clearBtn").addEventListener("click", () => {
  searchInput.value = "";
  syncClearBtn();
  searchInput.focus();
  clearAll();
  statusEl.textContent = HERO[mode].hint || "";
});

chips.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) doSearch(chip.textContent);
});

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchMode(t.dataset.mode)));

curSel.addEventListener("change", () => {
  const q = searchInput.value.trim();
  if (mode === "search" && q) doSearch(q);
  else if (mode === "regions" && q) loadRegions(q);
  else if (mode === "steam") loadSteamDeals(true);
  else if (mode === "gog") loadGogDeals(true);
});

/* delegated: favorites, genres, load more, favorite row actions */
contentEl.addEventListener("click", (e) => {
  const fav = e.target.closest(".fav-btn");
  if (fav) {
    const name = fav.dataset.fav;
    const on = toggleFav(itemReg[name.toLowerCase()] || { name });
    fav.classList.toggle("on", on);
    fav.setAttribute("aria-pressed", on);
    fav.setAttribute("aria-label", (on ? "Remove from" : "Add to") + " favorites");
    fav.classList.remove("pop");
    void fav.offsetWidth;
    fav.classList.add("pop");
    return;
  }

  const genre = e.target.closest(".genre");
  if (genre) {
    if (mode === "gog") { gogSt.genre = genre.dataset.genre; loadGogDeals(true); }
    else { deals.genre = genre.dataset.genre; loadSteamDeals(true); }
    return;
  }

  const more = e.target.closest(".load-more");
  if (more) {
    more.disabled = true;
    more.textContent = "Loading…";
    if (mode === "gog") { gogSt.page += 1; loadGogDeals(false, true); }
    else { deals.start += 48; loadSteamDeals(false, true); }
    return;
  }

  const cmp = e.target.closest("[data-cmp]");
  if (cmp) { switchMode("search"); doSearch(cmp.dataset.cmp); return; }

  const rm = e.target.closest("[data-rm]");
  if (rm) { toggleFav({ name: rm.dataset.rm }); renderFavs(); return; }
});

/* deals refresh themselves */
setInterval(() => {
  if (mode === "steam") loadSteamDeals(true, true);
  else if (mode === "gog") loadGogDeals(true, true);
}, 20 * 60 * 1000);

stagger([...chips.querySelectorAll(".chip")], 0.025);
statusEl.textContent = HERO.search.hint;
