#!/usr/bin/env python3
"""Write data/map.js: a world map with one ready-to-draw SVG path per country, keyed by ISO alpha-3 code.

The shapes are already projected (Equal Earth) into a box 1000 units wide, so the page only has to
put each path in an <svg viewBox="0 0 w h">. Coordinates are rounded to 0.1 and written as relative
moves to keep the file small. Antarctica is left out.

Borders change rarely, so this is run by hand, not by the update workflow. It needs two npm packages,
unpacked anywhere (`npm pack world-atlas@2.0.2 i18n-iso-countries`, then untar):

    python3 scripts/build_map.py --atlas <world-atlas>/package/countries-110m.json --codes <i18n-iso-countries>/package/codes.json

Map data: world-atlas by Mike Bostock, ISC licence (https://github.com/topojson/world-atlas),
made from Natural Earth (public domain, https://www.naturalearthdata.com).
"""
import argparse
import json
import math
from pathlib import Path

from common import ROOT, log

WIDTH = 1000
SKIP = {"ATA"}
# Features in world-atlas with no ISO numeric id, matched by name instead. Others without one are skipped.
BY_NAME = {"Kosovo": "XKX"}

# Equal Earth projection (Šavrič, Patterson & Jenny 2018).
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2


def equal_earth(lon, lat):
    lam, phi = math.radians(lon), math.radians(lat)
    t = math.asin(M * math.sin(phi))
    t2 = t * t
    t6 = t2 * t2 * t2
    x = 2 * math.sqrt(3) * lam * math.cos(t) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1))
    y = t * (A4 * t6 * t2 + A3 * t6 + A2 * t2 + A1)
    return x, y


def decode_arcs(topo):
    """Turn TopoJSON arcs into lists of (lon, lat), undoing quantization and delta encoding."""
    tr = topo.get("transform")
    arcs = []
    for arc in topo["arcs"]:
        if not tr:
            arcs.append([tuple(p[:2]) for p in arc])
            continue
        (sx, sy), (tx, ty) = tr["scale"], tr["translate"]
        x = y = 0
        pts = []
        for p in arc:
            x += p[0]
            y += p[1]
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def ring(indices, arcs):
    pts = []
    for i in indices:
        arc = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(arc[1:] if pts else arc)
    return pts


def polygons(geom, arcs):
    if geom["type"] == "Polygon":
        return [[ring(r, arcs) for r in geom["arcs"]]]
    if geom["type"] == "MultiPolygon":
        return [[ring(r, arcs) for r in poly] for poly in geom["arcs"]]
    return []


def cut_antimeridian(points):
    """world-atlas leaves a few rings (Fiji, eastern Russia) running across 180 degrees, for a
    spherical renderer to clip. Cut them there instead, so each side closes along the map edge."""
    parts = [[points[0]]]
    for (lon0, lat0), (lon1, lat1) in zip(points, points[1:]):
        if abs(lon1 - lon0) > 180:
            edge = 180 if lon0 > 0 else -180
            lon1u = lon1 + 2 * edge
            span = lon1u - lon0
            lat = lat0 + (lat1 - lat0) * (edge - lon0) / span if span else lat0
            parts[-1].append((edge, lat))
            parts.append([(-edge, lat)])
        parts[-1].append((lon1, lat1))
    if len(parts) > 1:
        # The ring is closed, so its last piece and its first piece are one piece.
        parts[0] = parts.pop() + parts[0][1:]
    return parts


def longest_step(points):
    return max((abs(b[0] - a[0]) for a, b in zip(points, points[1:])), default=0)


def path(rings):
    """SVG path data for rings of integer points (tenths of a unit): M x y, then relative l steps."""
    def num(n):
        return f"{n // 10}" if n % 10 == 0 else f"{n / 10:.1f}"

    def join(nums):
        out = ""
        for s in nums:
            out += s if (not out or s.startswith("-")) else " " + s
        return out

    d = []
    for pts in rings:
        steps = []
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if (x1, y1) != (x0, y0):
                steps += [num(x1 - x0), num(y1 - y0)]
        d.append("M" + join([num(pts[0][0]), num(pts[0][1])]) + "l" + join(steps) + "z")
    return "".join(d)


def main():
    parser = argparse.ArgumentParser(description="Build data/map.js from world-atlas TopoJSON.")
    parser.add_argument("--atlas", required=True, help="world-atlas countries-110m.json")
    parser.add_argument("--codes", required=True, help="i18n-iso-countries codes.json")
    args = parser.parse_args()

    iso3 = {row[2]: row[1] for row in json.loads(Path(args.codes).read_text(encoding="utf-8"))}
    topo = json.loads(Path(args.atlas).read_text(encoding="utf-8"))
    arcs = decode_arcs(topo)

    projected, skipped, cuts = {}, [], 0
    for geom in topo["objects"]["countries"]["geometries"]:
        name = geom.get("properties", {}).get("name", "?")
        code = iso3.get(geom["id"]) if "id" in geom else BY_NAME.get(name)
        if not code:
            skipped.append(name)
            continue
        if code in SKIP:
            continue
        shape = projected.setdefault(code, [])
        for r in (r for poly in polygons(geom, arcs) for r in poly):
            parts = cut_antimeridian(r)
            cuts += len(parts) > 1
            shape.extend([equal_earth(lon, lat) for lon, lat in p] for p in parts if len(p) > 2)

    xs = [x for rings in projected.values() for r in rings for x, _ in r]
    ys = [y for rings in projected.values() for r in rings for _, y in r]
    x0, y1 = min(xs), max(ys)
    k = WIDTH / (max(xs) - x0)
    height = round((y1 - min(ys)) * k, 1)

    shapes, streaks = {}, []
    for code in sorted(projected):
        rings = []
        for r in projected[code]:
            pts = [(round((x - x0) * k * 10), round((y1 - y) * k * 10)) for x, y in r]
            if len(set(pts)) > 2:
                rings.append(pts)
        if any(longest_step(r + r[:1]) > WIDTH * 10 / 2 for r in rings):
            streaks.append(code)
        if rings:
            shapes[code] = path(rings)

    payload = {"w": WIDTH, "h": height, "shapes": shapes}
    out = ROOT / "data/map.js"
    out.write_text("/* Generated by scripts/build_map.py from world-atlas (ISC licence, Natural Earth data). "
                   "Do not edit by hand. */\nwindow.GIL_MAP = "
                   + json.dumps(payload, separators=(",", ":")) + ";\n", encoding="utf-8")
    if skipped:
        log("Skipped (no ISO code): " + ", ".join(skipped))
    log(f"Cut {cuts} ring(s) at the antimeridian")
    if streaks:
        raise SystemExit("Shapes still spanning over half the map: " + ", ".join(streaks))
    log(f"Wrote {len(shapes)} shapes to data/map.js ({out.stat().st_size / 1024:.0f} KB, {WIDTH} x {height})")


if __name__ == "__main__":
    main()
