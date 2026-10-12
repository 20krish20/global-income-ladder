#!/usr/bin/env python3
"""Copy a flag for every country on the site into flags/<iso3>.svg (lower case, e.g. flags/ago.svg).

The page loads each flag lazily as an <img>, so only the flags on screen are fetched.
`bundle.py` inlines them for the one-file build.

Flags change rarely, so this is run by hand, not by the update workflow. It needs two npm packages,
unpacked anywhere (`npm pack flag-icons i18n-iso-countries`, then untar):

    python3 scripts/build_flags.py --flags <flag-icons>/package/flags/4x3 --codes <i18n-iso-countries>/package/codes.json

Flag artwork: flag-icons by Panayiotis Lipiridis, MIT licence (https://github.com/lipis/flag-icons).
"""
import argparse
import json
import re
from pathlib import Path

from common import ROOT, log
from countries import COUNTRIES

# Codes the World Bank uses that are not in ISO 3166-1.
EXTRA = {"XKX": "xk"}


def minify(svg):
    svg = re.sub(r"<\?xml.*?\?>|<!--.*?-->", "", svg, flags=re.S)
    svg = re.sub(r'\sid="flag-icons-[^"]*"', "", svg)
    svg = re.sub(r">\s+<", "><", svg)
    return re.sub(r"\s+", " ", svg).strip()


def main():
    parser = argparse.ArgumentParser(description="Copy flag-icons SVGs into flags/.")
    parser.add_argument("--flags", required=True, help="flag-icons flags/4x3 folder")
    parser.add_argument("--codes", required=True, help="i18n-iso-countries codes.json")
    args = parser.parse_args()

    iso2 = {row[1]: row[0].lower() for row in json.loads(Path(args.codes).read_text(encoding="utf-8"))}
    iso2.update(EXTRA)
    out = ROOT / "flags"
    out.mkdir(exist_ok=True)
    done, missing, size = 0, [], 0
    for code in sorted(COUNTRIES):
        src = Path(args.flags) / f"{iso2.get(code, '?')}.svg"
        if not src.is_file():
            missing.append(code)
            continue
        dest = out / f"{code.lower()}.svg"
        dest.write_text(minify(src.read_text(encoding="utf-8")) + "\n", encoding="utf-8")
        done += 1
        size += dest.stat().st_size
    if missing:
        log("No flag for: " + ", ".join(missing))
    log(f"Wrote {done} flags to flags/ ({size / 1024:.0f} KB in all; each loads only when on screen)")


if __name__ == "__main__":
    main()
