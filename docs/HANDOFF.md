# Handoff: where this project stands

Written 12 October 2026 at the end of the session that built it. Everything here is either
checked (and says how) or marked as not checked.

## 1. What was asked

1. A website showing countries with their population distribution by income, with percentages.
2. Then: move it into a real project (VS Code), keep it updated and live.
3. Amounts in **US dollars at current prices, updated daily**, as the default.
4. The country panel **must** offer the country's **local currency**.
5. "Make it work first, then we are going to make it a much better website."

## 2. What exists

**The site** (`index.html`, `css/styles.css`, `js/app.js`)

- Masthead: a plain introduction, three switches (money: today's US dollars / price-adjusted
  dollars; time: day / month / year; colours: auto / light / dark), a note with the exchange-rate date.
- Colour key for the eight income brackets, then "How to read this page" in three short steps.
- **No world total** (removed Oct 2026, owner's decision): surveys run from 1992 to 2025, and adding
  countries from different years into one figure is misleading. Each country stands on its own.
- "Every country": 172 rows, each a stacked bar of the eight brackets, with survey year and median.
  Search, continent filter, eight sort orders, and a Bars / Numbers switch (Numbers is a plain table).
- Country panel: country picker, "compare with" picker (another country, or nothing), a switch
  between dollars and the local currency, a one-sentence summary ("3 in 4 people in India live on less
  than $2 a day"), four headline figures, a bracket chart with percentages
  and head counts, a chart of what each tenth of the population lives on, and a table view of each chart.
- Light and dark themes, phone layout, hover and keyboard tooltips, remembers the last view in the browser.
- On load the page fetches fresh exchange rates and re-renders; `data/rates.js` is the fallback.

**The pipeline** (`scripts/`)

- `update_data.py`: downloads survey data, inflation, price levels and exchange rates; validates;
  writes both data files; leaves existing files untouched on failure; caches downloads in `.cache/` for 12 hours.
- `update_rates.py`: exchange rates only.
- `countries.py`: names, continents, currencies for 190-odd economies, written by hand.
- `bundle.py`: packs the site into one HTML file.

**Automation**: `.github/workflows/update.yml` (daily rates, Monday survey data, publish to GitHub Pages)
and `.vscode/tasks.json`. See section 7: neither is installed or tested yet.

**A hosted preview** exists as a private page titled "Global Income Ladder". It is a
one-file bundle of this folder from an earlier version. Its exchange rates are frozen at 12 Oct 2026
because that host blocks the live fetch. It does not update when this folder changes.

## 3. Where the numbers come from

| What | Source | Notes |
|---|---|---|
| Income distributions | World Bank Poverty and Inequality Platform API, `api.worldbank.org/pip/v1/pip?country=all&year=all&povline=X&fill_gaps=false` | edition 20260922, 2021 prices. One request per income level. |
| Price level (PPP) | the `ppp` field of each survey row | blank for China's national row; then the PIP team's table on GitHub (`PIP-Technical-Team/aux_ppp`, branch `DEV`, `ppp.csv`); then a population-weighted urban/rural average |
| Inflation | World Bank indicator `FP.CPI.TOTL.ZG` (consumer prices, % a year) | chained from 2022; the last year or two carried forward with the IMF GDP deflator |
| GDP deflator | IMF World Economic Outlook as mirrored at `PIP-Technical-Team/aux_weo`, branch `DEV`, `weo.csv`, series `NGDP_D` | includes forecasts to 2030 |
| Exchange rates | `fawazahmed0/exchange-api` via jsDelivr, with a `pages.dev` fallback | free, no key, daily |

## 4. How the numbers are made

**Which survey.** One per country: national coverage if any exists, else urban; then the newest
year; then spending-based over income-based if a year has both.

**The curve.** For each of 30 income levels ($0.50 to $700 a day, roughly even on a log scale) the
World Bank returns the share of people below it. Those points are the curve. Between points the
page interpolates linearly in the logarithm of income. Below the first point it assumes the share
falls with the square of income; above the last it assumes a Pareto tail with exponent 2.5.

**Brackets.** Seven cut points give eight brackets. Per day: 1, 2, 5, 10, 20, 50, 100. Per month:
30, 60, 150, 300, 600, 1500, 3000. Per year: 360, 720, 1800, 3600, 7200, 18000, 36000. In local
currency: seven consecutive 1-2-5 steps starting from the round number nearest the first dollar
cut point at today's exchange rate.

**Money.** `local today = international dollars x ppp x infl`, `US dollars today = local / rate`.
`infl` is local prices in 2026 relative to 2021.

**Sanity range.** A country's implied price level relative to the United States must fall between
0.15 and 2.0, or it gets no conversion (`cur: null`). `LEGACY_UNITS` converts price figures still
expressed in a replaced currency unit (Croatia, Bulgaria, Sierra Leone, Mauritania, Belarus).

**"$1 buys what $X buys in the United States."** `meta.usInflation / (US dollars per international dollar)`.

## 5. What was checked, and how

- **Curves against source**: for India, China, United States, Nigeria, Brazil, Indonesia and
  Germany the share below $3 equals the World Bank's figure exactly (it is a grid point). For all
  172 countries the curve puts between 49.1% and 50.9% of people below the published median.
- **Inflation factors** compared with the raw consumer-price series for 14 countries; they agree
  (the factor is the chain times the deflator step for the missing year).
- **Price levels** of all 165 converted countries fall between 0.19 (Ethiopia) and 1.43 (Iceland) times US prices.
- **The page**: rendered in headless Chromium at desktop and phone widths, light and dark, in all
  three money modes, with no script errors and no sideways scrolling. Web fonts could not load
  there, so the real typefaces (Bricolage Grotesque, Public Sans) were never seen.
- **The update script**: exercised against a local stand-in built from real sample responses
  (success, cached, offline and failure paths), then run for real twice by the owner.

## 6. What was not found, failed, or was dropped

- **No way to run the pipeline from the session's own sandbox.** The World Bank is not reachable
  from it, nor from the shell the session had on the owner's Mac. Every real run was the owner's.
- **IMF consumer-price data.** The IMF DataMapper API answered 403 to the script. Dropped in favour
  of the World Bank series. Cost: no official forecast for the current year, hence the deflator step.
- **The $400 income level.** The World Bank returns a timeout error for exactly that request, twice
  with identical timing, so probably a cached error on their side. The script now asks for $450
  instead. **That change has never been run.** Until it is, the curve has a gap between $250 and $700
  that is filled by interpolation. Only the top bracket of low-price countries reaches into it, where
  the shares are fractions of a percent.
- **A GitHub mirror of consumer prices.** `datasets/inflation` stops at 2023 and its "consumer"
  file did not match known consumer-price figures. Not used.
- **Seven countries have no conversion**: Iran (price level 0.122, just under the 0.15 floor),
  South Sudan (0.096), Sudan, Yemen and Venezuela (official exchange rates far from reality),
  Zimbabwe (price figure in US dollars, inflation in Zimbabwean currency), Syria (no inflation data).
- **Nine countries use the GDP deflator alone** because the World Bank has no consumer-price series
  for them: Barbados, Congo (Democratic Republic), Eswatini, Marshall Islands, Myanmar, Nauru, Taiwan,
  Turkmenistan, Tuvalu. The deflator can differ a lot from consumer prices (see section 8).
- **Consumer prices stop before 2025** for Argentina, Gambia, Equatorial Guinea, Qatar and the
  United States (2024) and Micronesia (2022); the deflator carries the rest.
- **World Bank regions** (the first version had "Sub-Saharan Africa" and so on) were dropped. The
  official World Bank world and regional figures are not used anywhere.
- **No history.** One survey per country; nothing over time.

## 7. Still open

1. **Two files are not in the folder.** `.vscode/tasks.json` and `.github/workflows/update.yml`
   could not be written by the session (protected locations). Both folders are empty. The files
   were sent to the owner as attachments.
2. **Going live has not started.** No git repository yet. Steps are in `README.md`.
3. **The workflow has never run.** Treat its first run as a test.
4. **The live exchange-rate fetch in the browser has never been seen to work.** It was blocked
   everywhere the session could look. Open the page with DevTools and confirm the request succeeds.
5. **Run `update_data.py` once more** to exercise the $450 change.
6. **20 countries have surveys from before 2015** (oldest: Trinidad and Tobago 1992, Guyana and
   Turkmenistan 1998). They are shown with a warning in the panel. A same-year estimate for every country exists (the
   World Bank's "lined-up" figures, `fill_gaps=true` in the PIP API); see section 3 before switching.
7. **`countries.py` was written from memory** and not checked against a reference list.

## 8. Trade-offs made on the owner's behalf

- **Market exchange rates as the default**, because that was the request. They make poorer
  countries look poorer than their living standards, since a dollar buys far more there.
  Price-adjusted dollars stayed as the second option for that reason.
- **Re-priced, not re-surveyed.** "Today's dollars" is the living standard in the survey year, at
  today's prices and exchange rate. Growth and pay rises since the survey are not in it.
- **Brackets are read off a 30-point curve**, not requested exactly. Exact at the 30 levels,
  interpolated between. This is what lets currencies and rates change in the browser.
- **Month and year brackets use round numbers** (30 and 360 times the daily cut) while amounts use
  exact conversions (365/12 and 365). So "under $1 a day" and "under $30 a month" differ by a hair.
- **Excluding rather than guessing.** A country outside the sanity range gets no conversion at all.
  The 0.15 floor was a judgment call made after seeing Iran sit alone at 0.12.
- **One price level for all of China**, although the World Bank prices its urban and rural surveys separately.
- **GDP deflator for the final year.** In the first real run, on the deflator alone, Nigeria's
  prices came out at 1.71 times 2021; on consumer prices, 2.71. The deflator is a weak stand-in,
  kept only for the last year and for the nine countries with nothing better.
- **Income and spending surveys sit side by side.** 69 countries report income, 103 spending.
- **Data as `.js` files** so the page opens from disk without a server.
- **No framework, no build, no dependencies**, in the page or the scripts.
- **Third-party pieces with no guarantee**: the free exchange-rate API, and two files read from a
  `DEV` branch of the World Bank PIP team's GitHub repositories. Either could move without notice.
- **Argentina is urban-only**; the World Bank has no national survey for it.

## 9. Assumptions

- "US dollars according to current price (daily update)" means: local inflation to this year, then
  today's market exchange rate. It was not read as US-price-adjusted dollars.
- Income is per person per day, as the World Bank publishes it. A month is 365/12 days.
- "This year's prices" is the calendar year the script runs in.
- Currencies in use today, including Bulgaria on the euro from 2026 and Zimbabwe treated as US dollars.
- Continents roughly follow Our World in Data's grouping (Turkey, Armenia, Azerbaijan, Georgia in Asia; Cyprus in Europe).
- Kosovo and Montenegro use the euro; Palestine the Israeli shekel; Kiribati, Nauru and Tuvalu the Australian dollar.
- The panel opens on the most populous country (India in this data), chosen by rule, not preference.
- Tail shapes: square law at the bottom, Pareto 2.5 at the top.

## 10. Ideas already raised for "a much better website"

History over time per country; a map; World Bank regions back; the official world figures alongside
the bottom-up ones; shareable links to a country; an IMF or national-statistics source for
current-year inflation; replacing the `DEV`-branch files with the PIP API's own auxiliary tables;
tests for `cdf()` and the bracket maths.

## 11. Added in October 2026 (second round)

- **Same-year estimates.** `update_data.py` now also downloads the World Bank's lined-up estimates for
  last year (`fill_gaps=true`, 30 income levels). Each country gets `e` in `countries.js`; 46 economies
  with no survey of their own go in `others` and count only toward world figures. A "Figures from:
  Latest surveys / 2025 estimate" switch shows them. World figures exist only in that view.
  Check: adding up every estimate puts 9.95% of people below $3 a day in 2025, the World Bank's own figure.
  Argentina's estimate is urban only, as the World Bank uses it.
- **History.** `data/history.js` holds every survey comparable with the one shown (same coverage and
  measure), loaded only when a country is opened. Bars show up to eight surveys; a `*` marks a year
  where the survey changed method (the World Bank's `survey_comparability` number changed).
- **$450 income level** now downloads (it failed before). It adds one point at the top of each curve;
  no median changed.
- **Extreme poverty line** ($3.00 a day, 2021 prices): a tile per country, a dashed line on the tenths
  chart, a sort order, and the history sentence. Only shown when `meta.pppYear` is 2021.
- **Who gets the income**: poorest half, middle 40%, richest 10%, straight from the survey's tenths,
  with a note that surveys miss the very rich.
- **Where do I stand?** Household income ÷ people, in local currency or US dollars. Compared with the
  country (its estimate where there is one) and with the world (estimates, in the page's money view).
- **Map** (`data/map.js`, Natural Earth 110m via world-atlas): coloured by the median's bracket. 17 small
  island states are too small to draw. Places with no data are hatched.
- **Share pictures** (1200 x 630, drawn on a canvas, always light), **embeds** (`?embed=IND`) and
  **classroom slides** (`?present=...&guess=1`) plus `teach.html`.
- **Languages**: Hindi, Spanish, French and Portuguese in `js/i18n.js`, machine-made and **not yet
  checked by native speakers**. The site does not pick a language automatically until they are
  (`AUTO_LANG` in `app.js`). Country names come from the browser (`Intl.DisplayNames`).
- Not checked: the share picture with a flag (blocked when the page is opened from disk; should work
  online), and `navigator.share` on a real phone.
