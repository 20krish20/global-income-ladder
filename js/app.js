/* Global Income Ladder
 *
 * Data comes from generated files:
 *   data/countries.js  window.GIL_DATA     each country's income distribution, plus the World Bank's
 *                                         same-year estimate for it (scripts/update_data.py)
 *   data/rates.js      window.GIL_RATES    exchange rates, local currency per US dollar (scripts/update_rates.py)
 *   data/history.js    window.GIL_HISTORY  every earlier comparable survey; loaded only when a country is opened
 *   data/map.js        window.GIL_MAP      country shapes, already projected (scripts/build_map.py)
 *   js/i18n.js         window.GIL_I18N     translations, keyed by the English text
 *
 * Every country carries a curve: the share of people living below a list of income levels,
 * in international (price-adjusted) dollars per day. Everything on the page is cut from that curve.
 * To show money instead of price-adjusted dollars, an amount is turned into international dollars with
 *   local currency today = international dollars x ppp x infl      (price level, then inflation since)
 *   US dollars today     = local currency today / exchange rate
 *
 * The page has three modes, picked from the address: the full page, ?embed=IND (one country's card,
 * for other websites' iframes) and ?present=IND,BDI (full-screen slides for a classroom).
 */
(function () {
  "use strict";

  var DATA = window.GIL_DATA;
  if (!DATA || !DATA.countries || !DATA.countries.length) {
    document.body.insertAdjacentHTML("afterbegin",
      '<p style="padding:24px;font:16px system-ui">The data file is missing. Run <code>python3 scripts/update_data.py</code> in the project folder, then reload.</p>');
    return;
  }
  var META = DATA.meta || {};
  var SURVEYS = DATA.countries;
  var RATES = { date: (window.GIL_RATES || {}).date || "", rates: Object.assign({ USD: 1 }, (window.GIL_RATES || {}).rates || {}) };
  var LIVE_RATE_URLS = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json"
  ];
  var I18N = window.GIL_I18N || {};
  var LANGS = [["en", "English"], ["hi", "हिन्दी"], ["es", "Español"], ["fr", "Français"], ["pt", "Português"]];
  var LOCALES = { en: "en-US", hi: "hi-IN", es: "es", fr: "fr", pt: "pt-BR" };
  var AUTO_LANG = false;   // follow the reader's browser language once native speakers have checked the translations
  // The World Bank's extreme poverty line: international dollars a day at 2021 prices.
  var POVERTY_LINE = META.pppYear === 2021 ? 3 : null;
  var EST_YEAR = META.estimateYear || null;

  var UNITS = {
    day: { mult: 1, per: "a day", word: "day" },
    month: { mult: 365 / 12, per: "a month", word: "month" },
    year: { mult: 365, per: "a year", word: "year" }
  };
  // Where the eight income brackets are cut, in dollars, for each way of counting time.
  var EDGES = {
    day: [1, 2, 5, 10, 20, 50, 100],
    month: [30, 60, 150, 300, 600, 1500, 3000],
    year: [360, 720, 1800, 3600, 7200, 18000, 36000]
  };
  var CONTINENTS = ["Africa", "Asia", "Europe", "North America", "South America", "Oceania", "Other"];
  var DECILES = ["Poorest 10%", "2nd tenth", "3rd tenth", "4th tenth", "5th tenth", "6th tenth", "7th tenth", "8th tenth", "9th tenth", "Richest 10%"];
  // Shape of the curve beyond the first and last known points.
  var LOW_TAIL = 2, TOP_TAIL = 2.5;
  // The light palette from styles.css, for share images (always light). Keep in step with :root.
  var CARD = {
    bg: "#ffffff", ink: "#111827", muted: "#6b7280", rule: "#e5e7eb",
    b: ["#7f1d1d", "#b91c1c", "#ef4444", "#f59e0b", "#6b7280", "#9ca3af", "#c3c8d0", "#dde0e5"],
    on: ["#ffffff", "#ffffff", "#111827", "#111827", "#ffffff", "#111827", "#111827", "#111827"]
  };

  /* --------------------------------------------------------------- data -- */
  SURVEYS.forEach(function (d) { d.k = "country"; });
  // A same-year estimate is the survey's record with the estimated curve swapped in. Where the
  // World Bank only grew the latest survey (most countries), its split by tenths still holds.
  var ESTIMATES = SURVEYS.filter(function (d) { return d.e; }).map(function (d) {
    var e = d.e, sameShape = e.t === "extrapolated" || e.t === "survey";
    return Object.assign({}, d, { y: e.y, sy: d.y, x: e.x, F: e.F, med: e.med, avg: e.avg, p: e.p, est: e.t,
      ds: sameShape ? d.ds : null, gini: sameShape ? d.gini : null });
  });
  var estBy = {};
  ESTIMATES.forEach(function (d) { estBy[d.c] = d; });
  // Economies with an estimate but no survey on the site: they count toward the world figure only.
  var OTHERS = (DATA.others || []).map(function (o) { return Object.assign({ k: "other" }, o); });
  var otherBy = {};
  OTHERS.forEach(function (o) { otherBy[o.c] = o; });
  var WORLD = { c: "WLD", n: "World", k: "world", g: "World", y: EST_YEAR };
  var biggest = SURVEYS.reduce(function (a, b) { return (b.p || 0) > (a.p || 0) ? b : a; });

  var params = new URLSearchParams(location.search);
  var MODE = params.get("embed") ? "embed" : params.get("present") ? "present" : "page";
  var state = { unit: "day", money: "usd", data: "survey", local: false, sel: biggest.c, cmp: "", q: "", region: "all",
    sort: "name", view: "bars", t1: false, t2: false, lang: "en", tab: "countries" };
  var TABS = ["countries", "stand", "map", "guide"];
  if (TABS.indexOf(location.hash.slice(1)) !== -1) state.tab = location.hash.slice(1);
  var LIST, byCode, memo = {};
  function useData(mode) {
    state.data = mode === "est" && ESTIMATES.length ? "est" : "survey";
    LIST = state.data === "est" ? ESTIMATES : SURVEYS;
    byCode = {};
    LIST.forEach(function (d) { byCode[d.c] = d; });
    if (state.data === "est") byCode.WLD = WORLD;
    memo = {};
  }

  function load(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } }
  function isLang(l) { return LANGS.some(function (x) { return x[0] === l; }); }
  (function restore() {
    var s = load("gil:view") || {};
    if (UNITS[s.unit]) state.unit = s.unit;
    if (s.money === "usd" || s.money === "ppp") state.money = s.money;
    if (s.data === "est") state.data = "est";
    if (s.sel) state.sel = s.sel;
    if (typeof s.cmp === "string") state.cmp = s.cmp;
    state.local = !!s.local;
    var l = load("gil:lang");
    if (isLang(l)) state.lang = l;
    else if (AUTO_LANG) {
      var nav = (navigator.language || "en").slice(0, 2);
      if (isLang(nav)) state.lang = nav;
    }
    // A link's settings win over what was remembered.
    var p = function (k) { return params.get(k); };
    if (UNITS[p("u")]) state.unit = p("u");
    if (p("m") === "usd" || p("m") === "ppp") state.money = p("m");
    if (p("d") === "est" || p("d") === "survey") state.data = p("d");
    var c = p("c") || p("embed");
    if (c) state.sel = c.toUpperCase();
    if (p("cmp") != null) state.cmp = p("cmp").toUpperCase();
    if (isLang(p("lang"))) state.lang = p("lang");
  })();
  useData(state.data);
  if (!byCode[state.sel]) state.sel = biggest.c;
  if (state.cmp && !byCode[state.cmp]) state.cmp = "";

  function pageUrl(q) {
    var base = /^https?:$/.test(location.protocol) ? location.origin + location.pathname : location.href.split(/[?#]/)[0];
    var s = new URLSearchParams();
    Object.keys(q).forEach(function (k) { if (q[k] != null && q[k] !== "") s.set(k, q[k]); });
    var qs = s.toString();
    return base + (qs ? "?" + qs : "");
  }
  // The settings worth carrying in a link, beyond the defaults.
  function linkState(extra) {
    return Object.assign({
      d: state.data === "est" ? "est" : null, m: state.money !== "usd" ? state.money : null,
      u: state.unit !== "day" ? state.unit : null, lang: state.lang !== "en" ? state.lang : null
    }, extra || {});
  }
  function remember() {
    save("gil:view", { unit: state.unit, money: state.money, data: state.data, sel: state.sel, cmp: state.cmp, local: state.local });
    if (MODE !== "page") return;
    var hash = state.tab !== "countries" ? "#" + state.tab : "";
    try { history.replaceState(null, "", pageUrl(linkState({ c: state.sel, cmp: state.cmp || null })) + hash); } catch (e) { /* not allowed here */ }
  }

  /* ------------------------------------------------------------ helpers -- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(text, cls, onClick) {
    var b = el("button", cls || "link-btn", text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function U() { return UNITS[state.unit]; }
  function per() { return t(U().per); }
  // Flags load lazily from flags/; the one-file build supplies them inline as window.GIL_FLAGS.
  var FLAGS = window.GIL_FLAGS || null;
  function flagSrc(d) { return FLAGS ? FLAGS[d.c] || "" : "flags/" + d.c.toLowerCase() + ".svg"; }
  function flag(d) {
    if (d.k !== "country") return el("span", "flag none");
    var img = el("img", "flag");
    img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    img.onerror = function () { img.replaceWith(el("span", "flag none")); };
    img.src = flagSrc(d);
    return img;
  }

  /* ------------------------------------------------------- translation -- */
  function t(s, vars) {
    var dict = I18N[state.lang], out = (dict && dict[s]) || s;
    return vars ? out.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : out;
  }
  // The same, but a value may be a DOM node, to make part of a sentence bold.
  function tNode(s, vars) {
    var frag = document.createDocumentFragment();
    t(s).split(/(\{\w+\})/).forEach(function (part) {
      var m = /^\{(\w+)\}$/.exec(part), v = m ? vars[m[1]] : part;
      if (v == null || v === "") return;
      frag.appendChild(typeof v === "object" ? v : document.createTextNode(String(v)));
    });
    return frag;
  }
  function loc() { return LOCALES[state.lang] || "en-US"; }
  // Fixed text in the page: the English is kept on first use, so switching back works.
  function applyStatic() {
    document.documentElement.lang = state.lang;
    document.title = t("Global Income Ladder");
    document.querySelectorAll("[data-i18n]").forEach(function (n) {
      if (n.dataset.i18nKey == null) n.dataset.i18nKey = n.textContent.trim();
      n.textContent = t(n.dataset.i18nKey);
    });
    document.querySelectorAll("[data-i18n-attr]").forEach(function (n) {
      n.dataset.i18nAttr.split(",").forEach(function (a) {
        var keep = "data-i18n-o-" + a;
        if (!n.hasAttribute(keep)) n.setAttribute(keep, n.getAttribute(a) || "");
        n.setAttribute(a, t(n.getAttribute(keep)));
      });
    });
  }

  /* -------------------------------------------------------------- money -- */
  // Units of the display currency per international dollar.
  function factor(d, ctx) {
    if (ctx === "ppp") return 1;
    if (!d.cur || !d.ppp || !d.infl) return null;
    var local = d.ppp * d.infl;
    if (ctx === "local") return local;
    var rate = RATES.rates[d.cur];
    return rate ? local / rate : null;
  }
  function hasMoney(d) { return d.k === "world" || factor(d, "usd") != null; }
  function canLocal(d) {
    return d.k === "country" && factor(d, "local") != null && !!RATES.rates[d.cur] && !(d.cur === "USD" && state.money === "usd");
  }
  function curOf(d, ctx) { return ctx === "local" ? d.cur : "USD"; }

  var symbols = {};
  function symbol(cur) {
    if (symbols[cur]) return symbols[cur];
    var s = cur;
    try {
      var pick = function (display) {
        var parts = new Intl.NumberFormat("en", { style: "currency", currency: cur, currencyDisplay: display }).formatToParts(1);
        for (var i = 0; i < parts.length; i++) if (parts[i].type === "currency") return parts[i].value;
        return cur;
      };
      s = pick("narrowSymbol");
      if (s === "$" && cur !== "USD") s = pick("symbol");   // tell other dollars and pesos apart
    } catch (e) { s = cur; }
    if (/[A-Za-zÀ-ɏЀ-ӿ.]$/.test(s)) s += " ";
    return (symbols[cur] = s);
  }
  function currencyName(cur) {
    try {
      var name = new Intl.DisplayNames([loc()], { type: "currency" }).of(cur);
      if (name && name !== cur) return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) { /* older browsers */ }
    return cur;
  }
  var fmts = {};
  function fmt(key, opts) {
    var k = state.lang + key;
    if (!(k in fmts)) { try { fmts[k] = new Intl.NumberFormat(loc(), opts); } catch (e) { fmts[k] = null; } }
    return fmts[k];
  }
  function fixed(x, n) {
    var f = fmt("f" + n, { minimumFractionDigits: n, maximumFractionDigits: n });
    return f ? f.format(x) : x.toFixed(n);
  }
  function compactNum(x, long) {
    var f = fmt(long ? "cl" : "cs", { notation: "compact", compactDisplay: long ? "long" : "short", maximumSignificantDigits: 3 });
    return f ? f.format(x) : String(Math.round(x));
  }
  function num(x, isAmount) {
    var a = Math.abs(x);
    if (a >= 1e6) return compactNum(x, false);
    if (isAmount) return a < 100 ? fixed(x, 2) : Math.round(x).toLocaleString(loc());
    return (+x.toPrecision(6)).toLocaleString(loc(), { maximumFractionDigits: 2 });
  }
  // perDay: an amount in the display currency, per person per day.
  function money(perDay, cur) {
    if (perDay == null || !isFinite(perDay)) return "–";
    return symbol(cur) + num(perDay * U().mult, true);
  }
  function edgeLabel(v, cur) { return symbol(cur) + num(v, false); }
  function bracketLabel(i, e, cur) {
    if (i === 0) return t("Under {x}", { x: edgeLabel(e[0], cur) });
    if (i === 7) return t("Over {x}", { x: edgeLabel(e[6], cur) });
    return edgeLabel(e[i - 1], cur) + "–" + num(e[i], false);
  }
  function percent(v, digits) {
    var f = fmt("p" + digits, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits });
    return f ? f.format(v / 100) : v.toFixed(digits) + "%";
  }
  function pct(v) {
    if (v == null) return "–";
    if (v <= 0) return percent(0, 0);
    if (v < 0.05) return "<" + percent(0.1, 1);
    return percent(v, 1);
  }
  function pctWhole(v) { return percent(Math.round(v), 0); }
  function people(n) {
    if (n == null) return "";
    return n >= 1e4 ? compactNum(n, false) : Math.round(n).toLocaleString(loc());
  }
  function peopleLong(n) { return n >= 1e6 ? compactNum(n, true) : Math.round(n).toLocaleString(loc()); }
  function niceDate(iso) {
    var d = new Date(iso + "T00:00:00Z");
    if (isNaN(d)) return iso || t("an unknown date");
    return d.toLocaleDateString(loc(), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  var regionNames = {};
  function nameOf(d) {
    if (d.k === "world") return t("World");
    if (state.lang === "en" || !d.c2) return d.n;
    if (!(state.lang in regionNames)) {
      try { regionNames[state.lang] = new Intl.DisplayNames([loc()], { type: "region" }); } catch (e) { regionNames[state.lang] = null; }
    }
    var dn = regionNames[state.lang], s = dn && dn.of(d.c2);
    return s && s !== d.c2 ? s : d.n;
  }
  // The country's name as it reads inside a sentence ("in the Philippines").
  function placeName(d) {
    if (d.k === "world") return t("the world");
    if (state.lang !== "en") return nameOf(d);
    return /Republic|Islands|^(United|Netherlands|Philippines|Gambia|Maldives|Bahamas|Comoros|Seychelles)/.test(d.n) ? "the " + d.n : d.n;
  }

  /* ------------------------------------------------------- distribution -- */
  // Share of a country's people (0 to 1) living below x international dollars a day.
  function cdf(d, x) {
    var X = d.x, F = d.F, n = X.length;
    if (!(x > 0)) return 0;
    if (x <= X[0]) return F[0] * Math.pow(x / X[0], LOW_TAIL);
    if (x >= X[n - 1]) return 1 - (1 - F[n - 1]) * Math.pow(X[n - 1] / x, TOP_TAIL);
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (X[mid] <= x) lo = mid; else hi = mid;
    }
    var t = Math.log(x / X[lo]) / Math.log(X[hi] / X[lo]);
    return F[lo] + t * (F[hi] - F[lo]);
  }

  // The world: every same-year estimate added up, weighted by population. In today's dollars
  // only economies with a dependable conversion count; in price-adjusted dollars, all of them.
  function worldMembers(ctx) {
    var key = "m|" + ctx;
    if (!memo[key]) memo[key] = ESTIMATES.concat(OTHERS).filter(function (c) { return c.p && factor(c, ctx) != null; });
    return memo[key];
  }
  function worldBelow(amount, ctx) {
    var key = "b|" + ctx + "|" + amount;
    if (key in memo) return memo[key];
    var top = 0, bottom = 0;
    worldMembers(ctx).forEach(function (c) {
      top += c.p * cdf(c, amount / factor(c, ctx));
      bottom += c.p;
    });
    return (memo[key] = bottom ? top / bottom : null);
  }
  function worldStats(ctx) {
    var key = "s|" + ctx;
    if (memo[key]) return memo[key];
    var pop = 0, total = 0, n = 0;
    worldMembers(ctx).forEach(function (c) {
      pop += c.p; n++;
      if (c.avg != null) total += c.p * c.avg * factor(c, ctx);
    });
    var lo = Math.log(0.01), hi = Math.log(1e5);
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (worldBelow(Math.exp(mid), ctx) < 0.5) lo = mid; else hi = mid;
    }
    var all = ESTIMATES.concat(OTHERS).length;
    return (memo[key] = { med: Math.exp((lo + hi) / 2), avg: pop ? total / pop : null, pop: pop, n: n, left: all - n });
  }
  function worldCtx(ctx) { return ctx === "local" ? "usd" : ctx; }
  function below(d, amount, ctx) {
    if (d.k === "world") return worldBelow(amount, worldCtx(ctx));
    var f = factor(d, ctx);
    return f == null ? null : cdf(d, amount / f);
  }
  function median(d, ctx) {
    if (d.k === "world") return worldStats(worldCtx(ctx)).med;
    var f = factor(d, ctx);
    return f == null ? null : d.med * f;
  }
  function average(d, ctx) {
    if (d.k === "world") return worldStats(worldCtx(ctx)).avg;
    var f = factor(d, ctx);
    return f == null || d.avg == null ? null : d.avg * f;
  }
  function population(d, ctx) { return d.k === "world" ? worldStats(worldCtx(ctx || state.money)).pop : d.p; }
  // Share of people (0 to 1) below the World Bank's extreme poverty line, which is set in price-adjusted dollars.
  function povertyShare(d) {
    if (!POVERTY_LINE) return null;
    return d.k === "world" ? worldBelow(POVERTY_LINE, "ppp") : cdf(d, POVERTY_LINE);
  }

  /* ----------------------------------------------------------- brackets -- */
  function nice125(v) {
    var e = Math.floor(Math.log10(v)), best = v, gap = Infinity;
    for (var k = e - 1; k <= e + 1; k++) {
      [1, 2, 5].forEach(function (m) {
        var c = m * Math.pow(10, k), g = Math.abs(Math.log(c / v));
        if (g < gap) { gap = g; best = c; }
      });
    }
    return +best.toPrecision(1);
  }
  function ladder(start, n) {
    var e = Math.floor(Math.log10(start) + 1e-9), steps = [1, 2, 5];
    var i = steps.indexOf(Math.round(start / Math.pow(10, e)));
    if (i < 0) i = 0;
    var out = [];
    for (var k = 0; k < n; k++) {
      out.push(+(steps[i] * Math.pow(10, e)).toPrecision(1));
      if (++i === 3) { i = 0; e++; }
    }
    return out;
  }
  // Seven cut points in the display currency, per the current unit of time.
  function edgesFor(d, ctx) {
    if (ctx !== "local") return EDGES[state.unit];
    return ladder(nice125(EDGES[state.unit][0] * RATES.rates[d.cur]), 7);
  }
  // Eight percentages: the share of people in each bracket.
  function shares(d, ctx, e) {
    var mult = U().mult, prev = 0, out = [];
    for (var k = 0; k < e.length; k++) {
      var F = below(d, e[k] / mult, ctx);
      if (F == null) return null;
      out.push(Math.max(0, (F - prev) * 100));
      prev = Math.max(prev, F);
    }
    out.push(Math.max(0, (1 - prev) * 100));
    return out;
  }
  // Another country (or the world) measured against the selected country's cut points.
  function sharesAgainst(c, d, ctx, e) {
    if (ctx !== "local") return shares(c, ctx, e);
    var rate = RATES.rates[d.cur];
    return shares(c, "usd", e.map(function (v) { return v / rate; }));
  }
  function sheetCtx(d) {
    if (state.local && canLocal(d)) return "local";
    if (state.money === "usd" && !hasMoney(d)) return "ppp";
    return state.money;
  }
  // Which of the eight brackets an amount a day (in US or price-adjusted dollars) falls in.
  function bracketOf(perDay) {
    for (var k = 0; k < 7; k++) if (perDay < EDGES.day[k]) return k;
    return 7;
  }

  /* -------------------------------------------------------- stacked bar -- */
  function stack(target, sh, labelMin) {
    target.textContent = "";
    (sh || []).forEach(function (v, i) {
      if (v < 0.5) return;
      var seg = el("i", "seg s" + (i + 1));
      seg.style.setProperty("--v", v.toFixed(3));
      seg.dataset.i = i;
      if (v >= labelMin) seg.appendChild(el("b", null, pctWhole(v)));
      target.appendChild(seg);
    });
  }
  // A stacked bar with a "You" mark at a share (0 to 1) of the way from poorest to richest.
  function markedBar(sh, at) {
    var wrap = el("div", "marked");
    var bar = el("span", "stack");
    stack(bar, sh, 6);
    wrap.appendChild(bar);
    var m = el("span", "you");
    m.style.left = (Math.min(1, Math.max(0, at)) * 100) + "%";
    m.appendChild(el("b", null, t("You")));
    wrap.appendChild(m);
    return wrap;
  }
  function keyList(e, cur, cls) {
    var ol = el("ol", cls || "key");
    for (var i = 0; i < 8; i++) {
      var li = el("li");
      li.appendChild(el("span", "sw s" + (i + 1)));
      li.appendChild(el("span", "k-l", bracketLabel(i, e, cur)));
      ol.appendChild(li);
    }
    return ol;
  }

  /* ----------------------------------------------------------- headline -- */
  // One plain sentence for each country, so nobody has to add percentages up.
  // Poorer places: the lowest line that at least 7 in 10 people live under.
  // Richer places (most people above the fifth line): the highest line at least 7 in 10 live above.
  function headline(d, ctx, cur, e, sh) {
    var cum = [], run = 0, i;
    for (var k = 0; k < 7; k++) { run += sh[k] / 100; cum.push(run); }
    var rich = cum[4] < 0.5, at = -1;
    if (rich) { for (i = 6; i >= 0; i--) if (1 - cum[i] >= 0.7) { at = i; break; } }
    else { for (i = 0; i < 7; i++) if (cum[i] >= 0.7) { at = i; break; } }
    var mid = 7;
    for (i = 0; i < 7; i++) if (cum[i] >= 0.5) { mid = i; break; }
    var med = median(d, ctx), place = placeName(d);
    var half = t("Half of {place} lives on less than {amount} {per}.", { place: place, amount: money(med, cur), per: per() });
    if (at < 0) return { main: half, sub: [], mid: mid, share: null };
    var f = rich ? 1 - cum[at] : cum[at];
    var v = { place: place, p: percent(Math.floor(f * 100), 0), amount: edgeLabel(e[at], cur), per: per(), n: Math.round(f * 10) };
    var key = f >= 0.95 ? "almost" : f >= 0.73 && f < 0.775 ? "3in4" : "nin10";
    var main = t({
      "almost|less": "Almost everyone in {place} ({p}) lives on less than {amount} {per}.",
      "almost|more": "Almost everyone in {place} ({p}) lives on more than {amount} {per}.",
      "3in4|less": "3 in 4 people in {place} ({p}) live on less than {amount} {per}.",
      "3in4|more": "3 in 4 people in {place} ({p}) live on more than {amount} {per}.",
      "nin10|less": "{n} in 10 people in {place} ({p}) live on less than {amount} {per}.",
      "nin10|more": "{n} in 10 people in {place} ({p}) live on more than {amount} {per}."
    }[key + "|" + (rich ? "more" : "less")], v);
    var sub = [], pop = population(d, ctx);
    if (pop) sub.push(t("That's {n} people.", { n: peopleLong(pop * f) }));
    if (med != null) sub.push(half);
    return { main: main, sub: sub, mid: mid, share: f };
  }
  function renderSay(d, ctx, cur, e, sh) {
    var box = $("say");
    box.hidden = !sh;
    if (!sh) return;
    var h = headline(d, ctx, cur, e, sh);
    box.style.setProperty("--say", "var(--b" + (h.mid + 1) + ")");
    $("sayMain").textContent = h.main;
    $("saySub").textContent = h.sub.concat([t("Shown in {unit}.", { unit: unitWords(ctx, d) })]).join(" ");
  }

  /* ------------------------------------------------------------- header -- */
  function moneyWords(ctx) { return ctx === "usd" ? t("today's US dollars") : t("price-adjusted dollars"); }
  function unitWords(ctx, d) { return ctx === "local" ? currencyName(d.cur) : moneyWords(ctx); }
  function renderHero() {
    var ctx = state.money, e = EDGES[state.unit];
    $("eyebrow").textContent = t("Household surveys from {n} countries, compiled by the World Bank", { n: SURVEYS.length });
    $("heroWorld").textContent = state.data === "est"
      ? t("In {year}, half the world lived on less than {amount} {per}, by the World Bank's estimate.", { year: EST_YEAR, amount: money(worldStats(ctx).med, "USD"), per: per() })
      : "";
    $("worldCap").textContent = t("Income per person {per}, in {unit}", { per: per(), unit: moneyWords(ctx) });
    var key = $("key");
    key.replaceWith(Object.assign(keyList(e, "USD"), { id: "key" }));
    renderHowto(ctx, e);
    $("fxNote").textContent = ctx === "usd"
      ? t("Exchange rates from {date}. Survey incomes are brought to {year} prices first.", { date: niceDate(RATES.date), year: META.priceYear || "" })
      : t("International dollars at {year} prices: $1 buys what it bought in the United States in {year}.", { year: META.pppYear });
    $("dataCtl").hidden = $("dataLabel").hidden = !ESTIMATES.length;
    $("dataEst").textContent = t("{year} estimate", { year: EST_YEAR });
    pressed("[data-unit]", "unit", state.unit);
    pressed("[data-money]", "money", state.money);
    pressed("[data-data]", "data", state.data);
  }
  function pressed(sel, key, value) {
    document.querySelectorAll(sel).forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset[key] === value)); });
  }

  // "How to read this page": one country's bar, what each colour means, and two real countries side by side.
  function renderHowto(ctx, e) {
    var name = $("howName"), first = byCode[biggest.c] || biggest;
    name.textContent = "";
    name.appendChild(flag(first));
    name.appendChild(document.createTextNode(nameOf(first)));
    stack($("howBar"), shares(first, ctx, e), 101);
    $("howRed").textContent = t("Under {x}", { x: edgeLabel(e[2], "USD") }) + " " + per();
    $("howAmber").textContent = t("{a} to {b}", { a: edgeLabel(e[2], "USD"), b: num(e[3], false) });
    $("howGrey").textContent = t("Over {x}", { x: edgeLabel(e[3], "USD") });
    var big = LIST.filter(function (d) { return d.k === "country" && d.p > 3e7 && median(d, ctx) != null; });
    big.sort(function (a, b) { return median(a, ctx) - median(b, ctx); });
    var box = $("howPair");
    box.textContent = "";
    if (big.length < 2) return;
    [big[0], big[big.length - 1]].forEach(function (d) {
      var row = el("span", "howto-row"), nm = el("span", "howto-name");
      nm.appendChild(flag(d));
      nm.appendChild(document.createTextNode(nameOf(d)));
      var bar = el("span", "stack");
      stack(bar, shares(d, ctx, e), 101);
      row.appendChild(nm);
      row.appendChild(bar);
      box.appendChild(row);
    });
  }

  function renderNotes() {
    var box = $("notes");
    box.textContent = "";
    box.appendChild(el("h2", null, t("How to read the numbers")));
    function note(head, body) {
      var p = el("p");
      p.appendChild(el("b", null, head));
      p.appendChild(document.createTextNode(" "));
      p.appendChild(typeof body === "string" ? document.createTextNode(body) : body);
      box.appendChild(p);
    }
    function link(text, href) {
      var a = el("a", null, text);
      a.href = href; a.target = "_blank"; a.rel = "noopener";
      return a;
    }
    var years = SURVEYS.map(function (d) { return d.y; });
    note(t("Today's US dollars."), t("Each survey's incomes are first brought to this year's prices using the country's own inflation, then converted at the current exchange rate. This is the money people would actually hold, in dollars."));
    note(t("Local currency."), t("The same amounts before the exchange-rate step, in the currency people are paid in. Open a country and use the switch in its panel."));
    note(t("Price-adjusted dollars."), t("A dollar buys far more in some countries than others. This view corrects for that, so the same number means roughly the same standard of living everywhere. Amounts are in international dollars at {year} prices.", { year: META.pppYear }));
    note(t("Re-priced, not re-surveyed."), t("Each row shows the year people were surveyed. Amounts are updated for prices and exchange rates, but not for pay rises or growth since that survey."));
    if (ESTIMATES.length) {
      note(t("{year} estimates.", { year: EST_YEAR }), t("The World Bank moves each country's surveys to {year} using its economic growth since, so every country can be compared in the same year. These are estimates, not surveys.", { year: EST_YEAR }));
    }
    note(t("World figures."), t("Countries ran their latest surveys in different years, from {oldest} to {newest}, so surveys are never added up into one world number. World figures appear only with the {year} estimates, where every country has been moved to the same year.", { oldest: Math.min.apply(null, years), newest: Math.max.apply(null, years), year: EST_YEAR }));
    if (POVERTY_LINE) note(t("Extreme poverty line."), t("The World Bank counts people living on less than $3.00 a day, in price-adjusted dollars at 2021 prices, as living in extreme poverty."));
    note(t("Income is per person."), t("A household's total is divided by everyone in it, children included. A family of four on $40 a day counts as four people on $10 a day."));
    note(t("Some surveys measure income, others spending."), t("Richer countries mostly report income; most others report what households consume. Spending-based figures tend to look more equal, so compare across the two with care."));
    var src = document.createDocumentFragment();
    src.appendChild(link(t("World Bank Poverty and Inequality Platform"), "https://pip.worldbank.org/"));
    src.appendChild(document.createTextNode(", " + t("edition {release}, fetched {date}.", { release: META.release || "", date: niceDate(META.generated) }) + " " +
      t("Inflation: {source}.", { source: META.inflationSource || "IMF" }) + " " + t("Exchange rates:") + " "));
    src.appendChild(link(t("open currency API"), "https://github.com/fawazahmed0/exchange-api"));
    src.appendChild(document.createTextNode(", " + niceDate(RATES.date) + ". " + t("Flags:") + " "));
    src.appendChild(link("flag-icons", "https://github.com/lipis/flag-icons"));
    src.appendChild(document.createTextNode(". " + t("Map:") + " "));
    src.appendChild(link("Natural Earth", "https://www.naturalearthdata.com/"));
    src.appendChild(document.createTextNode("."));
    note(t("Sources."), src);
    var teach = el("p");
    teach.appendChild(el("b", null, t("For teachers.")));
    teach.appendChild(document.createTextNode(" "));
    teach.appendChild(link(t("A lesson plan and classroom slides"), "teach.html"));
    teach.lastChild.target = "_self";
    box.appendChild(teach);
  }

  /* ------------------------------------------------------------ selects -- */
  function byName(a, b) { return nameOf(a).localeCompare(nameOf(b), loc()); }
  function fillCountrySelect(sel, withNone, noWorld) {
    var keep = sel.value;
    sel.textContent = "";
    if (withNone) sel.appendChild(new Option(t("Nothing"), ""));
    if (!noWorld && byCode.WLD) sel.appendChild(new Option(t("World") + " (" + t("{year} estimate", { year: EST_YEAR }) + ")", "WLD"));
    CONTINENTS.forEach(function (g) {
      var members = LIST.filter(function (d) { return d.g === g; }).sort(byName);
      if (!members.length) return;
      var og = document.createElement("optgroup");
      og.label = t(g);
      members.forEach(function (d) { og.appendChild(new Option(nameOf(d), d.c)); });
      sel.appendChild(og);
    });
    if (keep) sel.value = keep;
  }

  var ledger = { e: EDGES.day, sh: {} };   // brackets for every row, recomputed on each render
  function nullsLast(get, dir) {
    return function (a, b) {
      var x = get(a), y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return dir * (x - y);
    };
  }
  function shareOf(d, from, to) {
    var s = ledger.sh[d.c];
    if (!s) return null;
    var tot = 0;
    for (var i = from; i < to; i++) tot += s[i];
    return tot;
  }
  function surveyYear(d) { return d.sy || d.y; }
  var SORTS = [
    ["name", function () { return t("Name, A to Z"); }, byName],
    ["medHigh", function () { return t("Median income, highest first"); }, nullsLast(function (d) { return median(d, state.money); }, -1)],
    ["medLow", function () { return t("Median income, lowest first"); }, nullsLast(function (d) { return median(d, state.money); }, 1)],
    ["poverty", function () { return t("Most people in extreme poverty"); }, nullsLast(povertyShare, -1)],
    ["under1", function () { return t("Most people under {x}", { x: edgeLabel(EDGES[state.unit][0], "USD") }) + " " + per(); }, nullsLast(function (d) { return shareOf(d, 0, 1); }, -1)],
    ["under4", function () { return t("Most people under {x}", { x: edgeLabel(EDGES[state.unit][3], "USD") }) + " " + per(); }, nullsLast(function (d) { return shareOf(d, 0, 4); }, -1)],
    ["over7", function () { return t("Most people over {x}", { x: edgeLabel(EDGES[state.unit][6], "USD") }) + " " + per(); }, nullsLast(function (d) { return shareOf(d, 7, 8); }, -1)],
    ["pop", function () { return t("Population, largest first"); }, function (a, b) { return (b.p || 0) - (a.p || 0); }],
    ["year", function () { return t("Newest survey first"); }, function (a, b) { return surveyYear(b) - surveyYear(a); }]
  ];
  if (!POVERTY_LINE) SORTS.splice(3, 1);
  function fillSort() {
    var sel = $("sort");
    sel.textContent = "";
    SORTS.forEach(function (s) { sel.appendChild(new Option(s[1](), s[0])); });
    sel.value = state.sort;
  }

  /* -------------------------------------------------------------- sheet -- */
  function comparison(d) { return state.cmp && state.cmp !== d.c ? byCode[state.cmp] : null; }
  function metaLine(d, ctx) {
    if (d.k === "world") {
      var ws = worldStats(worldCtx(ctx));
      return t("{n} countries and territories added up, all estimated for {year}", { n: ws.n, year: EST_YEAR });
    }
    var parts = [d.est ? t("{year} estimate, from the {sy} survey", { year: d.y, sy: d.sy }) : t("{year} survey", { year: d.y }),
      d.w === "income" ? t("measured by income") : t("measured by household spending")];
    if (d.u) parts.push(t("urban areas only"));
    return parts.join(" · ");
  }

  function renderSheet() {
    var d = byCode[state.sel], c = comparison(d), ctx = sheetCtx(d), cur = curOf(d, ctx);
    $("pick").value = d.c;
    $("cmp").value = state.cmp;
    var h2 = $("sheetName");
    h2.textContent = "";
    if (d.k === "country") h2.appendChild(flag(d));
    h2.appendChild(document.createTextNode(nameOf(d)));
    $("sheetMeta").textContent = metaLine(d, ctx);

    var prices = $("sheetPrices"), fUsd = d.k === "country" ? factor(d, "usd") : null;
    prices.hidden = !(fUsd && META.usInflation && d.c !== "USA");
    if (!prices.hidden) {
      var reach = META.usInflation / fUsd;   // what $1 spent here buys, counted in US prices
      prices.textContent = reach > 1.05 ? t("Prices are lower here: $1 buys about what {amount} buys in the United States.", { amount: symbol("USD") + fixed(reach, 2) })
        : reach < 0.95 ? t("Prices are higher here: $1 buys about what {amount} buys in the United States.", { amount: symbol("USD") + fixed(reach, 2) })
        : t("Prices here are close to those in the United States.");
    }

    // currency switch
    var box = $("sheetCur"), showSwitch = canLocal(d);
    box.hidden = !showSwitch;
    if (showSwitch) {
      $("cur-global").textContent = state.money === "usd" ? t("US dollars") : t("Price-adjusted dollars");
      $("cur-local").textContent = currencyName(d.cur) + " (" + symbol(d.cur).trim() + ")";
      $("cur-global").setAttribute("aria-pressed", String(ctx !== "local"));
      $("cur-local").setAttribute("aria-pressed", String(ctx === "local"));
    }

    var notes = [];
    if (d.k === "world" && worldStats(worldCtx(ctx)).left > 0) {
      notes.push(t("In today's US dollars, {n} economies without a dependable exchange rate are left out. Switch to price-adjusted dollars to count everyone.", { n: worldStats(worldCtx(ctx)).left }));
    }
    if (d.k === "country" && state.money === "usd" && !hasMoney(d)) {
      notes.push(t("There is no dependable exchange rate or inflation record for {country}, so its figures stay in price-adjusted dollars.", { country: nameOf(d) }));
    }
    if (d.est === "extrapolated") notes.push(t("This is an estimate: the World Bank carried the {sy} survey forward to {year} using economic growth since.", { sy: d.sy, year: d.y }));
    else if (d.est === "interpolated") notes.push(t("This is an estimate: the World Bank worked it out from the surveys before and after {year}.", { year: d.y }));
    else if (d.est === "modelled") notes.push(t("This is an estimate modelled by the World Bank."));
    var oldYear = d.est ? d.sy : d.y;
    if (d.k === "country" && oldYear < (META.priceYear || 2026) - 10) {
      notes.push(d.est ? t("It rests on a survey from {year}, so treat it with care.", { year: oldYear })
        : t("The newest survey is from {year}. Incomes there have likely changed a lot since.", { year: oldYear }));
    }
    var cav = $("caveat");
    cav.hidden = !notes.length;
    cav.textContent = notes.join(" ");

    var tiles = $("tiles");
    tiles.textContent = "";
    function tile(label, value, unit, note) {
      var tl = el("div", "tile");
      tl.appendChild(el("dt", null, label));
      var dd = el("dd", null, value);
      if (unit) { dd.appendChild(document.createTextNode(" ")); dd.appendChild(el("small", null, unit)); }
      tl.appendChild(dd);
      if (note) tl.appendChild(el("span", "t-note", note));
      tiles.appendChild(tl);
    }
    var e = edgesFor(d, ctx), sh = shares(d, ctx, e);
    renderSay(d, ctx, cur, e, sh);
    tile(t("Median income"), money(median(d, ctx), cur), per(), t("Half the people live on less"));
    var pov = povertyShare(d);
    if (pov != null) {
      var fl = d.k === "country" ? factor(d, ctx) : null, here = "";
      if (fl != null && ctx !== "ppp") here = " " + t("(about {amount} a day here, in today's money)", { amount: symbol(cur) + num(POVERTY_LINE * fl, true) });
      tile(t("In extreme poverty"), pct(pov * 100), "", t("Below the World Bank line of $3.00 a day, price-adjusted") + here);
    }
    tile(t("Average income"), money(average(d, ctx), cur), per(), t("If all income were shared equally"));
    var pop = population(d, ctx);
    if (pop) tile(t("Population"), peopleLong(pop), "", d.k === "world" ? t("people covered") : t("people in {year}", { year: d.y }));

    renderFig1(d, c, ctx, cur, e, sh);
    renderSplit(d);
    renderHist(d, ctx, cur, e);
    renderFig2(d, c, ctx, cur);
  }

  function chartAxis(chart, n, labelFn) {
    var row = el("div", "crow axis"), ax = el("span", "c-axis");
    for (var k = 0; k <= n; k++) {
      var tk = el("i", null, labelFn(k));
      tk.style.left = (k / n * 100) + "%";
      ax.appendChild(tk);
    }
    row.appendChild(ax);
    chart.appendChild(row);
  }
  // Legend entries: [kind ("bar", "ramp", "tick", "line"), label]
  function legend(box, items) {
    box.textContent = "";
    box.hidden = !items.length;
    items.forEach(function (it) {
      var s = el("span");
      s.appendChild(el("i", it[0] === "tick" ? "lg-tick" : it[0] === "line" ? "lg-line" : "lg-bar" + (it[0] === "ramp" ? " ramp" : "")));
      s.appendChild(document.createTextNode(it[1]));
      box.appendChild(s);
    });
  }

  // The income brackets as rungs of a ladder, richest at the top. A run of two or more rungs at
  // either end holding under 1% of this country's people folds into one, so the eye goes to where
  // the people are. A comparison's mark on a folded rung shows its combined share.
  function rungs(sh, csh, e, cur) {
    function tiny(i) { return sh[i] < 1; }
    function sum(arr, a, b) { if (!arr) return null; var tot = 0; for (var i = a; i <= b; i++) tot += arr[i]; return tot; }
    var lo = 0, hi = 7, out = [];
    while (lo < 7 && tiny(lo)) lo++;
    while (hi > lo && tiny(hi)) hi--;
    if (lo < 2) lo = 0;
    if (hi > 5) hi = 7;
    if (lo > 0) out.push({ color: lo, v: sum(sh, 0, lo - 1), cv: sum(csh, 0, lo - 1), label: t("Under {x}", { x: edgeLabel(e[lo - 1], cur) }) });
    for (var i = lo; i <= hi; i++) out.push({ color: i + 1, v: sh[i], cv: csh ? csh[i] : null, label: bracketLabel(i, e, cur) });
    if (hi < 7) out.push({ color: hi + 2, v: sum(sh, hi + 1, 7), cv: sum(csh, hi + 1, 7), label: t("Over {x}", { x: edgeLabel(e[hi], cur) }) });
    return out.reverse();
  }

  var fig1 = null;   // what the first chart is showing, for its tooltip
  function renderFig1(d, c, ctx, cur, e, sh) {
    var csh = c ? sharesAgainst(c, d, ctx, e) : null, list = rungs(sh, csh, e, cur);
    fig1 = { d: d, c: csh ? c : null, rungs: list, cur: cur, ctx: ctx };
    $("fig1Sub").textContent = t("Richest at the top, poorest at the bottom. Income per person {per}, in {unit}", { per: per(), unit: unitWords(ctx, d) });
    legend($("fig1Legend"), csh ? [["ramp", nameOf(d)], ["tick", nameOf(c)]] : []);
    var note = $("fig1Note");
    note.hidden = !(c && !csh);
    if (c && !csh) note.textContent = t("{country} has no dependable exchange rate, so it can't be marked in this currency. Switch to price-adjusted dollars to compare.", { country: nameOf(c) });

    var max = Math.max.apply(null, list.map(function (r) { return Math.max(r.v, r.cv || 0); }));
    var step = max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : 20;
    var dom = Math.min(100, Math.ceil(max / step) * step) || step;
    var n = Math.round(dom / step);
    var pop = population(d, ctx);

    var chart = $("fig1Chart");
    chart.textContent = "";
    chart.style.setProperty("--n", n);
    list.forEach(function (r, i) {
      var row = el("div", "crow");
      row.dataset.i = i;
      row.appendChild(el("span", "c-label", r.label));
      var track = el("span", "c-track");
      if (r.v > 0) { var bar = el("i", "c-bar s" + r.color); bar.style.width = (r.v / dom * 100) + "%"; track.appendChild(bar); }
      if (csh) { var tk = el("i", "c-tick"); tk.style.left = (Math.min(r.cv, dom) / dom * 100) + "%"; track.appendChild(tk); }
      row.appendChild(track);
      var val = el("span", "c-val");
      val.appendChild(el("b", null, pct(r.v)));
      if (pop && r.v > 0) val.appendChild(el("small", null, t("{n} people", { n: people(pop * r.v / 100) })));
      row.appendChild(val);
      chart.appendChild(row);
    });
    chartAxis(chart, n, function (k) { return percent(k * step, 0); });

    var wrap = $("fig1Table");
    wrap.textContent = "";
    var tbl = el("table"), thead = el("thead"), hr = el("tr");
    [t("Income {per}", { per: per() }), nameOf(d), t("People")].concat(csh ? [nameOf(c)] : []).forEach(function (h) { hr.appendChild(el("th", null, h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = el("tbody");
    sh.forEach(function (v, i) {
      var tr = el("tr");
      tb.insertBefore(tr, tb.firstChild);   // richest first, as in the chart
      tr.appendChild(el("th", null, bracketLabel(i, e, cur)));
      tr.appendChild(el("td", null, pct(v)));
      tr.appendChild(el("td", null, pop ? people(pop * v / 100) : "–"));
      if (csh) tr.appendChild(el("td", null, pct(csh[i])));
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    applyToggle(1);
  }

  // Who gets the income: the poorest half, the middle 40% and the richest 10%, as shares of
  // people and of income. Straight from the survey's split by tenths.
  function renderSplit(d) {
    var fig = $("figSplit");
    fig.hidden = !d.ds;
    if (!d.ds) return;
    var ds = d.ds, sum = function (a, b) { var s = 0; for (var i = a; i <= b; i++) s += ds[i]; return s; };
    var groups = [[t("Poorest half"), 50, sum(0, 4), 2], [t("Middle 40%"), 40, sum(5, 8), 4], [t("Richest 10%"), 10, ds[9], 6]];
    $("splitSub").textContent = t("Everyone split into three groups: the poorest half, the middle 40% and the richest 10%");
    $("splitSay").textContent = t("The richest 10% get {top} of all income. The poorest half get {bottom}.", { top: pctWhole(groups[2][2]), bottom: pctWhole(groups[0][2]) });
    var chart = $("splitChart");
    chart.textContent = "";
    [[t("People"), 1], [t("Income"), 2]].forEach(function (row) {
      var r = el("div", "split-row");
      r.appendChild(el("span", "split-label", row[0]));
      var bar = el("span", "stack");
      groups.forEach(function (g) {
        var seg = el("i", "seg s" + g[3]);
        seg.style.setProperty("--v", g[row[1]].toFixed(3));
        if (g[row[1]] >= 5) seg.appendChild(el("b", null, pctWhole(g[row[1]])));
        bar.appendChild(seg);
      });
      r.appendChild(bar);
      chart.appendChild(r);
    });
    var key = el("ul", "split-key");
    groups.forEach(function (g) {
      var li = el("li");
      li.appendChild(el("span", "sw s" + g[3]));
      li.appendChild(document.createTextNode(g[0]));
      key.appendChild(li);
    });
    chart.appendChild(key);
    $("splitNote").textContent = t("From the survey's split by tenths. Surveys rarely reach the very rich, so the richest group's real share is probably higher.");
  }

  /* ------------------------------------------------------------ history -- */
  var HIST = window.GIL_HISTORY || null, histLoading = false;
  function loadHistory(done) {
    if (HIST || histLoading) return;
    histLoading = true;
    var s = document.createElement("script");
    s.src = "data/history.js?v=" + encodeURIComponent(META.generated || "");   // new data, new address: no stale copy
    s.onload = function () { HIST = window.GIL_HISTORY || { lines: [], c: {} }; done(); };
    s.onerror = function () { HIST = { lines: [], c: {}, failed: true }; done(); };
    document.head.appendChild(s);
  }
  // One earlier survey as a country record: [year, median, first line index, [shares], comparability]
  function histRecord(d, row) {
    var xs = [], fs = [];
    row[3].forEach(function (f, j) { if (f != null) { xs.push(HIST.lines[row[2] + j]); fs.push(f); } });
    return Object.assign({}, d, { x: xs, F: fs, med: row[1], y: row[0], est: null });
  }
  function renderHist(d, ctx, cur, e) {
    var fig = $("figHist"), chart = $("histChart"), say = $("histSay"), note = $("histNote");
    fig.hidden = d.k !== "country";
    if (fig.hidden) return;
    chart.textContent = ""; say.textContent = ""; note.textContent = "";
    $("histSub").textContent = t("One bar per survey, oldest at the top. Income per person {per}, in {unit}; earlier years are at today's prices.", { per: per(), unit: unitWords(ctx, d) });
    if (!HIST) {
      note.textContent = t("Loading earlier surveys…");
      loadHistory(function () { renderSheet(); });
      return;
    }
    var rows = (HIST.c || {})[d.c] || [];
    if (rows.length < 2) {
      note.textContent = HIST.failed ? t("Earlier surveys couldn't be loaded.")
        : t("{country} has only one comparable survey, so there is nothing to compare yet.", { country: nameOf(d) });
      return;
    }
    var pick = rows;
    if (rows.length > 8) {   // at most eight bars, always the first and the last
      pick = [];
      for (var i = 0; i < 8; i++) pick.push(rows[Math.round(i * (rows.length - 1) / 7)]);
    }
    var first = histRecord(d, pick[0]), last = histRecord(d, pick[pick.length - 1]);
    if (POVERTY_LINE) {
      say.textContent = t("In {y1}, {p1} of people lived in extreme poverty. In {y2}, {p2}.",
        { y1: first.y, p1: pct(cdf(first, POVERTY_LINE) * 100), y2: last.y, p2: pct(cdf(last, POVERTY_LINE) * 100) });
    }
    var prev = null, breaks = 0;
    function bar(label, rec, cls) {
      var r = el("div", "hist-row" + (cls ? " " + cls : ""));
      r.appendChild(el("span", "hist-year", label));
      var b = el("span", "stack");
      stack(b, shares(rec, ctx, e), 8);
      r.appendChild(b);
      r.appendChild(el("span", "hist-med", money(median(rec, ctx), cur)));
      chart.appendChild(r);
    }
    pick.forEach(function (row) {
      var changed = prev && row[4] !== prev[4];   // a new method: not strictly comparable with the row above
      if (changed) breaks++;
      prev = row;
      bar(String(row[0]) + (changed ? " *" : ""), histRecord(d, row), changed ? "brk" : null);
    });
    if (d.est) bar(t("{year} est.", { year: d.y }), d, "est");
    var parts = [t("The figure on the right is the median: half the people lived on less.")];
    if (breaks) parts.push(t("* The survey changed its method that year, so compare it with earlier years with care."));
    if (pick.length < rows.length) parts.push(t("Showing {n} of {total} surveys.", { n: pick.length, total: rows.length }));
    note.textContent = parts.join(" ");
  }

  /* ------------------------------------------------------------- tenths -- */
  function niceStep(max, target) {
    var raw = max / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
  }
  function tickMoney(x, step, cur) {
    if (x === 0) return symbol(cur) + "0";
    if (x >= 10000) return symbol(cur) + compactNum(x, false);
    if (step < 1) return symbol(cur) + fixed(x, 2);
    if (step % 1 !== 0) return symbol(cur) + fixed(x, 1);
    return symbol(cur) + Math.round(x).toLocaleString(loc());
  }
  // Average income of each tenth, in the display currency per day.
  function tenths(d, f) { return d.ds.map(function (s) { return s * d.avg / 10 * f; }); }
  function decile(i) { return t(DECILES[i]); }

  var fig2 = null;
  function renderFig2(d, c, ctx, cur) {
    var chart = $("fig2Chart"), note = $("fig2Note"), wrap = $("fig2Table"), lg = $("fig2Legend");
    chart.textContent = ""; wrap.textContent = ""; lg.textContent = "";
    fig2 = null;
    $("fig2Sub").textContent = t("Average income per person {per} in each tenth, poorest to richest", { per: per() });
    var f = d.k === "country" ? factor(d, ctx) : null;
    if (!d.ds || d.avg == null || f == null) {
      $("fig2Toggle").hidden = true; lg.hidden = true; chart.hidden = true; wrap.hidden = true;
      note.textContent = d.k === "world" ? t("This breakdown is published country by country. Pick a country to see it.")
        : d.est ? t("The World Bank's estimate for this country doesn't include a breakdown by tenths.")
        : t("This survey doesn't publish a breakdown by tenths.");
      return;
    }
    $("fig2Toggle").hidden = false;
    var mine = tenths(d, f), theirs = null;
    if (c && c.k === "country" && c.ds && c.avg != null) {
      var cf = ctx === "ppp" ? 1 : factor(c, "usd");
      if (cf != null) theirs = tenths(c, ctx === "local" ? cf * RATES.rates[d.cur] : cf);
    }
    fig2 = { d: d, c: theirs ? c : null, mine: mine, theirs: theirs, cur: cur };

    var m = U().mult;
    var max = Math.max.apply(null, mine.concat(theirs || [])) * m;
    var step = niceStep(max, 4);
    var n = Math.max(1, Math.ceil(max / step - 1e-9));
    var dom = n * step;
    // The extreme poverty line, in this currency: where it falls along the money axis.
    var line = POVERTY_LINE ? POVERTY_LINE * f * m : null;
    if (line != null && line > dom) line = null;
    var items = [];
    if (theirs) items.push(["bar", nameOf(d)], ["tick", nameOf(c)]);
    if (line != null) items.push(["line", t("Extreme poverty line ($3.00 a day, price-adjusted)")]);
    legend(lg, items);

    chart.style.setProperty("--n", n);
    mine.forEach(function (v, i) {
      var row = el("div", "crow");
      row.dataset.i = i;
      row.appendChild(el("span", "c-label", decile(i)));
      var track = el("span", "c-track");
      var bar = el("i", "c-bar solo"); bar.style.width = (v * m / dom * 100) + "%"; track.appendChild(bar);
      if (line != null) { var ln = el("i", "c-line"); ln.style.left = (line / dom * 100) + "%"; track.appendChild(ln); }
      if (theirs) { var tk = el("i", "c-tick"); tk.style.left = (theirs[i] * m / dom * 100) + "%"; track.appendChild(tk); }
      row.appendChild(track);
      var val = el("span", "c-val");
      val.appendChild(el("b", null, money(v, cur)));
      val.appendChild(el("small", null, t("{p} of income", { p: pct(d.ds[i]) })));
      row.appendChild(val);
      chart.appendChild(row);
    });
    chartAxis(chart, n, function (k) { return tickMoney(k * step, step, cur); });

    var parts = [];
    if (d.gini != null) parts.push(t("Gini index {g} (0 means everyone has the same, 1 means one person has it all).", { g: fixed(d.gini, 2) }));
    if (c && !theirs) parts.push(t("{country} has no breakdown by tenths in this currency, so it isn't marked here.", { country: nameOf(c) }));
    note.textContent = parts.join(" ");

    var tbl = el("table"), thead = el("thead"), hr = el("tr");
    [t("Tenth of the population"), t("Average {per}", { per: per() }), t("Share of all income")].concat(theirs ? [t("{country}, average", { country: nameOf(c) })] : [])
      .forEach(function (h) { hr.appendChild(el("th", null, h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = el("tbody");
    mine.forEach(function (v, i) {
      var tr = el("tr");
      tr.appendChild(el("th", null, decile(i)));
      tr.appendChild(el("td", null, money(v, cur)));
      tr.appendChild(el("td", null, pct(d.ds[i])));
      if (theirs) tr.appendChild(el("td", null, money(theirs[i], cur)));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    applyToggle(2);
  }

  function applyToggle(k) {
    var on = state["t" + k], btn = $("fig" + k + "Toggle");
    $("fig" + k + "Chart").hidden = on;
    $("fig" + k + "Table").hidden = !on;
    btn.setAttribute("aria-pressed", String(on));
    btn.textContent = on ? t("Chart") : t("Table");
  }

  /* ------------------------------------------------------------- ledger -- */
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var list = LIST.filter(function (d) {
      if (state.region !== "all" && d.g !== state.region) return false;
      return !q || nameOf(d).toLowerCase().indexOf(q) !== -1 || d.n.toLowerCase().indexOf(q) !== -1;
    });
    var cmp = SORTS.filter(function (s) { return s[0] === state.sort; })[0][2];
    list.sort(function (a, b) { return cmp(a, b) || byName(a, b); });
    return list;
  }
  function yearText(d) { return d.k === "world" ? String(EST_YEAR) : String(surveyYear(d)); }

  function rowButton(d) {
    var ctx = state.money, sh = ledger.sh[d.c], med = median(d, ctx);
    var btn = el("button", "row");
    btn.type = "button";
    btn.dataset.c = d.c;
    btn.setAttribute("aria-pressed", String(d.c === state.sel));
    btn.setAttribute("aria-label", nameOf(d) + ", " + yearText(d) + (med != null ? ", " + t("median") + " " + money(med, "USD") + " " + per() : "") + ". " + t("Show details."));
    var name = el("span", "r-name");
    name.appendChild(flag(d));
    name.appendChild(document.createTextNode(nameOf(d)));
    if (d.c === state.cmp && d.c !== state.sel) name.appendChild(el("i", "cmp-mark"));
    btn.appendChild(name);
    btn.appendChild(el("span", "r-year", yearText(d)));
    btn.appendChild(el("span", "r-med", money(med, "USD")));
    if (sh) {
      var bar = el("span", "stack");
      bar.setAttribute("aria-hidden", "true");
      stack(bar, sh, 4);
      btn.appendChild(bar);
    } else {
      btn.appendChild(el("span", "r-none", t("No dependable exchange rate. See it in price-adjusted dollars.")));
    }
    return btn;
  }

  function renderLedger() {
    var ctx = state.money;
    ledger.e = EDGES[state.unit];
    ledger.sh = {};
    LIST.forEach(function (d) { ledger.sh[d.c] = shares(d, ctx, ledger.e); });
    if (byCode.WLD) ledger.sh.WLD = shares(WORLD, ctx, ledger.e);

    var list = visibleRows();
    var total = state.region === "all" ? LIST.length : LIST.filter(function (d) { return d.g === state.region; }).length;
    $("count").textContent = (list.length === total ? t("All {total} countries.", { total: total }) : t("{n} of {total} countries.", { n: list.length, total: total })) +
      " " + t("Select a row to open it.");
    $("colMed").textContent = t("Median / {unit}", { unit: t(U().word) });
    $("colYear").textContent = state.data === "est" ? t("From survey") : t("Survey");
    $("ledgerTitle").textContent = state.region === "all" ? t("Every country") : t(state.region);

    var empty = $("empty");
    empty.hidden = list.length > 0;
    if (!list.length) empty.textContent = t("No match for “{q}” here. Check the spelling, or switch “Part of the world” back to all countries.", { q: state.q.trim() });

    $("barsView").hidden = state.view !== "bars";
    $("numView").hidden = state.view !== "num";
    var all = (byCode.WLD && list.length ? [WORLD] : []).concat(list);

    if (state.view === "bars") {
      var ul = $("rows");
      ul.textContent = "";
      var frag = document.createDocumentFragment();
      all.forEach(function (d) {
        var li = el("li", d.k === "world" ? "pinned" : null);
        li.appendChild(rowButton(d));
        frag.appendChild(li);
      });
      ul.appendChild(frag);
    } else {
      var wrap = $("numView");
      wrap.textContent = "";
      var tbl = el("table", "num"), thead = el("thead"), hr = el("tr");
      hr.appendChild(el("th", null, t("Country")));
      hr.appendChild(el("th", null, $("colYear").textContent));
      hr.appendChild(el("th", null, $("colMed").textContent));
      for (var i = 0; i < 8; i++) {
        var th = el("th");
        th.appendChild(el("i", "sw s" + (i + 1)));
        th.appendChild(document.createTextNode(bracketLabel(i, ledger.e, "USD")));
        hr.appendChild(th);
      }
      thead.appendChild(hr); tbl.appendChild(thead);
      var tb = el("tbody");
      all.forEach(function (d) {
        var tr = el("tr"), sh = ledger.sh[d.c];
        tr.dataset.c = d.c;
        tr.tabIndex = 0;
        tr.setAttribute("aria-selected", String(d.c === state.sel));
        var name = el("th");
        name.appendChild(flag(d));
        name.appendChild(document.createTextNode(nameOf(d)));
        tr.appendChild(name);
        tr.appendChild(el("td", null, yearText(d)));
        tr.appendChild(el("td", null, money(median(d, ctx), "USD")));
        for (var k = 0; k < 8; k++) tr.appendChild(el("td", null, sh ? pct(sh[k]) : "–"));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb); wrap.appendChild(tbl);
    }
  }

  function markSelection() {
    document.querySelectorAll("#rows .row").forEach(function (r) {
      r.setAttribute("aria-pressed", String(r.dataset.c === state.sel));
      var mark = r.querySelector(".cmp-mark"), want = r.dataset.c === state.cmp && r.dataset.c !== state.sel;
      if (mark && !want) mark.remove();
      if (!mark && want) r.querySelector(".r-name").appendChild(el("i", "cmp-mark"));
    });
    document.querySelectorAll("#numView tbody tr").forEach(function (r) { r.setAttribute("aria-selected", String(r.dataset.c === state.sel)); });
    document.querySelectorAll("#map path").forEach(function (p) { p.classList.toggle("on", p.dataset.c === state.sel); });
  }
  function select(code, scroll) {
    if (!byCode[code]) return;
    state.sel = code;
    remember();
    renderSheet();
    markSelection();
    if (scroll && (scroll === "always" || window.matchMedia("(max-width: 979px)").matches)) {
      var smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      $("sheet").scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    }
  }

  /* --------------------------------------------------------------- tabs -- */
  function showTab(name, focus) {
    if (TABS.indexOf(name) === -1) name = "countries";
    state.tab = name;
    TABS.forEach(function (n) {
      var on = n === name, tab = $("tab-" + n);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $("panel-" + n).hidden = !on;
    });
    if (focus) $("tab-" + name).focus();
    remember();
  }

  /* ---------------------------------------------------------------- map -- */
  var SVGNS = "http://www.w3.org/2000/svg";
  function mapRecord(code) { return byCode[code] || (state.data === "est" ? otherBy[code] : null); }
  function renderMap() {
    var M = window.GIL_MAP, sec = $("mapSec");
    sec.hidden = !M;
    if (!M) return;
    var box = $("map"), svg = box.querySelector("svg"), ctx = state.money;
    if (!svg) {
      svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("viewBox", "0 0 " + M.w + " " + M.h);
      svg.setAttribute("role", "img");
      // diagonal hatching for places with no data, so they can't be mistaken for the grey of the top rungs
      var defs = document.createElementNS(SVGNS, "defs"), pat = document.createElementNS(SVGNS, "pattern");
      pat.setAttribute("id", "gil-hatch");
      pat.setAttribute("width", "6"); pat.setAttribute("height", "6");
      pat.setAttribute("patternUnits", "userSpaceOnUse"); pat.setAttribute("patternTransform", "rotate(45)");
      var bg = document.createElementNS(SVGNS, "rect"), ln = document.createElementNS(SVGNS, "line");
      bg.setAttribute("class", "hatch-bg"); bg.setAttribute("width", "6"); bg.setAttribute("height", "6");
      ln.setAttribute("class", "hatch-line"); ln.setAttribute("x1", "0"); ln.setAttribute("y1", "0"); ln.setAttribute("x2", "0"); ln.setAttribute("y2", "6");
      pat.appendChild(bg); pat.appendChild(ln); defs.appendChild(pat); svg.appendChild(defs);
      Object.keys(M.shapes).forEach(function (code) {
        var p = document.createElementNS(SVGNS, "path");
        p.setAttribute("d", M.shapes[code]);
        p.dataset.c = code;
        svg.appendChild(p);
      });
      box.appendChild(svg);
    }
    svg.setAttribute("aria-label", t("World map, each country coloured by its median income"));
    svg.querySelectorAll("path").forEach(function (p) {
      var d = mapRecord(p.dataset.c), med = d ? median(d, worldCtx(ctx)) : null;
      p.setAttribute("class", (med == null ? "nodata" : "s" + (bracketOf(med) + 1)) + (byCode[p.dataset.c] ? " pick" : "") + (p.dataset.c === state.sel ? " on" : ""));
    });
    $("mapCap").textContent = t("Each country is coloured by what its middle person lives on (the median), in {unit}. Grey hatching means no data.", { unit: moneyWords(ctx) });
  }
  function mapTip(code) {
    var d = mapRecord(code);
    if (!d) return false;
    var ctx = worldCtx(state.money), med = median(d, ctx), rows = [];
    if (med == null) rows.push({ value: "–", label: t("No dependable exchange rate. See it in price-adjusted dollars.") });
    else rows.push({ color: bracketOf(med) + 1, value: money(med, "USD"), label: t("Half the people live on less") + " (" + per() + ")" });
    var pov = povertyShare(d);
    if (pov != null) rows.push({ value: pct(pov * 100), label: t("In extreme poverty") });
    tipRows(nameOf(d), d.k === "country" ? yearText(d) : t("{year} estimate", { year: EST_YEAR }), rows);
    return true;
  }

  /* -------------------------------------------------------- where do I stand -- */
  function standCurrencies(d) {
    var out = [];
    if (d.cur && d.cur !== "USD" && factor(d, "local") != null && RATES.rates[d.cur]) out.push([d.cur, currencyName(d.cur) + " (" + symbol(d.cur).trim() + ")"]);
    if (factor(d, "usd") != null) out.push(["USD", t("US dollars") + " ($)"]);
    return out;
  }
  function fillStand(keepCountry) {
    var sel = $("stCountry"), prev = sel.value;
    fillCountrySelect(sel, false, true);
    sel.value = keepCountry && prev && SURVEYS.some(function (d) { return d.c === prev; }) ? prev : (byCode[state.sel] && byCode[state.sel].k === "country" ? state.sel : biggest.c);
    fillStandCur();
  }
  function fillStandCur() {
    var cs = $("stCur"), prev = cs.value, d = standRecord();
    cs.textContent = "";
    standCurrencies(d).forEach(function (c) { cs.appendChild(new Option(c[1], c[0])); });
    if (prev && Array.prototype.some.call(cs.options, function (o) { return o.value === prev; })) cs.value = prev;
  }
  // "Where do I stand" is about today, so it uses the same-year estimate where there is one.
  function standRecord() {
    var code = $("stCountry").value || state.sel;
    return estBy[code] || SURVEYS.filter(function (d) { return d.c === code; })[0] || biggest;
  }
  function standPct(f) {
    if (f < 0.01) return t("less than 1%");
    if (f > 0.99) return t("more than 99%");
    return percent(Math.round(f * 100), 0);
  }
  var standResult = null;
  function renderStand() {
    var out = $("stOut"), d = standRecord();
    out.textContent = "";
    standResult = null;
    var amount = parseFloat($("stAmount").value), heads = Math.max(1, parseInt($("stPeople").value, 10) || 1);
    var period = UNITS[$("stPeriod").value] ? $("stPeriod").value : "month", cur = $("stCur").value;
    if (!cur) {
      out.appendChild(el("p", "st-msg", t("There is no dependable exchange rate for {country}, so an amount can't be placed there yet.", { country: nameOf(d) })));
      return;
    }
    if (!(amount > 0)) {
      out.appendChild(el("p", "st-msg", t("Type an amount to see where you stand.")));
      return;
    }
    var perDay = amount / heads / UNITS[period].mult;                 // in the chosen currency
    var x = perDay / factor(d, cur === "USD" ? "usd" : "local");      // international dollars a day
    var usd = x * factor(d, "usd");
    var ctx = state.money, e = EDGES[state.unit];
    var pc = cdf(d, x);
    var pw = ESTIMATES.length ? worldBelow(ctx === "ppp" ? x : usd, ctx) : null;

    var line = t("That's {amount} a day for each person.", { amount: symbol(cur) + num(perDay, true) });
    if (cur !== "USD") line += " " + t("About {amount} a day in US dollars.", { amount: symbol("USD") + num(usd, true) });
    out.appendChild(el("p", "st-per", line));

    function result(text, place, f, sh, note) {
      var r = el("div", "st-row");
      var h = el("p", "st-big");
      h.appendChild(tNode(text, { p: el("b", null, standPct(f)), place: place }));
      r.appendChild(h);
      r.appendChild(markedBar(sh, f));
      if (note) r.appendChild(el("p", "st-note", note));
      out.appendChild(r);
    }
    var dname = d.est ? t("{year} estimate", { year: d.y }) : t("{year} survey", { year: d.y });
    result("Richer than {p} of people in {place}.", placeName(d), pc, shares(d, ctx === "ppp" ? "ppp" : "usd", e),
      dname + " · " + t("Bar in {unit} {per}", { unit: moneyWords(ctx), per: per() }));
    if (pw != null) {
      result("Richer than {p} of people in the world.", null, pw, shares(WORLD, ctx, e),
        t("World Bank estimate for {year}, in {unit}.", { year: EST_YEAR, unit: moneyWords(ctx) }));
    }
    standResult = { d: d, pc: pc, pw: pw, ctx: ctx };
    var acts = el("div", "st-acts");
    acts.appendChild(button(t("Share my result"), "link-btn", shareStand));
    out.appendChild(acts);
  }

  /* ------------------------------------------------------------- dialog -- */
  var dlg = $("dlg"), dlgUrls = [];
  function dialogOpen(title) {
    $("dlgTitle").textContent = title;
    var body = $("dlgBody");
    body.textContent = "";
    if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
    return body;
  }
  function dialogClose() {
    if (dlg.close) dlg.close(); else { dlg.removeAttribute("open"); dlgCleanup(); }
  }
  function dlgCleanup() {
    dlgUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    dlgUrls = [];
  }
  dlg.addEventListener("close", dlgCleanup);
  dlg.addEventListener("click", function (e) { if (e.target === dlg) dialogClose(); });
  $("dlgClose").addEventListener("click", dialogClose);
  function copyText(text, btn) {
    var done = function () { var was = btn.textContent; btn.textContent = t("Copied"); setTimeout(function () { btn.textContent = was; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    else fallback();
    function fallback() {
      var ta = el("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* the reader can copy by hand */ }
      ta.remove();
    }
  }
  function offlineNote(body) {
    if (!/^https?:$/.test(location.protocol)) body.appendChild(el("p", "fine", t("This link points to the copy on this computer; it will work for others once the site is online.")));
  }

  /* --------------------------------------------------------- share cards -- */
  function cardFont(weight, size, display) {
    return weight + " " + size + "px " + (display ? '"Bricolage Grotesque", "Arial Narrow", system-ui, sans-serif' : '"Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif');
  }
  function wrapLines(g, text, maxW, maxLines) {
    var words = text.split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      var test = line ? line + " " + w : w;
      if (g.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    });
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] += "…"; }
    return lines;
  }
  // A 1200 x 630 picture (the size social sites use for link previews), always in the light palette.
  // o: { d, title, headline, sub, sh, e, cur, marker (0..1), stripe (bracket index), source }
  function drawCard(o, withFlag, done) {
    var W = 1200, H = 630, P = 72;
    var cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var g = cv.getContext("2d");
    function paint(img) {
      g.fillStyle = CARD.bg; g.fillRect(0, 0, W, H);
      g.fillStyle = CARD.b[o.stripe == null ? 1 : o.stripe]; g.fillRect(0, 0, 14, H);
      g.textBaseline = "alphabetic";
      g.fillStyle = CARD.muted; g.font = cardFont(600, 22);
      g.fillText(t("Global Income Ladder").toUpperCase(), P, 70);
      var x = P, y = 136;
      if (img) { g.drawImage(img, P, y - 40, 56, 42); g.strokeStyle = CARD.rule; g.lineWidth = 1; g.strokeRect(P + 0.5, y - 39.5, 55, 41); x = P + 74; }
      g.fillStyle = CARD.ink; g.font = cardFont(700, 46, true);
      g.fillText(o.title, x, y);
      g.font = cardFont(800, 50, true);
      var lines = wrapLines(g, o.headline, W - 2 * P, 3);
      y = 206;
      lines.forEach(function (l) { g.fillText(l, P, y); y += 60; });
      if (o.sub) {
        g.fillStyle = CARD.muted; g.font = cardFont(500, 25);
        wrapLines(g, o.sub, W - 2 * P, lines.length > 2 ? 1 : 2).forEach(function (l) { g.fillText(l, P, y - 8); y += 34; });
      }
      // the bar
      var by = 440, bh = 66, bx = P, bw = W - 2 * P, gap = 3, shown = o.sh.filter(function (v) { return v >= 0.5; }).length;
      var usable = bw - gap * Math.max(0, shown - 1), cx = bx;
      var tot = o.sh.reduce(function (a, v) { return a + (v >= 0.5 ? v : 0); }, 0) || 100;
      o.sh.forEach(function (v, i) {
        if (v < 0.5) return;
        var w = usable * v / tot;
        g.fillStyle = CARD.b[i]; g.fillRect(cx, by, w, bh);
        if (w > 64) {
          g.fillStyle = CARD.on[i]; g.font = cardFont(700, 24); g.textAlign = "center";
          g.fillText(pctWhole(v), cx + w / 2, by + bh / 2 + 9); g.textAlign = "left";
        }
        cx += w + gap;
      });
      if (o.marker != null) {
        var mx = bx + bw * o.marker;
        g.fillStyle = CARD.ink; g.fillRect(mx - 2, by - 14, 4, bh + 28);
        g.font = cardFont(800, 24); g.textAlign = "center";
        g.fillText(t("You"), Math.min(W - P, Math.max(P, mx)), by - 22); g.textAlign = "left";
      }
      // the key
      g.font = cardFont(600, 18);
      var kw = bw / 8;
      for (var i = 0; i < 8; i++) {
        var kx = bx + i * kw;
        g.fillStyle = CARD.b[i]; g.fillRect(kx, by + bh + 26, 16, 16);
        g.fillStyle = CARD.ink; g.fillText(bracketLabel(i, o.e, o.cur), kx + 24, by + bh + 40);
      }
      g.fillStyle = CARD.muted; g.font = cardFont(500, 20);
      g.fillText(o.source, P, H - 34);
      var host = /^https?:$/.test(location.protocol) ? location.host : "";
      if (host) { g.textAlign = "right"; g.fillText(host, W - P, H - 34); g.textAlign = "left"; }
    }
    function finish(img) {
      paint(img);
      try { cv.toBlob(function (b) { done(b); }, "image/png"); }
      catch (e) { if (img) drawCard(o, false, done); }   // a flag from disk can block export; try without it
    }
    if (withFlag && o.d && o.d.k === "country") {
      var img = new Image();
      img.onload = function () { finish(img); };
      img.onerror = function () { finish(null); };
      img.src = flagSrc(o.d);
    } else finish(null);
  }
  function openShare(o, url, text) {
    var body = dialogOpen(t("Share"));
    body.appendChild(el("p", "fine", t("Making the picture…")));
    var go = function () {
      drawCard(o, true, function (blob) {
        body.textContent = "";
        if (!blob) { body.appendChild(el("p", null, t("The picture couldn't be made in this browser."))); return; }
        var src = URL.createObjectURL(blob);
        dlgUrls.push(src);
        var img = el("img", "dlg-img");
        img.src = src; img.alt = o.headline;
        body.appendChild(img);
        var name = (o.file || "income-ladder") + ".png";
        var acts = el("div", "dlg-acts"), file = null;
        try { file = new File([blob], name, { type: "image/png" }); } catch (e) { file = null; }
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          acts.appendChild(button(t("Share…"), "btn primary", function () {
            navigator.share({ files: [file], title: o.title, text: text + " " + url }).catch(function () { /* cancelled */ });
          }));
        }
        acts.appendChild(button(t("Download picture"), "btn", function () {
          var a = el("a"); a.href = src; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        }));
        var wa = el("a", "btn", "WhatsApp");
        wa.href = "https://wa.me/?text=" + encodeURIComponent(text + " " + url);
        wa.target = "_blank"; wa.rel = "noopener";
        acts.appendChild(wa);
        var copy = button(t("Copy link"), "btn", function () { copyText(url, copy); });
        acts.appendChild(copy);
        body.appendChild(acts);
        body.appendChild(el("p", "dlg-link", url));
        offlineNote(body);
      });
    };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go); else go();
  }
  function sourceLine(d) {
    if (d.k === "world") return t("World Bank estimates for {year}", { year: EST_YEAR });
    return d.est ? t("World Bank estimate for {year}, from the {sy} survey", { year: d.y, sy: d.sy }) : t("World Bank household survey, {year}", { year: d.y });
  }
  function shareCountry() {
    var d = byCode[state.sel], ctx = sheetCtx(d), cur = curOf(d, ctx), e = edgesFor(d, ctx), sh = shares(d, ctx, e);
    if (!sh) return;
    var h = headline(d, ctx, cur, e, sh);
    openShare({ d: d, title: nameOf(d), headline: h.main, sub: h.sub.join(" "), sh: sh, e: e, cur: cur, stripe: h.mid,
      source: sourceLine(d) + " · " + unitWords(ctx, d), file: d.c.toLowerCase() + "-income-ladder" },
      pageUrl(linkState({ c: d.c })), h.main);
  }
  function shareStand() {
    var r = standResult;
    if (!r) return;
    var e = EDGES[state.unit], f = r.pw != null ? r.pw : r.pc;
    var text = r.pw != null
      ? t("I'm richer than {pw} of people in the world and {pc} of people in {place}. Where do you stand?", { pw: standPct(r.pw), pc: standPct(r.pc), place: placeName(r.d) })
      : t("I'm richer than {pc} of people in {place}. Where do you stand?", { pc: standPct(r.pc), place: placeName(r.d) });
    openShare({ d: r.pw != null ? WORLD : r.d, title: t("Where do I stand?"), headline: text, sub: "",
      sh: r.pw != null ? shares(WORLD, r.ctx, e) : shares(r.d, r.ctx, e), e: e, cur: "USD", marker: f, stripe: bracketOf(1),
      source: (r.pw != null ? t("World Bank estimates for {year}", { year: EST_YEAR }) : sourceLine(r.d)) + " · " + moneyWords(r.ctx), file: "where-i-stand" },
      pageUrl(linkState({})) + "#stand", text);   // opens the "Where do I stand?" tab
  }
  function openEmbed() {
    var d = byCode[state.sel];
    var body = dialogOpen(t("Put this on your website"));
    body.appendChild(el("p", null, t("Copy this code into your page. It shows {country}'s bar and sentence, and links back here.", { country: nameOf(d) })));
    var src = pageUrl(linkState({ embed: d.c }));
    var title = t("Global Income Ladder") + ": " + nameOf(d);
    var code = '<iframe src="' + src.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '" title="' + title.replace(/&/g, "&amp;").replace(/"/g, "&quot;") +
      '" width="100%" height="320" style="border:0;max-width:720px" loading="lazy"></iframe>';
    var ta = el("textarea", "dlg-code");
    ta.readOnly = true; ta.rows = 4; ta.value = code;
    ta.addEventListener("focus", function () { ta.select(); });
    body.appendChild(ta);
    var acts = el("div", "dlg-acts");
    var copy = button(t("Copy code"), "btn primary", function () { copyText(code, copy); });
    acts.appendChild(copy);
    body.appendChild(acts);
    body.appendChild(el("p", "fine", t("Preview:")));
    var frame = el("iframe", "dlg-frame");
    frame.src = src; frame.title = title; frame.loading = "lazy";
    body.appendChild(frame);
    offlineNote(body);
  }

  /* ------------------------------------------------- embed and slide modes -- */
  // One country as a card: flag and name, the sentence, the bar and its key.
  function countryCard(d, big) {
    var ctx = sheetCtx(d), cur = curOf(d, ctx), e = edgesFor(d, ctx), sh = shares(d, ctx, e);
    var card = el("article", "card" + (big ? " big" : ""));
    var head = el("header", "card-head");
    var h = el("h2");
    if (d.k === "country") h.appendChild(flag(d));
    h.appendChild(document.createTextNode(nameOf(d)));
    head.appendChild(h);
    head.appendChild(el("p", "card-meta", metaLine(d, ctx)));
    card.appendChild(head);
    if (!sh) return card;
    var hl = headline(d, ctx, cur, e, sh);
    var say = el("div", "say");
    say.style.setProperty("--say", "var(--b" + (hl.mid + 1) + ")");
    say.appendChild(el("p", "say-main", hl.main));
    say.appendChild(el("p", "say-sub", hl.sub.concat([t("Shown in {unit}.", { unit: unitWords(ctx, d) })]).join(" ")));
    card.appendChild(say);
    var bar = el("div", "stack card-bar");
    stack(bar, sh, big ? 3 : 5);
    card.appendChild(bar);
    var ends = el("p", "howto-ends");
    ends.appendChild(el("span", null, t("← poorest")));
    ends.appendChild(el("span", null, t("richest →")));
    card.appendChild(ends);
    card.appendChild(keyList(e, cur, "key card-key"));
    return card;
  }
  function renderEmbed() {
    document.body.classList.add("embed-mode");
    $("page").hidden = true;
    var box = $("embed");
    box.hidden = false;
    box.textContent = "";
    var d = byCode[state.sel];
    box.appendChild(countryCard(d, false));
    var foot = el("p", "card-foot");
    var a = el("a", null, t("See every country on Global Income Ladder") + " ↗");
    a.href = pageUrl(linkState({ c: d.c })); a.target = "_blank"; a.rel = "noopener";
    foot.appendChild(a);
    foot.appendChild(el("span", null, sourceLine(d)));
    box.appendChild(foot);
  }
  // Classroom slides: ?present=IND,BDI,USA (&guess=1 hides each answer until revealed).
  function renderPresent() {
    document.body.classList.add("present-mode");
    $("page").hidden = true;
    var box = $("present");
    box.hidden = false;
    var codes = (params.get("present") || "").split(",").map(function (s) { return s.trim().toUpperCase(); })
      .filter(function (c) { return byCode[c]; });
    if (!codes.length) codes = [biggest.c];
    var guess = params.get("guess") === "1", i = 0, shown = !guess;
    function show() {
      box.textContent = "";
      var d = byCode[codes[i]], slide = el("div", "slide");
      if (shown) slide.appendChild(countryCard(d, true));
      else {
        var q = el("div", "card big ask");
        var h = el("h2");
        h.appendChild(flag(d));
        h.appendChild(document.createTextNode(nameOf(d)));
        q.appendChild(h);
        q.appendChild(el("p", "say-main", t("How do you think people in {place} are spread across the ladder? Make a guess, then reveal.", { place: placeName(d) })));
        q.appendChild(keyList(EDGES[state.unit], "USD", "key card-key"));
        q.appendChild(button(t("Reveal"), "btn primary", function () { shown = true; show(); }));
        slide.appendChild(q);
      }
      box.appendChild(slide);
      var nav = el("nav", "slide-nav");
      nav.appendChild(button("←", "btn", prev));
      nav.appendChild(el("span", null, (i + 1) + " / " + codes.length));
      nav.appendChild(button("→", "btn", next));
      if (document.documentElement.requestFullscreen) nav.appendChild(button(t("Full screen"), "btn", function () { document.documentElement.requestFullscreen().catch(function () {}); }));
      var exit = el("a", "btn", t("Exit"));
      exit.href = "teach.html";
      nav.appendChild(exit);
      box.appendChild(nav);
    }
    function next() {
      if (!shown) { shown = true; show(); return; }
      if (i < codes.length - 1) { i++; shown = !guess; show(); }
    }
    function prev() { if (i > 0) { i--; shown = true; show(); } }
    document.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { e.preventDefault(); next(); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); prev(); }
    });
    show();
  }

  /* ------------------------------------------------------------ tooltip -- */
  var tip = $("tip");
  function tipRows(title, sub, rows) {
    tip.textContent = "";
    var h = el("h4", null, title);
    if (sub) { h.appendChild(document.createTextNode(" ")); h.appendChild(el("span", null, sub)); }
    tip.appendChild(h);
    var ul = el("ul");
    rows.forEach(function (r) {
      var li = el("li", r.cls || null);
      var key = el("span", "t-key" + (r.tick ? " tick" : ""));
      if (r.color) key.style.background = typeof r.color === "number" ? "var(--b" + r.color + ")" : "var(--" + r.color + ")";
      li.appendChild(key);
      li.appendChild(el("span", "t-v", r.value));
      li.appendChild(el("span", "t-l", r.label));
      li.appendChild(el("span", "t-p", r.extra || ""));
      ul.appendChild(li);
    });
    tip.appendChild(ul);
    tip.hidden = false;
  }
  function placeTip(x, y) {
    var w = tip.offsetWidth, h = tip.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var left = x + 14, top = y + 16;
    if (left + w > vw - 8) left = x - w - 14;
    if (top + h > vh - 8) top = y - h - 14;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { tip.hidden = true; }
  function ledgerTip(d, hot) {
    var sh = ledger.sh[d.c];
    if (!sh) { hideTip(); return false; }
    var pop = population(d, state.money);
    tipRows(nameOf(d), yearText(d), sh.map(function (v, i) {
      return { color: i + 1, value: pct(v), label: bracketLabel(i, ledger.e, "USD"), extra: pop && v > 0 ? people(pop * v / 100) : "", cls: hot == null ? null : hot === i ? "on" : "dim" };
    }));
    return true;
  }

  /* ------------------------------------------------------------- events -- */
  function wirePage() {
    var rowsEl = $("rows");
    rowsEl.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse") return;
      var bar = e.target.closest(".stack"), row = e.target.closest(".row");
      if (!bar || !row) { hideTip(); return; }
      var seg = e.target.closest(".seg");
      if (ledgerTip(byCode[row.dataset.c], seg ? +seg.dataset.i : null)) placeTip(e.clientX, e.clientY);
    });
    rowsEl.addEventListener("pointerleave", hideTip);
    rowsEl.addEventListener("focusin", function (e) {
      var row = e.target.closest(".row");
      if (!row || !row.matches(":focus-visible")) return;
      var bar = row.querySelector(".stack");
      if (!bar || !ledgerTip(byCode[row.dataset.c], null)) return;
      var r = bar.getBoundingClientRect();
      placeTip(r.left, r.bottom - 8);
    });
    rowsEl.addEventListener("focusout", hideTip);
    rowsEl.addEventListener("click", function (e) {
      var row = e.target.closest(".row");
      if (row) { hideTip(); select(row.dataset.c, true); }
    });

    function chartTip(chartId, build) {
      var chart = $(chartId);
      chart.addEventListener("pointermove", function (e) {
        if (e.pointerType !== "mouse") return;
        var row = e.target.closest(".crow");
        if (!row || row.dataset.i == null) { hideTip(); return; }
        if (build(+row.dataset.i) !== false) placeTip(e.clientX, e.clientY);
      });
      chart.addEventListener("pointerleave", hideTip);
    }
    chartTip("fig1Chart", function (i) {
      if (!fig1) return false;
      var a = fig1, r = a.rungs[i], pop = population(a.d, a.ctx);
      var rows = [{ color: r.color, value: pct(r.v), label: nameOf(a.d), extra: pop && r.v > 0 ? t("{n} people", { n: people(pop * r.v / 100) }) : "" }];
      if (a.c) {
        var cpop = population(a.c, a.ctx);
        rows.push({ tick: true, value: pct(r.cv), label: nameOf(a.c), extra: cpop && r.cv > 0 ? t("{n} people", { n: people(cpop * r.cv / 100) }) : "" });
      }
      tipRows(r.label, per(), rows);
    });
    chartTip("fig2Chart", function (i) {
      if (!fig2) return false;
      var rows = [{ color: "solo", value: money(fig2.mine[i], fig2.cur), label: nameOf(fig2.d), extra: t("{p} of income", { p: pct(fig2.d.ds[i]) }) }];
      if (fig2.c) rows.push({ tick: true, value: money(fig2.theirs[i], fig2.cur), label: nameOf(fig2.c), extra: t("{p} of income", { p: pct(fig2.c.ds[i]) }) });
      tipRows(decile(i), t("average {per}", { per: per() }), rows);
    });
    window.addEventListener("scroll", hideTip, { passive: true });

    var mapEl = $("map");
    mapEl.addEventListener("pointermove", function (e) {
      var p = e.target.closest("path");
      if (!p || !mapTip(p.dataset.c)) { hideTip(); return; }
      placeTip(e.clientX, e.clientY);
    });
    mapEl.addEventListener("pointerleave", hideTip);
    mapEl.addEventListener("click", function (e) {
      var p = e.target.closest("path");
      if (p && byCode[p.dataset.c]) { hideTip(); showTab("countries"); select(p.dataset.c, "always"); }
    });

    document.querySelectorAll("[data-unit]").forEach(function (b) {
      b.addEventListener("click", function () { state.unit = b.dataset.unit; remember(); renderAll(); });
    });
    document.querySelectorAll("[data-money]").forEach(function (b) {
      b.addEventListener("click", function () { state.money = b.dataset.money; remember(); renderAll(); });
    });
    document.querySelectorAll("[data-data]").forEach(function (b) {
      b.addEventListener("click", function () {
        useData(b.dataset.data);
        if (!byCode[state.sel]) state.sel = biggest.c;
        if (state.cmp && !byCode[state.cmp]) state.cmp = "";
        remember();
        fillSelects();
        renderAll();
      });
    });
    document.querySelectorAll("[data-local]").forEach(function (b) {
      b.addEventListener("click", function () { state.local = b.dataset.local === "1"; remember(); renderSheet(); });
    });
    document.querySelectorAll("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.view = b.dataset.view;
        pressed("[data-view]", "view", state.view);
        renderLedger();
      });
    });
    $("pick").addEventListener("change", function (e) { select(e.target.value, false); });
    $("cmp").addEventListener("change", function (e) { state.cmp = e.target.value; remember(); renderSheet(); markSelection(); });
    $("q").addEventListener("input", function (e) { state.q = e.target.value; renderLedger(); });
    $("region").addEventListener("change", function (e) { state.region = e.target.value; renderLedger(); });
    $("sort").addEventListener("change", function (e) { state.sort = e.target.value; renderLedger(); });
    $("fig1Toggle").addEventListener("click", function () { state.t1 = !state.t1; applyToggle(1); });
    $("fig2Toggle").addEventListener("click", function () { state.t2 = !state.t2; applyToggle(2); });
    $("numView").addEventListener("click", function (e) {
      var tr = e.target.closest("tbody tr");
      if (tr) select(tr.dataset.c, true);
    });
    $("numView").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var tr = e.target.closest("tbody tr");
      if (tr) { e.preventDefault(); select(tr.dataset.c, true); }
    });
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { showTab(b.dataset.tab); });
      b.addEventListener("keydown", function (e) {   // arrow keys move between tabs
        var i = TABS.indexOf(b.dataset.tab), step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        showTab(TABS[(i + step + TABS.length) % TABS.length], true);
      });
    });
    window.addEventListener("hashchange", function () { showTab(location.hash.slice(1)); });
    $("btnShare").addEventListener("click", shareCountry);
    $("btnEmbed").addEventListener("click", openEmbed);
    $("stCountry").addEventListener("change", function () { fillStandCur(); renderStand(); });
    ["stAmount", "stPeople"].forEach(function (id) { $(id).addEventListener("input", renderStand); });
    ["stPeriod", "stCur"].forEach(function (id) { $(id).addEventListener("change", renderStand); });
    var langSel = $("lang");
    LANGS.forEach(function (l) { langSel.appendChild(new Option(l[1], l[0])); });
    langSel.value = state.lang;
    langSel.addEventListener("change", function () {
      state.lang = isLang(langSel.value) ? langSel.value : "en";
      save("gil:lang", state.lang);
      remember();
      applyStatic();
      fillSelects();
      renderAll();
    });
  }

  /* -------------------------------------------------------------- theme -- */
  // Auto follows the device. A choice is kept in localStorage and applied before the page paints
  // (the small script in <head>); this only keeps the buttons in step.
  function applyTheme(th) {
    var root = document.documentElement;
    if (th === "light" || th === "dark") root.dataset.theme = th; else delete root.dataset.theme;
    document.querySelectorAll("[data-theme-pick]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.themePick === (root.dataset.theme || "auto")));
    });
  }
  applyTheme(document.documentElement.dataset.theme || "auto");
  document.querySelectorAll("[data-theme-pick]").forEach(function (b) {
    b.addEventListener("click", function () {
      var th = b.dataset.themePick;
      try { if (th === "auto") localStorage.removeItem("gil:theme"); else localStorage.setItem("gil:theme", th); } catch (e) { /* storage unavailable */ }
      applyTheme(th);
    });
  });

  function fillSelects() {
    fillCountrySelect($("pick"), false);
    fillCountrySelect($("cmp"), true);
    fillStand(true);
  }
  function renderAll() {
    if (MODE === "embed") { renderEmbed(); return; }
    if (MODE === "present") { renderPresent(); return; }
    renderHero();
    renderNotes();
    fillSort();
    renderMap();
    renderSheet();
    renderLedger();
    renderStand();
  }

  /* --------------------------------------------------------- live rates -- */
  // The page ships with the rates in data/rates.js and replaces them with today's when it can.
  function applyRates(fresh) {
    RATES = { date: fresh.date, rates: Object.assign({}, RATES.rates, fresh.rates, { USD: 1 }) };
    memo = {};
    if (MODE === "present") return;   // don't rebuild a slide mid-lesson
    renderAll();
  }
  function getJson(url) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function refreshRates() {
    if (typeof fetch !== "function") return;
    var kept = load("gil:rates");
    if (kept && kept.date && kept.rates && kept.date > RATES.date) applyRates(kept);
    if (kept && kept.checked && Date.now() - kept.checked < 3 * 3600 * 1000) return;
    getJson(LIVE_RATE_URLS[0]).catch(function () { return getJson(LIVE_RATE_URLS[1]); }).then(function (j) {
      if (!j || !j.usd || !j.date) return;
      var rates = {};
      Object.keys(RATES.rates).forEach(function (code) {
        var v = j.usd[code.toLowerCase()];
        if (typeof v === "number" && v > 0) rates[code] = v;
      });
      var fresh = { date: String(j.date), rates: rates, checked: Date.now() };
      save("gil:rates", fresh);
      if (fresh.date > RATES.date) applyRates(fresh);
    }).catch(function () { /* offline or blocked: the shipped rates stay */ });
  }

  /* --------------------------------------------------------------- boot -- */
  applyStatic();
  if (MODE === "page") {
    wirePage();
    fillSelects();
    pressed("[data-view]", "view", state.view);
  }
  renderAll();
  if (MODE === "page") showTab(state.tab);
  refreshRates();
})();
