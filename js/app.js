/* Global Income Ladder
 *
 * Data comes from two generated files:
 *   data/countries.js  window.GIL_DATA   each country's income distribution (scripts/update_data.py)
 *   data/rates.js      window.GIL_RATES  exchange rates, local currency per US dollar (scripts/update_rates.py)
 *
 * Every country carries a curve: the share of people living below a list of income levels,
 * in international (price-adjusted) dollars per day. Everything on the page is cut from that curve.
 * To show money instead of price-adjusted dollars, an amount is turned into international dollars with
 *   local currency today = international dollars x ppp x infl      (price level, then inflation since)
 *   US dollars today     = local currency today / exchange rate
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
  var LIST = DATA.countries;
  var RATES = { date: (window.GIL_RATES || {}).date || "", rates: Object.assign({ USD: 1 }, (window.GIL_RATES || {}).rates || {}) };
  var LIVE_RATE_URLS = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json"
  ];

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

  var byCode = {};
  LIST.forEach(function (d) { d.k = "country"; byCode[d.c] = d; });

  var biggest = LIST.reduce(function (a, b) { return (b.p || 0) > (a.p || 0) ? b : a; });
  var state = { unit: "day", money: "usd", local: false, sel: biggest.c, cmp: "", q: "", region: "all", sort: "name", view: "bars", t1: false, t2: false };

  function load(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } }
  (function restore() {
    var s = load("gil:view");
    if (!s) return;
    if (UNITS[s.unit]) state.unit = s.unit;
    if (s.money === "usd" || s.money === "ppp") state.money = s.money;
    if (byCode[s.sel]) state.sel = s.sel;
    if (s.cmp === "" || byCode[s.cmp]) state.cmp = s.cmp;
    state.local = !!s.local;
  })();
  function remember() { save("gil:view", { unit: state.unit, money: state.money, sel: state.sel, cmp: state.cmp, local: state.local }); }

  /* ------------------------------------------------------------ helpers -- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function U() { return UNITS[state.unit]; }
  // Flags load lazily from flags/; the one-file build supplies them inline as window.GIL_FLAGS.
  var FLAGS = window.GIL_FLAGS || null;
  function flag(d) {
    if (d.k !== "country") return el("span", "flag none");
    var img = el("img", "flag");
    img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    img.onerror = function () { img.replaceWith(el("span", "flag none")); };
    img.src = FLAGS ? FLAGS[d.c] || "" : "flags/" + d.c.toLowerCase() + ".svg";
    return img;
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
  function hasMoney(d) { return factor(d, "usd") != null; }
  function canLocal(d) {
    return factor(d, "local") != null && !!RATES.rates[d.cur] && !(d.cur === "USD" && state.money === "usd");
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
    if (/[A-Za-zÀ-ɏЀ-ӿ.]$/.test(s)) s += " ";
    return (symbols[cur] = s);
  }
  function currencyName(cur) {
    try {
      var name = new Intl.DisplayNames(["en"], { type: "currency" }).of(cur);
      if (name && name !== cur) return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) { /* older browsers */ }
    return cur;
  }
  var compact = null;
  try { compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }); } catch (e) { compact = null; }
  function num(x, isAmount) {
    var a = Math.abs(x);
    if (a >= 1e6 && compact) return compact.format(x);
    if (isAmount) return a < 100 ? x.toFixed(2) : Math.round(x).toLocaleString("en-US");
    return (+x.toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  // perDay: an amount in the display currency, per person per day.
  function money(perDay, cur) {
    if (perDay == null || !isFinite(perDay)) return "–";
    return symbol(cur) + num(perDay * U().mult, true);
  }
  function edgeLabel(v, cur) { return symbol(cur) + num(v, false); }
  function bracketLabel(i, e, cur) {
    if (i === 0) return "Under " + edgeLabel(e[0], cur);
    if (i === 7) return "Over " + edgeLabel(e[6], cur);
    return edgeLabel(e[i - 1], cur) + "–" + num(e[i], false);
  }
  function pct(v) {
    if (v == null) return "–";
    if (v <= 0) return "0%";
    if (v < 0.05) return "<0.1%";
    return v.toFixed(1) + "%";
  }
  function people(n) {
    if (n == null) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e7) return Math.round(n / 1e6) + "M";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e4) return Math.round(n / 1e3) + "K";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }
  function peopleLong(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " billion";
    if (n >= 1e6) return (n >= 1e7 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)) + " million";
    return Math.round(n).toLocaleString("en-US");
  }
  function niceDate(iso) {
    var d = new Date(iso + "T00:00:00Z");
    if (isNaN(d)) return iso || "an unknown date";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
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

  function below(d, amount, ctx) {
    var f = factor(d, ctx);
    return f == null ? null : cdf(d, amount / f);
  }
  function median(d, ctx) {
    var f = factor(d, ctx);
    return f == null ? null : d.med * f;
  }
  function average(d, ctx) {
    var f = factor(d, ctx);
    return f == null || d.avg == null ? null : d.avg * f;
  }
  function population(d) { return d.p; }

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
  // Another country measured against the selected country's cut points.
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

  /* -------------------------------------------------------- stacked bar -- */
  function stack(target, sh, labelMin) {
    target.textContent = "";
    sh.forEach(function (v, i) {
      if (v < 0.5) return;
      var seg = el("i", "seg s" + (i + 1));
      seg.style.setProperty("--v", v.toFixed(3));
      seg.dataset.i = i;
      if (v >= labelMin) seg.appendChild(el("b", null, Math.round(v) + "%"));
      target.appendChild(seg);
    });
  }

  /* ------------------------------------------------------------- header -- */
  function moneyWords(ctx) { return ctx === "usd" ? "today's US dollars" : "price-adjusted dollars"; }
  function renderHero() {
    var ctx = state.money, e = EDGES[state.unit];
    $("nCountries").textContent = LIST.length;
    $("worldCap").textContent = "Income per person " + U().per + ", in " + moneyWords(ctx);
    var key = $("key");
    key.textContent = "";
    for (var i = 0; i < 8; i++) {
      var li = el("li");
      li.appendChild(el("span", "sw s" + (i + 1)));
      li.appendChild(el("span", "k-l", bracketLabel(i, e, "USD")));
      key.appendChild(li);
    }
    renderHowto(ctx, e);
    $("fxNote").textContent = ctx === "usd"
      ? "Exchange rates from " + niceDate(RATES.date) + ". Survey incomes are brought to " + (META.priceYear || "this year's") + " prices first."
      : "International dollars at " + META.pppYear + " prices: $1 buys what it bought in the United States in " + META.pppYear + ".";
    document.querySelectorAll("[data-unit]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.unit === state.unit)); });
    document.querySelectorAll("[data-money]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.money === state.money)); });
  }

  // "How to read this page": one country's bar, what each colour means, and two real countries side by side.
  function renderHowto(ctx, e) {
    var name = $("howName");
    name.textContent = "";
    name.appendChild(flag(biggest));
    name.appendChild(document.createTextNode(biggest.n));
    stack($("howBar"), shares(biggest, ctx, e) || [], 101);
    $("howRed").textContent = "Under " + edgeLabel(e[2], "USD") + " " + U().per;
    $("howAmber").textContent = edgeLabel(e[2], "USD") + " to " + num(e[3], false);
    $("howGrey").textContent = "Over " + edgeLabel(e[3], "USD");
    var big = LIST.filter(function (d) { return d.p > 3e7 && median(d, ctx) != null; });
    big.sort(function (a, b) { return median(a, ctx) - median(b, ctx); });
    var box = $("howPair");
    box.textContent = "";
    if (big.length < 2) return;
    [big[0], big[big.length - 1]].forEach(function (d) {
      var row = el("span", "howto-row"), name = el("span", "howto-name");
      name.appendChild(flag(d));
      name.appendChild(document.createTextNode(d.n));
      var bar = el("span", "stack");
      stack(bar, shares(d, ctx, e), 101);
      row.appendChild(name);
      row.appendChild(bar);
      box.appendChild(row);
    });
  }

  function renderNotes() {
    $("noteIntl").textContent = "international dollars at " + META.pppYear + " prices";
    var src = $("noteSource");
    src.textContent = "";
    var a = el("a", null, "World Bank Poverty and Inequality Platform");
    a.href = "https://pip.worldbank.org/"; a.target = "_blank"; a.rel = "noopener";
    src.appendChild(a);
    src.appendChild(document.createTextNode(", " + (META.release ? "edition " + META.release : "latest edition") +
      (META.interim ? " as compiled by Our World in Data" : "") + ", fetched " + niceDate(META.generated) + "."));
    $("noteInfl").textContent = META.inflationSource || "IMF";
    $("noteFx").textContent = niceDate(RATES.date);
    var years = LIST.map(function (d) { return d.y; });
    $("noteOldest").textContent = Math.min.apply(null, years);
    $("noteNewest").textContent = Math.max.apply(null, years);
  }

  /* ------------------------------------------------------------ selects -- */
  function fillCountrySelect(sel, withNone) {
    sel.textContent = "";
    if (withNone) sel.appendChild(new Option("Nothing", ""));
    CONTINENTS.forEach(function (g) {
      var members = LIST.filter(function (d) { return d.g === g; }).sort(function (a, b) { return a.n.localeCompare(b.n); });
      if (!members.length) return;
      var og = document.createElement("optgroup");
      og.label = g;
      members.forEach(function (d) { og.appendChild(new Option(d.n, d.c)); });
      sel.appendChild(og);
    });
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
    var t = 0;
    for (var i = from; i < to; i++) t += s[i];
    return t;
  }
  var SORTS = [
    ["name", function () { return "Name, A to Z"; }, function (a, b) { return a.n.localeCompare(b.n); }],
    ["medHigh", function () { return "Median income, highest first"; }, nullsLast(function (d) { return median(d, state.money); }, -1)],
    ["medLow", function () { return "Median income, lowest first"; }, nullsLast(function (d) { return median(d, state.money); }, 1)],
    ["under1", function () { return "Most people under " + edgeLabel(EDGES[state.unit][0], "USD") + " " + U().per; }, nullsLast(function (d) { return shareOf(d, 0, 1); }, -1)],
    ["under4", function () { return "Most people under " + edgeLabel(EDGES[state.unit][3], "USD") + " " + U().per; }, nullsLast(function (d) { return shareOf(d, 0, 4); }, -1)],
    ["over7", function () { return "Most people over " + edgeLabel(EDGES[state.unit][6], "USD") + " " + U().per; }, nullsLast(function (d) { return shareOf(d, 7, 8); }, -1)],
    ["pop", function () { return "Population, largest first"; }, function (a, b) { return (b.p || 0) - (a.p || 0); }],
    ["year", function () { return "Newest survey first"; }, function (a, b) { return b.y - a.y; }]
  ];
  function fillSort() {
    var sel = $("sort");
    sel.textContent = "";
    SORTS.forEach(function (s) { sel.appendChild(new Option(s[1](), s[0])); });
    sel.value = state.sort;
  }

  /* -------------------------------------------------------------- sheet -- */
  function comparison(d) { return state.cmp && state.cmp !== d.c ? byCode[state.cmp] : null; }

  function renderSheet() {
    var d = byCode[state.sel], c = comparison(d), ctx = sheetCtx(d), cur = curOf(d, ctx);
    $("pick").value = d.c;
    $("cmp").value = state.cmp;
    var h2 = $("sheetName");
    h2.textContent = "";
    h2.appendChild(flag(d));
    h2.appendChild(document.createTextNode(d.n));

    var meta = d.y + " survey · measured by " + (d.w === "income" ? "income" : "household spending");
    if (d.u) meta += " · urban areas only";
    $("sheetMeta").textContent = meta;

    var prices = $("sheetPrices"), fUsd = factor(d, "usd");
    prices.hidden = !(fUsd && META.usInflation && d.c !== "USA");
    if (!prices.hidden) {
      var reach = META.usInflation / fUsd;   // what $1 spent here buys, counted in US prices
      prices.textContent = reach > 1.05 ? "Prices are lower here: $1 buys about what " + symbol("USD") + reach.toFixed(2) + " buys in the United States."
        : reach < 0.95 ? "Prices are higher here: $1 buys about what " + symbol("USD") + reach.toFixed(2) + " buys in the United States."
        : "Prices here are close to those in the United States.";
    }

    // currency switch
    var box = $("sheetCur"), showSwitch = canLocal(d);
    box.hidden = !showSwitch;
    if (showSwitch) {
      $("cur-global").textContent = state.money === "usd" ? "US dollars" : "Price-adjusted dollars";
      $("cur-local").textContent = currencyName(d.cur) + " (" + symbol(d.cur).trim() + ")";
      $("cur-global").setAttribute("aria-pressed", String(ctx !== "local"));
      $("cur-local").setAttribute("aria-pressed", String(ctx === "local"));
    }

    var notes = [];
    if (state.money === "usd" && !hasMoney(d)) {
      notes.push("There is no dependable exchange rate or inflation record for " + d.n + ", so its figures stay in price-adjusted dollars.");
    }
    if (d.y < (META.priceYear || 2026) - 10) {
      notes.push("The newest survey is from " + d.y + ". Incomes there have likely changed a lot since.");
    }
    var cav = $("caveat");
    cav.hidden = !notes.length;
    cav.textContent = notes.join(" ");

    var tiles = $("tiles");
    tiles.textContent = "";
    function tile(label, value, unit, note) {
      var t = el("div", "tile");
      t.appendChild(el("dt", null, label));
      var dd = el("dd", null, value);
      if (unit) { dd.appendChild(document.createTextNode(" ")); dd.appendChild(el("small", null, unit)); }
      t.appendChild(dd);
      if (note) t.appendChild(el("span", "t-note", note));
      tiles.appendChild(t);
    }
    var e = edgesFor(d, ctx), sh = shares(d, ctx, e);
    renderSay(d, ctx, cur, e, sh);
    tile("Median income", money(median(d, ctx), cur), U().per, "Half the people live on less");
    tile("Average income", money(average(d, ctx), cur), U().per, "If all income were shared equally");
    if (d.ds) tile("Richest tenth's share", d.ds[9].toFixed(1) + "%", "", "of all income");
    else tile(bracketLabel(0, e, cur) + " " + U().per, pct(sh[0]), "", "of people");
    var pop = population(d);
    if (pop) tile("Population", peopleLong(pop), "", "people in " + d.y);

    renderFig1(d, c, ctx, cur, e, sh);
    renderFig2(d, c, ctx, cur);
  }

  /* ----------------------------------------------------------- headline -- */
  // One plain sentence on top of each country, so nobody has to add percentages up.
  function placeName(d) {
    return /Republic|Islands|^(United|Netherlands|Philippines|Gambia|Maldives|Bahamas|Comoros|Seychelles)/.test(d.n) ? "the " + d.n : d.n;
  }
  function howMany(f) {
    if (f >= 0.95) return "Almost everyone";
    if (f >= 0.73 && f < 0.775) return "3 in 4 people";
    return Math.round(f * 10) + " in 10 people";
  }
  // Poorer places: the lowest line that at least 7 in 10 people live under.
  // Richer places (most people above the fifth line): the highest line at least 7 in 10 live above.
  function renderSay(d, ctx, cur, e, sh) {
    var box = $("say");
    box.hidden = !sh;
    if (!sh) return;
    var cum = [], run = 0;
    for (var k = 0; k < 7; k++) { run += sh[k] / 100; cum.push(run); }
    var rich = cum[4] < 0.5, at = -1, i;
    if (rich) { for (i = 6; i >= 0; i--) if (1 - cum[i] >= 0.7) { at = i; break; } }
    else { for (i = 0; i < 7; i++) if (cum[i] >= 0.7) { at = i; break; } }
    var mid = 7;
    for (i = 0; i < 7; i++) if (cum[i] >= 0.5) { mid = i; break; }
    box.style.setProperty("--say", "var(--b" + (mid + 1) + ")");

    var med = median(d, ctx), place = placeName(d), parts = [];
    var half = "Half of " + place + " lives on less than " + money(med, cur) + " " + U().per;
    if (at < 0) {
      $("sayMain").textContent = half + ".";
    } else {
      var f = rich ? 1 - cum[at] : cum[at], who = howMany(f);
      $("sayMain").textContent = who + " in " + place + " (" + Math.floor(f * 100) + "%) " + (who === "Almost everyone" ? "lives" : "live") +
        " on " + (rich ? "more" : "less") + " than " + edgeLabel(e[at], cur) + " " + U().per + ".";
      var pop = population(d);
      if (pop) parts.push("That's " + peopleLong(pop * f) + " people.");
      if (med != null) parts.push(half + ".");
    }
    parts.push("Shown in " + unitWords(ctx, d) + ".");
    $("saySub").textContent = parts.join(" ");
  }

  function chartAxis(chart, n, labelFn) {
    var row = el("div", "crow axis"), ax = el("span", "c-axis");
    for (var k = 0; k <= n; k++) {
      var t = el("i", null, labelFn(k));
      t.style.left = (k / n * 100) + "%";
      ax.appendChild(t);
    }
    row.appendChild(ax);
    chart.appendChild(row);
  }
  function legendPair(box, a, b, ramp) {
    box.textContent = "";
    box.hidden = !b;
    if (!b) return;
    var s1 = el("span"); s1.appendChild(el("i", "lg-bar" + (ramp ? " ramp" : ""))); s1.appendChild(document.createTextNode(a)); box.appendChild(s1);
    var s2 = el("span"); s2.appendChild(el("i", "lg-tick")); s2.appendChild(document.createTextNode(b)); box.appendChild(s2);
  }
  function unitWords(ctx, d) {
    return ctx === "local" ? currencyName(d.cur) : ctx === "usd" ? "today's US dollars" : "price-adjusted dollars";
  }

  // The income brackets as rungs of a ladder, richest at the top. A run of two or more rungs at
  // either end holding under 1% of this country's people folds into one, so the eye goes to where
  // the people are. A comparison's mark on a folded rung shows its combined share.
  function rungs(sh, csh, e, cur) {
    function tiny(i) { return sh[i] < 1; }
    function sum(arr, a, b) { if (!arr) return null; var t = 0; for (var i = a; i <= b; i++) t += arr[i]; return t; }
    var lo = 0, hi = 7, out = [];
    while (lo < 7 && tiny(lo)) lo++;
    while (hi > lo && tiny(hi)) hi--;
    if (lo < 2) lo = 0;
    if (hi > 5) hi = 7;
    if (lo > 0) out.push({ color: lo, v: sum(sh, 0, lo - 1), cv: sum(csh, 0, lo - 1), label: "Under " + edgeLabel(e[lo - 1], cur) });
    for (var i = lo; i <= hi; i++) out.push({ color: i + 1, v: sh[i], cv: csh ? csh[i] : null, label: bracketLabel(i, e, cur) });
    if (hi < 7) out.push({ color: hi + 2, v: sum(sh, hi + 1, 7), cv: sum(csh, hi + 1, 7), label: "Over " + edgeLabel(e[hi], cur) });
    return out.reverse();
  }

  var fig1 = null;   // what the first chart is showing, for its tooltip
  function renderFig1(d, c, ctx, cur, e, sh) {
    var csh = c ? sharesAgainst(c, d, ctx, e) : null, list = rungs(sh, csh, e, cur);
    fig1 = { d: d, c: csh ? c : null, rungs: list, cur: cur, ctx: ctx };
    $("fig1Sub").textContent = "Richest at the top, poorest at the bottom. Income per person " + U().per + ", in " + unitWords(ctx, d);
    legendPair($("fig1Legend"), d.n, csh ? c.n : null, true);
    var note = $("fig1Note");
    note.hidden = !(c && !csh);
    if (c && !csh) note.textContent = c.n + " has no dependable exchange rate, so it can't be marked in this currency. Switch to price-adjusted dollars to compare.";

    var max = Math.max.apply(null, list.map(function (r) { return Math.max(r.v, r.cv || 0); }));
    var step = max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : 20;
    var dom = Math.min(100, Math.ceil(max / step) * step) || step;
    var n = Math.round(dom / step);
    var pop = population(d);

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
      if (pop && r.v > 0) val.appendChild(el("small", null, people(pop * r.v / 100) + " people"));
      row.appendChild(val);
      chart.appendChild(row);
    });
    chartAxis(chart, n, function (k) { return (k * step) + "%"; });

    var wrap = $("fig1Table");
    wrap.textContent = "";
    var tbl = el("table"), thead = el("thead"), hr = el("tr");
    ["Income " + U().per, d.n, "People"].concat(csh ? [c.n] : []).forEach(function (h) { hr.appendChild(el("th", null, h)); });
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

  function niceStep(max, target) {
    var raw = max / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
  }
  function tickMoney(x, step, cur) {
    if (x === 0) return symbol(cur) + "0";
    if (x >= 10000 && compact) return symbol(cur) + compact.format(x);
    if (step < 1) return symbol(cur) + x.toFixed(2);
    if (step % 1 !== 0) return symbol(cur) + x.toFixed(1);
    return symbol(cur) + Math.round(x).toLocaleString("en-US");
  }
  // Average income of each tenth, in the display currency per day.
  function tenths(d, f) { return d.ds.map(function (s) { return s * d.avg / 10 * f; }); }

  var fig2 = null;
  function renderFig2(d, c, ctx, cur) {
    var chart = $("fig2Chart"), note = $("fig2Note"), wrap = $("fig2Table"), lg = $("fig2Legend");
    chart.textContent = ""; wrap.textContent = ""; lg.textContent = "";
    fig2 = null;
    $("fig2Sub").textContent = "Average income per person " + U().per + " in each tenth, poorest to richest";
    var f = factor(d, ctx);
    if (!d.ds || d.avg == null || f == null) {
      $("fig2Toggle").hidden = true; lg.hidden = true; chart.hidden = true; wrap.hidden = true;
      note.textContent = "This survey doesn't publish a breakdown by tenths.";
      return;
    }
    $("fig2Toggle").hidden = false;
    var mine = tenths(d, f), theirs = null;
    if (c && c.ds && c.avg != null) {
      var cf = ctx === "ppp" ? 1 : factor(c, "usd");
      if (cf != null) theirs = tenths(c, ctx === "local" ? cf * RATES.rates[d.cur] : cf);
    }
    fig2 = { d: d, c: theirs ? c : null, mine: mine, theirs: theirs, cur: cur };
    legendPair(lg, d.n, theirs ? c.n : null);

    var m = U().mult;
    var max = Math.max.apply(null, mine.concat(theirs || [])) * m;
    var step = niceStep(max, 4);
    var n = Math.max(1, Math.ceil(max / step - 1e-9));
    var dom = n * step;
    chart.style.setProperty("--n", n);
    mine.forEach(function (v, i) {
      var row = el("div", "crow");
      row.dataset.i = i;
      row.appendChild(el("span", "c-label", DECILES[i]));
      var track = el("span", "c-track");
      var bar = el("i", "c-bar solo"); bar.style.width = (v * m / dom * 100) + "%"; track.appendChild(bar);
      if (theirs) { var tk = el("i", "c-tick"); tk.style.left = (theirs[i] * m / dom * 100) + "%"; track.appendChild(tk); }
      row.appendChild(track);
      var val = el("span", "c-val");
      val.appendChild(el("b", null, money(v, cur)));
      val.appendChild(el("small", null, d.ds[i].toFixed(1) + "% of income"));
      row.appendChild(val);
      chart.appendChild(row);
    });
    chartAxis(chart, n, function (k) { return tickMoney(k * step, step, cur); });

    var parts = [];
    if (d.gini != null) parts.push("Gini index " + d.gini.toFixed(2) + " (0 means everyone has the same, 1 means one person has it all).");
    if (c && !theirs) parts.push(c.n + " has no breakdown by tenths in this currency, so it isn't marked here.");
    note.textContent = parts.join(" ");

    var tbl = el("table"), thead = el("thead"), hr = el("tr");
    ["Tenth of the population", "Average " + U().per, "Share of all income"].concat(theirs ? [c.n + ", average"] : []).forEach(function (h) { hr.appendChild(el("th", null, h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = el("tbody");
    mine.forEach(function (v, i) {
      var tr = el("tr");
      tr.appendChild(el("th", null, DECILES[i]));
      tr.appendChild(el("td", null, money(v, cur)));
      tr.appendChild(el("td", null, d.ds[i].toFixed(1) + "%"));
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
    btn.textContent = on ? "Chart" : "Table";
  }

  /* ------------------------------------------------------------- ledger -- */
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var list = LIST.filter(function (d) {
      if (state.region !== "all" && d.g !== state.region) return false;
      return !q || d.n.toLowerCase().indexOf(q) !== -1;
    });
    var cmp = SORTS.filter(function (s) { return s[0] === state.sort; })[0][2];
    list.sort(function (a, b) { return cmp(a, b) || a.n.localeCompare(b.n); });
    return list;
  }
  function yearText(d) { return String(d.y); }

  function rowButton(d) {
    var ctx = state.money, sh = ledger.sh[d.c], med = median(d, ctx);
    var btn = el("button", "row");
    btn.type = "button";
    btn.dataset.c = d.c;
    btn.setAttribute("aria-pressed", String(d.c === state.sel));
    btn.setAttribute("aria-label", d.n + ", surveyed " + d.y +
      (med != null ? ", median " + money(med, "USD") + " " + U().per : "") + ". Show details.");
    var name = el("span", "r-name");
    name.appendChild(flag(d));
    name.appendChild(document.createTextNode(d.n));
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
      btn.appendChild(el("span", "r-none", "No dependable exchange rate. See it in price-adjusted dollars."));
    }
    return btn;
  }

  function renderLedger() {
    var ctx = state.money;
    ledger.e = EDGES[state.unit];
    ledger.sh = {};
    LIST.forEach(function (d) { ledger.sh[d.c] = shares(d, ctx, ledger.e); });

    var list = visibleRows();
    var total = state.region === "all" ? LIST.length : LIST.filter(function (d) { return d.g === state.region; }).length;
    $("count").textContent = (list.length === total ? "All " + total : list.length + " of " + total) +
      " countries. Select a row to open it.";
    $("colMed").textContent = "Median / " + U().word;
    $("ledgerTitle").textContent = state.region === "all" ? "Every country" : state.region;

    var empty = $("empty");
    empty.hidden = list.length > 0;
    if (!list.length) empty.textContent = "No match for “" + state.q.trim() + "” here. Check the spelling, or switch “Part of the world” back to all countries.";

    $("barsView").hidden = state.view !== "bars";
    $("numView").hidden = state.view !== "num";
    var all = list;

    if (state.view === "bars") {
      var ul = $("rows");
      ul.textContent = "";
      var frag = document.createDocumentFragment();
      all.forEach(function (d) {
        var li = el("li");
        li.appendChild(rowButton(d));
        frag.appendChild(li);
      });
      ul.appendChild(frag);
    } else {
      var wrap = $("numView");
      wrap.textContent = "";
      var tbl = el("table", "num"), thead = el("thead"), hr = el("tr");
      hr.appendChild(el("th", null, "Country"));
      hr.appendChild(el("th", null, "Survey"));
      hr.appendChild(el("th", null, "Median / " + U().word));
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
        var th = el("th");
        th.appendChild(flag(d));
        th.appendChild(document.createTextNode(d.n));
        tr.appendChild(th);
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
  }
  function select(code, fromList) {
    if (!byCode[code]) return;
    state.sel = code;
    remember();
    renderSheet();
    markSelection();
    if (fromList && window.matchMedia("(max-width: 979px)").matches) {
      var smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      $("sheet").scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    }
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
    var pop = population(d);
    tipRows(d.n, yearText(d), sh.map(function (v, i) {
      return { color: i + 1, value: pct(v), label: bracketLabel(i, ledger.e, "USD"), extra: pop && v > 0 ? people(pop * v / 100) : "", cls: hot == null ? null : hot === i ? "on" : "dim" };
    }));
    return true;
  }

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
    var a = fig1, r = a.rungs[i], pop = population(a.d);
    var rows = [{ color: r.color, value: pct(r.v), label: a.d.n, extra: pop && r.v > 0 ? people(pop * r.v / 100) + " people" : "" }];
    if (a.c) {
      var cpop = population(a.c);
      rows.push({ tick: true, value: pct(r.cv), label: a.c.n, extra: cpop && r.cv > 0 ? people(cpop * r.cv / 100) + " people" : "" });
    }
    tipRows(r.label, U().per, rows);
  });
  chartTip("fig2Chart", function (i) {
    if (!fig2) return false;
    var rows = [{ color: "solo", value: money(fig2.mine[i], fig2.cur), label: fig2.d.n, extra: fig2.d.ds[i].toFixed(1) + "% of income" }];
    if (fig2.c) rows.push({ tick: true, value: money(fig2.theirs[i], fig2.cur), label: fig2.c.n, extra: fig2.c.ds[i].toFixed(1) + "% of income" });
    tipRows(DECILES[i], "average " + U().per, rows);
  });
  window.addEventListener("scroll", hideTip, { passive: true });

  /* -------------------------------------------------------------- theme -- */
  // Auto follows the device. A choice is kept in localStorage and applied before the page paints
  // (the small script in <head>); this only keeps the buttons in step.
  function applyTheme(t) {
    var root = document.documentElement;
    if (t === "light" || t === "dark") root.dataset.theme = t; else delete root.dataset.theme;
    document.querySelectorAll("[data-theme-pick]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.themePick === (root.dataset.theme || "auto")));
    });
  }
  applyTheme(document.documentElement.dataset.theme || "auto");
  document.querySelectorAll("[data-theme-pick]").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = b.dataset.themePick;
      try { if (t === "auto") localStorage.removeItem("gil:theme"); else localStorage.setItem("gil:theme", t); } catch (e) { /* storage unavailable */ }
      applyTheme(t);
    });
  });

  /* ------------------------------------------------------------- events -- */
  document.querySelectorAll("[data-unit]").forEach(function (b) {
    b.addEventListener("click", function () { state.unit = b.dataset.unit; remember(); renderAll(); });
  });
  document.querySelectorAll("[data-money]").forEach(function (b) {
    b.addEventListener("click", function () { state.money = b.dataset.money; remember(); renderAll(); });
  });
  document.querySelectorAll("[data-local]").forEach(function (b) {
    b.addEventListener("click", function () { state.local = b.dataset.local === "1"; remember(); renderSheet(); });
  });
  document.querySelectorAll("[data-view]").forEach(function (b) {
    b.addEventListener("click", function () {
      state.view = b.dataset.view;
      document.querySelectorAll("[data-view]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
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

  function renderAll() {
    renderHero();
    renderNotes();
    fillSort();
    renderSheet();
    renderLedger();
  }

  /* --------------------------------------------------------- live rates -- */
  // The page ships with the rates in data/rates.js and replaces them with today's when it can.
  function applyRates(fresh) {
    RATES = { date: fresh.date, rates: Object.assign({}, RATES.rates, fresh.rates, { USD: 1 }) };
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
  fillCountrySelect($("pick"), false);
  fillCountrySelect($("cmp"), true);
  renderAll();
  refreshRates();
})();
