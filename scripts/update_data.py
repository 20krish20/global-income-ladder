#!/usr/bin/env python3
"""Refresh data/countries.js with the newest World Bank household-survey data.

    python3 scripts/update_data.py            # normal run (reuses downloads under 12 hours old)
    python3 scripts/update_data.py --force    # download everything again
    python3 scripts/update_data.py --offline  # rebuild from the last downloads, no network

What it does
  1. Asks the World Bank's Poverty and Inequality Platform (PIP) what share of each country's
     people live below each of ~30 income levels. Together those points trace the country's
     whole income distribution, so the site can cut it at any amount, in any currency.
  2. Keeps each country's most recent survey.
  3. Adds what is needed to express those incomes as money today: the survey's price-level
     figure (PPP), consumer-price inflation since then, and today's exchange rate.
  4. Writes data/countries.js and data/rates.js. Nothing is overwritten if a step fails.

Takes a few minutes. Needs only Python 3.8+; no packages to install.
"""
import argparse
import csv
import datetime
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from common import CACHE_DIR, DATA_DIR, http_get, log, price_factors, read_js, sig, today, write_js
from countries import COUNTRIES, LEGACY_UNITS, REGION_TO_CONTINENT
import update_rates

PIP_URL = os.environ.get("GIL_PIP_URL", "https://api.worldbank.org/pip/v1")
# Consumer-price inflation, percent a year (World Bank World Development Indicators).
CPI_URL = os.environ.get("GIL_CPI_URL", "https://api.worldbank.org/v2/country/all/indicator/FP.CPI.TOTL.ZG")
# The IMF's GDP deflator with forecasts, mirrored by the World Bank's PIP team. Carries prices
# from the last published consumer-price year to this year, and stands in where there is no CPI.
DEFLATOR_URL = os.environ.get(
    "GIL_DEFLATOR_URL", "https://raw.githubusercontent.com/PIP-Technical-Team/aux_weo/DEV/weo.csv")
# The PIP team's table of price levels, for the few surveys the main service returns without one.
PPP_URL = os.environ.get(
    "GIL_PPP_URL", "https://raw.githubusercontent.com/PIP-Technical-Team/aux_ppp/DEV/ppp.csv")

# Income levels to ask about, in international dollars per person per day.
# Roughly even steps on a log scale, and including the World Bank's own poverty lines.
LINES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4.2, 5, 6, 7, 8.3, 10, 12, 15, 18, 22, 27, 33, 40,
         50, 60, 75, 90, 110, 140, 180, 250, 450, 700]

DEFAULT_PPP_YEAR = 2021
CACHE_HOURS = 12
KEEP = ("country_code", "country_name", "region_code", "reporting_year", "reporting_level", "welfare_type",
        "headcount", "mean", "median", "gini", "ppp", "reporting_pop", "survey_acronym", "is_interpolated",
        "decile1", "decile2", "decile3", "decile4", "decile5", "decile6", "decile7", "decile8", "decile9", "decile10")
# The IMF uses its own codes for a few economies.
IMF_CODES = {"XKX": "UVK", "PSE": "WBG"}


# ---------------------------------------------------------------- downloads --
def cached(path, offline, force):
    if not path.exists():
        return False
    if offline:
        return True
    return not force and (time.time() - path.stat().st_mtime) < CACHE_HOURS * 3600


def fetch_line(line, offline, force):
    """Every survey's share of people living below `line` dollars a day."""
    path = CACHE_DIR / "pip" / f"povline_{line:g}.json"
    if cached(path, offline, force):
        return json.loads(path.read_text(encoding="utf-8"))
    if offline:
        raise RuntimeError(f"--offline was given but {path.name} has not been downloaded yet")
    url = f"{PIP_URL}/pip?country=all&year=all&povline={line:g}&fill_gaps=false&format=json"
    rows = json.loads(http_get(url))
    if not isinstance(rows, list) or len(rows) < 300 or "headcount" not in rows[0]:
        raise RuntimeError(f"The World Bank returned something unexpected for the ${line:g} line: {str(rows)[:200]}")
    slim = [{k: r.get(k) for k in KEEP} for r in rows]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(slim, separators=(",", ":")), encoding="utf-8")
    return slim


