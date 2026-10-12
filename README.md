# Global Income Ladder

A website showing how each country's people are spread across income levels: what share
lives on under $1 a day, $1 to $2, and so on up to over $100, in today's US dollars, in the
country's own currency, or in price-adjusted dollars.

It is a plain static site. No build step, no packages to install.

## See it

Open `index.html` in a browser. That's it.

(In VS Code: right-click `index.html` and choose *Reveal in Finder*, then double-click. Or run
the **Preview site** task and open http://localhost:8000.)

## Get the newest data

```
python3 scripts/update_data.py
```

Takes a few minutes. It downloads the latest World Bank survey release, inflation figures and
today's exchange rates, checks them, and rewrites `data/countries.js` and `data/rates.js`.
If anything fails, your existing files are left alone and the script says what went wrong.
Reload the page afterwards.

Just the exchange rates (seconds):

```
python3 scripts/update_rates.py
```

In VS Code both are under **Terminal > Run Task**.

The page also fetches fresh exchange rates in the visitor's browser each time it loads, so the
dollar figures stay current even between updates. `data/rates.js` is what it starts from.

## Put it online and keep it updating itself

The included workflow publishes the site with GitHub Pages and refreshes it on a schedule:
exchange rates every day, survey data every Monday.

1. Create an empty repository on GitHub (for example `global-income-ladder`).
2. In this folder:
   ```
   git init -b main
   git add .
   git commit -m "Global Income Ladder"
   git remote add origin https://github.com/YOUR-NAME/global-income-ladder.git
   git push -u origin main
   ```
3. On GitHub: **Settings > Pages > Build and deployment > Source: GitHub Actions**.
4. **Actions > Update data and publish > Run workflow** (tick "Also refresh the World Bank
   survey data") for the first run.

The site is then live at `https://YOUR-NAME.github.io/global-income-ladder/`. Any change you
push is published automatically.

## How the numbers are made

For each country the World Bank publishes, from its latest household survey, the share of
people living below any income level, in *international dollars* (dollars adjusted so that $1
buys the same everywhere). `update_data.py` asks about 30 levels from $0.50 to $700 a day,
which traces the country's whole income curve. The page reads brackets off that curve.

To show money rather than price-adjusted dollars:

```
local currency today = international dollars x PPP x inflation
US dollars today     = local currency today / exchange rate
```

- **PPP**: local currency per international dollar in the survey's price year (World Bank).
- **inflation**: local consumer prices now relative to that year (World Bank consumer price index;
  the IMF's GDP deflator carries it from the last published year to this one).
- **exchange rate**: today's market rate.

So "today's US dollars" means: the living standard measured in the survey, at today's prices,
converted at today's exchange rate. It is re-priced, not re-surveyed. Pay rises since the
survey year are not included.

A country is shown in price-adjusted dollars only (no money conversion) when the pieces don't
fit together, for example where the official exchange rate is far from what people can
actually trade at. The script lists these each time it runs.

There is **no world total**: countries were surveyed in different years (1992 to 2025), and adding them up would mix those years into one misleading number.

## What's where

| | |
|---|---|
| `index.html` | the page. Also serves `?embed=IND` (a card for other websites) and `?present=IND,BDI&guess=1` (classroom slides) |
| `teach.html` | lesson plan, worksheet and slide builder for teachers |
| `css/styles.css` | layout and colours (light and dark) |
| `js/app.js` | everything the page does |
| `js/i18n.js` | translations (Hindi, Spanish, French, Portuguese), keyed by the English text |
| `data/countries.js` | generated: each country's income curve, price figures and its World Bank estimate for last year |
| `data/history.js` | generated: every earlier comparable survey; loaded only when a country is opened |
| `data/rates.js` | generated: exchange rates |
| `data/map.js` | generated once by `scripts/build_map.py`: country shapes for the map |
| `flags/` | one flag per country, generated once by `scripts/build_flags.py` |
| `scripts/i18n_check.py` | lists the page's text and checks each translation for gaps |
| `scripts/stamp.py` | adds version stamps to script and stylesheet addresses, so visitors never get a stale mix. Run after editing css/js/data |
| `scripts/update_data.py` | fetches survey data, inflation and rates |
| `scripts/update_rates.py` | fetches exchange rates only |
| `scripts/countries.py` | country names, continents and currencies. Edit when a country changes currency. |
| `scripts/bundle.py` | optional: packs the site into one HTML file |
| `.github/workflows/update.yml` | the scheduled update and publish |

## Sources

- World Bank, [Poverty and Inequality Platform](https://pip.worldbank.org/)
- World Bank, World Development Indicators (consumer price inflation)
- IMF, World Economic Outlook (GDP deflator, via the World Bank PIP team's mirror)
- Exchange rates: [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api)
