"""Shared helpers for the update scripts. Standard library only, so nothing needs installing."""
import datetime
import gzip
import json
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / ".cache"
USER_AGENT = "global-income-ladder/1.0 (data refresh script)"

# A country's price level relative to the United States (1 = same prices as the US).
# Outside this range the exchange rate or the price data can't be trusted for a conversion.
PRICE_LEVEL_RANGE = (0.15, 2.0)


def log(msg=""):
    print(msg, flush=True)


def today():
    return datetime.date.today().isoformat()


def _curl(url, timeout):
    out = subprocess.run(
        ["curl", "-sS", "-L", "--fail", "--compressed", "-m", str(int(timeout)), "-A", USER_AGENT, url],
        capture_output=True, check=False)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode("utf-8", "replace").strip() or f"curl exited with {out.returncode}")
    return out.stdout


def http_get(url, timeout=240, retries=3):
    """Download a URL and return its bytes. Retries, and falls back to curl if Python's own
    networking fails (a common cause on macOS is a Python without root certificates)."""
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT, "Accept": "application/json, text/csv, */*", "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                if resp.headers.get("Content-Encoding", "").lower() == "gzip" or body[:2] == b"\x1f\x8b":
                    body = gzip.decompress(body)
                return body
        except urllib.error.HTTPError as err:
            last = err
            if 400 <= err.code < 500 and err.code not in (408, 429):
                break
        except Exception as err:  # timeouts, DNS, TLS certificates, connection resets
            last = err
        if shutil.which("curl"):
            try:
                return _curl(url, timeout)
            except Exception as err:
                last = err
        if attempt < retries:
            time.sleep(3 * attempt)
    raise RuntimeError(f"Could not download {url}\n  reason: {last}")


def write_js(path, variable, payload, banner):
    """Write data as a small script file, so the site also works when opened straight from disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = f"/* {banner} */\nwindow.{variable} = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def read_js(path):
    """Read back a file written by write_js. Returns None if it doesn't exist."""
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    start = text.index("=", text.index("window.")) + 1
    return json.loads(text[start:].strip().rstrip(";"))


def sig(value, digits=6):
    """Round to significant digits, keeping the file small without losing meaning."""
    return None if value is None else float(f"{value:.{digits}g}")


def price_factors(code, currency, ppp, inflation, us_inflation, rates, legacy_units):
    """Decide whether a country's figures can be turned into money at today's exchange rate.

    ppp        local currency per international dollar in the base year
    inflation  local prices today relative to the base year
    Returns (ppp, note). ppp is None when no dependable conversion exists; note says why or what was fixed.
    """
    if not currency:
        return None, "no currency on file (add it to scripts/countries.py)"
    if not ppp or ppp <= 0:
        return None, "no price-level (PPP) figure"
    if not inflation or inflation <= 0:
        return None, "no inflation figures"
    rate = rates.get(currency)
    if not rate or rate <= 0:
        return None, f"no exchange rate for {currency}"
    lo, hi = PRICE_LEVEL_RANGE
    note = None
    if code in legacy_units:
        ppp = ppp / legacy_units[code]
        note = "price figure converted from the country's previous currency unit"
    level = ppp * inflation / rate / us_inflation
    if not (lo <= level <= hi):
        return None, (f"implied price level is {level:.3g} times the US level, outside {lo}-{hi} "
                      f"(PPP {ppp:.4g}, inflation x{inflation:.4g}, {rate:.6g} {currency} per US$)")
    return ppp, note
