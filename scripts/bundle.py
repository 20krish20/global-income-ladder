#!/usr/bin/env python3
"""Pack the whole site into one self-contained HTML file (handy for emailing or embedding).

    python3 scripts/bundle.py                 # writes dist/global-income-ladder.html
    python3 scripts/bundle.py --fragment      # body-only version for hosts that add their own <html> wrapper

The normal site (index.html + css + js + data) does not need this step.
"""
import argparse
import base64
import json
import re

from common import ROOT, log


def main():
    parser = argparse.ArgumentParser(description="Pack the site into a single HTML file.")
    parser.add_argument("--fragment", action="store_true", help="omit <html>/<head>/<body> wrappers")
    parser.add_argument("--out", default=None, help="output path")
    args = parser.parse_args()

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    title = re.search(r"<title>.*?</title>", html, flags=re.S).group(0)
    fonts = re.search(r'<link rel="stylesheet" href="https://fonts[^>]+>', html).group(0)
    fonts += "\n" + re.search(r'<script id="theme-boot">.*?</script>', html, flags=re.S).group(0)
    page = html.split("<!-- page:start -->")[1].split("<!-- page:end -->")[0].strip()
    css = (ROOT / "css/styles.css").read_text(encoding="utf-8")
    # Flags normally load one by one from flags/; here they ride along inline (about 1.2 MB).
    flags = {f.stem.upper(): "data:image/svg+xml;base64," + base64.b64encode(f.read_bytes()).decode("ascii")
             for f in sorted((ROOT / "flags").glob("*.svg"))}
    scripts = [f"<script>window.GIL_FLAGS = {json.dumps(flags, separators=(',', ':'))};</script>"]
    # Earlier surveys normally load on demand from data/history.js; here they ride along too.
    history = (ROOT / "data/history.js").read_text(encoding="utf-8")
    if "</script" in history.lower():
        raise SystemExit("data/history.js contains a closing script tag and cannot be inlined")
    scripts.append(f"<script>\n{history}</script>")
    for src in re.findall(r'<script src="([^"]+)"></script>', html):
        code = (ROOT / src).read_text(encoding="utf-8")
        if "</script" in code.lower():
            raise SystemExit(f"{src} contains a closing script tag and cannot be inlined")
        scripts.append(f"<script>\n{code}</script>")

    body = "\n".join([f"<style>\n{css}</style>", page] + scripts)
    if args.fragment:
        out_text = f"{title}\n{fonts}\n{body}\n"
    else:
        out_text = ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
                    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
                    f"{title}\n{fonts}\n</head>\n<body>\n{body}\n</body>\n</html>\n")

    out = ROOT / (args.out or ("dist/global-income-ladder.fragment.html" if args.fragment else "dist/global-income-ladder.html"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(out_text, encoding="utf-8")
    shown = out.relative_to(ROOT) if ROOT in out.parents else out
    log(f"Wrote {shown} ({len(out_text.encode('utf-8')) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