def fetch_release(offline):
    """Which edition of the data this is, and the price year its dollars are expressed in."""
    path = CACHE_DIR / "pip" / "versions.json"
    try:
        if not cached(path, offline, False) and not offline:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(http_get(f"{PIP_URL}/versions?format=json", timeout=60))
        versions = json.loads(path.read_text(encoding="utf-8"))
        newest = versions[0]
        return str(newest.get("release_version") or newest.get("version")), int(newest.get("ppp_version"))
    except Exception as err:
        log(f"  (could not read the edition name, assuming {DEFAULT_PPP_YEAR} prices: {err})")
        return "latest", DEFAULT_PPP_YEAR


def fetch_cpi(offline, force, first_year, last_year):
    """Consumer-price inflation, percent a year: {country code: {year: percent}}."""
    path = CACHE_DIR / "cpi_inflation.json"
    if not cached(path, offline, force):
        if offline:
            return {}
        table, page, pages = {}, 1, 1
        while page <= pages:
            raw = json.loads(http_get(f"{CPI_URL}?date={first_year}:{last_year}&format=json&per_page=20000&page={page}", timeout=120))
            if not isinstance(raw, list) or len(raw) < 2 or not isinstance(raw[1], list):
                raise RuntimeError(f"unexpected response shape: {str(raw)[:160]}")
            pages = int(raw[0].get("pages", 1))
            for row in raw[1]:
                code, value = row.get("countryiso3code"), row.get("value")
                if code and isinstance(value, (int, float)):
                    table.setdefault(code, {})[str(row.get("date"))] = value
            page += 1
        if "USA" not in table:
            raise RuntimeError("the response has no figures for the United States")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(table, separators=(",", ":")), encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


def fetch_ppp_table(offline, force, ppp_year):
    """National price levels (local currency per international dollar) by country code."""
    path = CACHE_DIR / "ppp_table.csv"
    if not cached(path, offline, force):
        if offline:
            return {}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(http_get(PPP_URL, timeout=120))
    out = {}
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    for row in csv.DictReader(io.StringIO(text)):
        if row.get("CoverageType") != "National":
            continue
        columns = sorted(k for k in row if k and k.startswith(f"ppp_{ppp_year}_"))
        for column in reversed(columns):          # newest revision first
            try:
                out[row["code"]] = float(row[column])
                break
            except (ValueError, TypeError):
                continue
    return out


def fetch_deflators(offline, force):
    """Backup price index: the IMF's GDP deflator as mirrored by the World Bank's PIP team."""
    path = CACHE_DIR / "imf_deflator.csv"
    if not cached(path, offline, force):
        if offline:
            return {}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(http_get(DEFLATOR_URL, timeout=120))
    out = {}
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    for row in csv.DictReader(io.StringIO(text)):
        if row.get("WEO Subject Code") != "NGDP_D":
            continue
        series = {}
        for key, value in row.items():
            if key and key.isdigit():
                try:
                    series[int(key)] = float(value.replace(",", ""))
                except (ValueError, AttributeError):
                    pass
        out[row.get("ISO")] = series
    return out


