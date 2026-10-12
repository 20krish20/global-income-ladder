#!/usr/bin/env python3
"""Add a version stamp to every local file the pages load: js/app.js -> js/app.js?v=3f9a1c2e.

    python3 scripts/stamp.py

The stamp is taken from the file's contents, so it changes exactly when the file does. Browsers
(and GitHub Pages, which tells them to keep files for 10 minutes) then always fetch a matching
set: never a new page with an old script, which leaves the page blank. Run after changing any
script, stylesheet or data file; update_data.py and update_rates.py run it for you.
"""
import hashlib
import re

from common import ROOT, log

PAGES = ["index.html", "teach.html"]
REF = re.compile(r'(\s(?:src|href)=")((?:css|js|data)/[^"?#]+\.(?:css|js))(?:\?v=[0-9a-f]+)?(")')


def stamp_pages():
    changed = 0
    for page in PAGES:
        path = ROOT / page
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")

        def stamped(m):
            target = ROOT / m.group(2)
            if not target.exists():
                return m.group(0)
            digest = hashlib.sha256(target.read_bytes()).hexdigest()[:8]
            return f"{m.group(1)}{m.group(2)}?v={digest}{m.group(3)}"

        new = REF.sub(stamped, text)
        if new != text:
            path.write_text(new, encoding="utf-8")
            changed += 1
    log(f"Version stamps: {changed} page(s) updated" if changed else "Version stamps: already current")


if __name__ == "__main__":
    stamp_pages()
