#!/usr/bin/env python3
"""List every piece of English text the page shows, and check each translation in js/i18n.js.

    python3 scripts/i18n_check.py                 # report missing or broken translations
    python3 scripts/i18n_check.py --keys out.json # also write all the English keys, for translators

Text is found in index.html (elements marked data-i18n, attributes named in data-i18n-attr) and in
js/app.js (the first string passed to t(), tNode() or result(), and the fixed lists of words).
A translation is "broken" when its {placeholders} differ from the English.
"""
import argparse
import json
import re
from html.parser import HTMLParser

from common import ROOT, log

LANGS = ["hi", "es", "fr", "pt"]
STRING = r'"((?:[^"\\]|\\.)*)"'


class Marked(HTMLParser):
    """Collect the text of elements with data-i18n, and attributes named in data-i18n-attr."""

    def __init__(self):
        super().__init__()
        self.keys, self.stack = [], []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for name in (a.get("data-i18n-attr") or "").split(","):
            if name and a.get(name):
                self.keys.append(a[name])
        if tag in ("br", "img", "input", "meta", "link"):
            return
        self.stack.append([tag, "data-i18n" in a, ""])

    def handle_endtag(self, tag):
        while self.stack:
            name, marked, text = self.stack.pop()
            if marked and text.strip():
                self.keys.append(" ".join(text.split()))
            if self.stack:
                self.stack[-1][2] += text
            if name == tag:
                break

    def handle_data(self, data):
        if self.stack:
            self.stack[-1][2] += data


def unescape(s):
    return json.loads('"' + s + '"')


def keys_from_js(js):
    keys = [unescape(m) for m in re.findall(r"\b(?:t|tNode|result)\(\s*" + STRING, js)]
    # the headline sentences, kept in one object
    block = re.search(r"var main = t\(\{(.*?)\}\[", js, flags=re.S)
    if block:
        keys += [unescape(m) for m in re.findall(r'"[^"|]+\|[^"]+":\s*' + STRING, block.group(1))]
    for name in ("DECILES", "CONTINENTS"):
        m = re.search(r"var " + name + r" = \[(.*?)\];", js, flags=re.S)
        keys += [unescape(s) for s in re.findall(STRING, m.group(1))]
    units = re.search(r"var UNITS = \{(.*?)\};", js, flags=re.S).group(1)
    keys += [unescape(s) for s in re.findall(r'(?:per|word): ' + STRING, units)]
    return keys


def placeholders(s):
    return sorted(set(re.findall(r"\{\w+\}", s)))


def main():
    parser = argparse.ArgumentParser(description="Check the page's translations.")
    parser.add_argument("--keys", help="write every English key to this JSON file")
    args = parser.parse_args()

    html = Marked()
    html.feed((ROOT / "index.html").read_text(encoding="utf-8"))
    found = html.keys + keys_from_js((ROOT / "js/app.js").read_text(encoding="utf-8"))
    keys = list(dict.fromkeys(k for k in found if k.strip()))
    log(f"{len(keys)} pieces of English text on the page")
    if args.keys:
        with open(args.keys, "w", encoding="utf-8") as f:
            json.dump(keys, f, ensure_ascii=False, indent=1)
        log(f"Wrote {args.keys}")

    text = (ROOT / "js/i18n.js").read_text(encoding="utf-8")
    problems = 0
    for lang in LANGS:
        m = re.search(r"GIL_I18N\." + lang + r" = (\{.*?\n\});", text, flags=re.S)
        if not m:
            log(f"{lang}: no translation yet")
            continue
        table = json.loads(m.group(1))
        missing = [k for k in keys if k not in table]
        broken = [k for k in keys if k in table and placeholders(k) != placeholders(table[k])]
        unused = [k for k in table if k not in keys]
        problems += len(missing) + len(broken)
        log(f"{lang}: {len(table)} entries, {len(missing)} missing, {len(broken)} with wrong placeholders, {len(unused)} no longer used")
        for k in missing[:20]:
            log(f"   missing: {k}")
        for k in broken[:20]:
            log(f"   placeholders differ: {k}")
    raise SystemExit(1 if problems else 0)


if __name__ == "__main__":
    main()