# --------------------------------------------------------------- inflation --
def inflation_for(code, cpi, deflators, base_year, price_year):
    """Local prices in price_year relative to base_year. Returns (factor or None, how it was worked out).

    Consumer prices are used as far as they are published; the GDP deflator (which includes
    forecasts) covers the remaining year or two. Where there is no consumer-price series, the
    deflator is used on its own.
    """
    deflator = deflators.get(IMF_CODES.get(code, code)) or deflators.get(code) or {}
    series = cpi.get(code) or {}
    factor, through = 1.0, base_year
    for year in range(base_year + 1, price_year + 1):
        value = series.get(str(year))
        if not isinstance(value, (int, float)):
            break
        factor *= 1 + value / 100
        through = year
    if through == price_year:
        return factor, "consumer prices"
    if through > base_year and deflator.get(through, 0) > 0 and deflator.get(price_year, 0) > 0:
        return factor * deflator[price_year] / deflator[through], f"consumer prices to {through}, GDP deflator after"
    if through >= price_year - 1:
        return factor, f"consumer prices to {through}"
    if deflator.get(base_year, 0) > 0 and deflator.get(price_year, 0) > 0:
        return deflator[price_year] / deflator[base_year], "GDP deflator"
    return None, "no inflation figures"


def price_level(code, survey, rows, ppp_table):
    """Local currency per international dollar for a survey. The service leaves it blank where a
    national figure was combined from urban and rural ones (China), so look further for those."""
    if isinstance(survey.get("ppp"), (int, float)) and survey["ppp"] > 0:
        return survey["ppp"]
    if ppp_table.get(code, 0) > 0:
        return ppp_table[code]
    parts = [r for r in rows
             if r["country_code"] == code and r["reporting_year"] == survey["reporting_year"]
             and r.get("reporting_level") in ("urban", "rural")
             and isinstance(r.get("ppp"), (int, float)) and isinstance(r.get("reporting_pop"), (int, float))]
    people = sum(r["reporting_pop"] for r in parts)
    if len(parts) >= 2 and people > 0:
        return sum(r["ppp"] * r["reporting_pop"] for r in parts) / people
    return None


# ------------------------------------------------------------------ build --
def choose_surveys(rows):
    """One survey per country: national coverage if it exists, then the newest year,
    then spending-based over income-based when a year has both."""
    best = {}
    for r in rows:
        if r.get("headcount") is None or r.get("median") is None or r.get("is_interpolated"):
            continue
        level = r.get("reporting_level")
        rank = (2 if level == "national" else 1 if level == "urban" else 0,
                int(r["reporting_year"]),
                1 if r.get("welfare_type") == "consumption" else 0)
        code = r["country_code"]
        if code not in best or rank > best[code][0]:
            best[code] = (rank, r)
    return {code: r for code, (_, r) in best.items()}


def survey_key(r):
    return (r["country_code"], int(r["reporting_year"]), r.get("reporting_level"), r.get("welfare_type"))


def build(by_line, release, ppp_year, cpi, deflators, ppp_table, rates):
    price_year = datetime.date.today().year
    lines = sorted(by_line)
    middle = by_line[lines[len(lines) // 2]]
    chosen = choose_surveys(middle)
    wanted = {survey_key(r) for r in chosen.values()}
    shares = {}  # survey -> {line: share below}
    for line, rows in by_line.items():
        for r in rows:
            key = survey_key(r)
            if key in wanted and isinstance(r.get("headcount"), (int, float)):
                shares.setdefault(key, {})[line] = float(r["headcount"])

    us_inflation, _ = inflation_for("USA", cpi, deflators, ppp_year, price_year)
    if not us_inflation:
        raise RuntimeError("No US inflation figures, so nothing can be priced in today's dollars")

    countries, problems, methods = [], [], {}
    for code, r in sorted(chosen.items()):
        points = sorted(shares.get(survey_key(r), {}).items())
        if len(points) < len(lines) // 2:
            problems.append(f"{code}: skipped, only {len(points)} of {len(lines)} income levels came back")
            continue
        xs, fs, top = [], [], 0.0
        for x, f in points:
            top = max(top, min(1.0, max(0.0, f)))   # shares can only rise with the income level
            xs.append(x)
            fs.append(round(top, 5))
        while len(fs) > 1 and fs[1] == 0:           # drop the empty stretch at the bottom
            xs.pop(0)
            fs.pop(0)
        while len(fs) > 1 and fs[-2] >= 0.99999:    # and the full stretch at the top
            xs.pop()
            fs.pop()

        if code in COUNTRIES:
            name, continent, currency = COUNTRIES[code]
        else:
            name, continent, currency = r.get("country_name") or code, REGION_TO_CONTINENT.get(r.get("region_code"), "Other"), None
            problems.append(f"{code} ({name}): not listed in scripts/countries.py, so it has no currency or continent")

        inflation, method = inflation_for(code, cpi, deflators, ppp_year, price_year)
        ppp, note = price_factors(code, currency, price_level(code, r, middle, ppp_table), inflation,
                                  us_inflation, rates, LEGACY_UNITS)
        if ppp is None:
            problems.append(f"{name} ({code}): no money conversion; {note}")
        else:
            kind = "GDP deflator" if method == "GDP deflator" else "consumer prices"
            methods[kind] = methods.get(kind, 0) + 1
        deciles = [r.get(f"decile{i}") for i in range(1, 11)]
        countries.append({
            "c": code, "n": name, "g": continent,
            "y": int(r["reporting_year"]),
            "w": r.get("welfare_type"),
            "u": r.get("reporting_level") == "urban",
            "p": round(r["reporting_pop"]) if isinstance(r.get("reporting_pop"), (int, float)) else None,
            "cur": currency if ppp is not None else None,
            "ppp": sig(ppp),
            "infl": sig(inflation, 5) if ppp is not None else None,
            "med": round(float(r["median"]), 3),
            "avg": round(float(r["mean"]), 3) if r.get("mean") is not None else None,
            "gini": round(float(r["gini"]), 3) if r.get("gini") is not None else None,
            "ds": [round(d * 100, 2) for d in deciles] if all(isinstance(d, (int, float)) for d in deciles) else None,
            "x": xs, "F": fs,
        })

    meta = {
        "source": "World Bank Poverty and Inequality Platform",
        "release": release,
        "pppYear": ppp_year,
        "priceYear": price_year,
        "usInflation": sig(us_inflation, 5),
        "inflationSource": ("World Bank consumer price index, carried to this year with the IMF's GDP deflator"
                            if methods.get("consumer prices", 0) >= methods.get("GDP deflator", 0)
                            else "IMF GDP deflator"),
        "generated": today(),
    }
    return {"meta": meta, "countries": countries}, problems, methods


def check(payload):
    """Refuse to publish something obviously broken."""
    countries = payload["countries"]
    if len(countries) < 120:
        raise RuntimeError(f"Only {len(countries)} countries came through; expected about 170")
    for c in countries:
        if any(b < a for a, b in zip(c["F"], c["F"][1:])) or any(b <= a for a, b in zip(c["x"], c["x"][1:])):
            raise RuntimeError(f"{c['n']}: income distribution is not in order")
        if not (0 < c["med"] < 1000):
            raise RuntimeError(f"{c['n']}: implausible median {c['med']}")
    priced = sum(1 for c in countries if c["cur"])
    if priced < len(countries) * 0.75:
        raise RuntimeError(f"Only {priced} of {len(countries)} countries could be priced in today's money")


def main():
    parser = argparse.ArgumentParser(description="Refresh data/countries.js from the World Bank.")
    parser.add_argument("--force", action="store_true", help="download everything again")
    parser.add_argument("--offline", action="store_true", help="rebuild from the last downloads")
    args = parser.parse_args()
    started = time.time()

    log("1/4  World Bank survey data")
    release, ppp_year = fetch_release(args.offline)
    log(f"     edition {release}, dollars at {ppp_year} prices; asking about {len(LINES)} income levels")
    by_line, done = {}, 0

    def one(line):
        try:
            return line, fetch_line(line, args.offline, args.force), None
        except Exception as err:
            return line, None, err

    with ThreadPoolExecutor(max_workers=3) as pool:
        for line, rows, err in pool.map(one, LINES):
            done += 1
            if err is not None:
                log(f"     {done:>2}/{len(LINES)}  below ${line:g} a day: FAILED ({str(err).splitlines()[0]})")
                continue
            by_line[line] = rows
            log(f"     {done:>2}/{len(LINES)}  below ${line:g} a day: {len(rows)} surveys")
    for line in [x for x in LINES if x not in by_line]:      # one more try, on its own this time
        if args.offline:
            break
        log(f"     trying ${line:g} again")
        _, rows, err = one(line)
        if err is None:
            by_line[line] = rows
            log(f"            below ${line:g} a day: {len(rows)} surveys")
        else:
            log(f"            still failing; carrying on without it ({str(err).splitlines()[0][:120]})")
    if len(by_line) < len(LINES) * 2 // 3:
        raise RuntimeError(f"Only {len(by_line)} of {len(LINES)} income levels could be downloaded from the World Bank")

    log("2/4  Prices: inflation since the survey's price year")
    price_year = datetime.date.today().year
    cpi, deflators, ppp_table = {}, {}, {}
    try:
        cpi = fetch_cpi(args.offline, args.force, ppp_year, price_year)
        log(f"     consumer-price inflation for {len(cpi)} economies" if cpi
            else "     no consumer-price figures on hand; using the GDP deflator instead")
    except Exception as err:
        log(f"     consumer prices unavailable ({str(err).splitlines()[0]}); using the GDP deflator instead")
    try:
        deflators = fetch_deflators(args.offline, args.force)
        log(f"     GDP deflator for {len(deflators)} economies")
    except Exception as err:
        log(f"     GDP deflator unavailable ({str(err).splitlines()[0]})")
    if not cpi and not deflators:
        raise RuntimeError("No inflation figures could be downloaded")
    try:
        ppp_table = fetch_ppp_table(args.offline, args.force, ppp_year)
    except Exception as err:
        log(f"     price-level table unavailable ({str(err).splitlines()[0]})")

    log("3/4  Today's exchange rates")
    if args.offline:
        previous = read_js(DATA_DIR / "rates.js")
        if not previous:
            raise RuntimeError("--offline needs an existing data/rates.js")
        all_rates = {"date": previous["date"], "rates": previous["rates"]}
    else:
        all_rates = update_rates.fetch_rates()
    log(f"     rates dated {all_rates['date']}")

    log("4/4  Putting it together")
    payload, problems, methods = build(by_line, release, ppp_year, cpi, deflators, ppp_table, all_rates["rates"])
    check(payload)
    write_js(DATA_DIR / "countries.js", "GIL_DATA", payload,
             "Generated by scripts/update_data.py. Do not edit by hand; run the script again instead.")
    if not args.offline:
        update_rates.write_rates(all_rates)

    countries = payload["countries"]
    years = sorted(c["y"] for c in countries)
    priced = sum(1 for c in countries if c["cur"])
    lines = [
        f"Wrote data/countries.js: {len(countries)} countries, edition {release}, {ppp_year} prices.",
        f"Survey years run {years[0]} to {years[-1]}; half are from {years[len(years) // 2]} or later.",
        f"{priced} countries can be shown in today's US dollars and their own currency; {len(countries) - priced} stay price-adjusted only.",
        "Inflation came from: " + ", ".join(f"{k} ({v} countries)" for k, v in sorted(methods.items())) + ".",
    ]
    if problems:
        lines.append("Notes:")
        lines += ["  " + p for p in problems]
    lines.append(f"Done in {time.time() - started:.0f} seconds. Open index.html to see it.")
    report = "\n".join(lines)
    log("\n" + report)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / "update_report.txt").write_text(report + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("\nStopped. Nothing was changed.")
        sys.exit(130)
    except Exception as err:
        log(f"\nThe data was NOT updated: {err}")
        log("Your existing data files are untouched. Running the script again continues from what was already downloaded.")
        sys.exit(1)
