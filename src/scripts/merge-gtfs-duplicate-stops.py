#!/usr/bin/env python3
"""Merge co-located duplicate bus stops in an OTP GTFS feed.

TDX publishes one stop per route at a shared pole, so the national feed has
~156k boarding stops at only ~66k distinct places. Every duplicate is a
separate Raptor stop: access/egress searches hit OTP's 500-stop cap within a
few hundred metres, and each duplicate carries its own transfer list.

A group is merged only when every member
  - is a boarding stop (location_type 0/empty) with no parent station,
  - is served only by bus routes (route_type 3) and by at least one trip,
  - has exactly the same coordinates (7 decimals), stop name and city prefix,
and no route serves two members of the same merged stop (such groups are
split so a trip never visits one stop twice in a row). The member with the
smallest stop_id becomes the merged stop.

stop_times, pathways, stop_areas and stop translations are rewritten. The
alias list maps (route_id, merged stop_id) back to each route's original stop
so the backend can keep returning the route's own TDX StopUID.

Usage: merge-gtfs-duplicate-stops.py FEED.zip ALIASES.json
"""
import csv
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from collections import defaultdict


def read_rows(zf, name):
    if name not in zf.namelist():
        return None, []
    with zf.open(name) as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        return reader.fieldnames, list(reader)


def iter_rows(zf, name):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def city_prefix(stop_id):
    m = re.match(r"[A-Z]+", stop_id)
    return m.group(0) if m else ""


def stop_routes(zf, trip_route):
    """route_ids serving each stop, and stops served by any non-bus route."""
    served = defaultdict(set)
    for st in iter_rows(zf, "stop_times.txt"):
        route = trip_route.get(st["trip_id"])
        if route is not None:
            served[st["stop_id"]].add(route)
    return served


def plan_merge(stops, served, route_type):
    """Map each merged-away stop_id to the stop it merges into."""
    groups = defaultdict(list)
    for s in stops:
        sid = s["stop_id"]
        if s.get("location_type", "") not in ("", "0") or s.get("parent_station"):
            continue
        routes = served.get(sid)
        if not routes or any(route_type.get(r) != "3" for r in routes):
            continue
        key = (
            round(float(s["stop_lat"]), 7),
            round(float(s["stop_lon"]), 7),
            s.get("stop_name", ""),
            city_prefix(sid),
        )
        groups[key].append(sid)

    alias = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        # Split so no route serves two stops that end up merged together.
        parts = []
        for sid in sorted(members):
            for part in parts:
                if not (part["routes"] & served[sid]):
                    part["ids"].append(sid)
                    part["routes"] |= served[sid]
                    break
            else:
                parts.append({"ids": [sid], "routes": set(served[sid])})
        for part in parts:
            keep = part["ids"][0]
            for sid in part["ids"][1:]:
                alias[sid] = keep
    return alias


def rewrite(zip_path, zf, alias):
    removed = set(alias)
    with tempfile.NamedTemporaryFile(dir=os.path.dirname(os.path.abspath(zip_path)),
                                     suffix=".zip", delete=False) as tmp:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
            for name in zf.namelist():
                if name == "stops.txt":
                    fields, rows = read_rows(zf, name)
                    rows = [r for r in rows if r["stop_id"] not in removed]
                    write_csv(out, name, fields, rows)
                elif name == "stop_times.txt":
                    stream_stop_times(zf, out, alias)
                elif name == "pathways.txt":
                    fields, rows = read_rows(zf, name)
                    for r in rows:
                        r["from_stop_id"] = alias.get(r["from_stop_id"], r["from_stop_id"])
                        r["to_stop_id"] = alias.get(r["to_stop_id"], r["to_stop_id"])
                    write_csv(out, name, fields, rows)
                elif name == "stop_areas.txt":
                    fields, rows = read_rows(zf, name)
                    seen, kept = set(), []
                    for r in rows:
                        r["stop_id"] = alias.get(r["stop_id"], r["stop_id"])
                        key = (r.get("area_id"), r["stop_id"])
                        if key not in seen:
                            seen.add(key)
                            kept.append(r)
                    write_csv(out, name, fields, kept)
                elif name == "translations.txt":
                    fields, rows = read_rows(zf, name)
                    rows = [r for r in rows
                            if not (r.get("table_name") == "stops" and r.get("record_id") in removed)]
                    write_csv(out, name, fields, rows)
                else:
                    out.writestr(name, zf.read(name))
        tmp_path = tmp.name
    os.replace(tmp_path, zip_path)


def write_csv(out, name, fields, rows):
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    out.writestr(name, buf.getvalue())


def stream_stop_times(zf, out, alias):
    with zf.open("stop_times.txt") as src, out.open("stop_times.txt", "w") as dst:
        reader = csv.DictReader(io.TextIOWrapper(src, encoding="utf-8-sig"))
        text = io.TextIOWrapper(dst, encoding="utf-8", newline="")
        writer = csv.DictWriter(text, fieldnames=reader.fieldnames, lineterminator="\n")
        writer.writeheader()
        for r in reader:
            r["stop_id"] = alias.get(r["stop_id"], r["stop_id"])
            writer.writerow(r)
        text.flush()
        text.detach()


def main(zip_path, aliases_path):
    with zipfile.ZipFile(zip_path) as zf:
        route_type = {r["route_id"]: r["route_type"] for r in iter_rows(zf, "routes.txt")}
        trip_route = {t["trip_id"]: t["route_id"] for t in iter_rows(zf, "trips.txt")}
        _, stops = read_rows(zf, "stops.txt")
        served = stop_routes(zf, trip_route)
        alias = plan_merge(stops, served, route_type)
        aliases = [
            {"routeId": route, "stopId": keep, "originalStopId": sid}
            for sid, keep in sorted(alias.items())
            for route in sorted(served[sid])
        ]
        if alias:
            rewrite(zip_path, zf, alias)
    with open(aliases_path, "w", encoding="utf-8") as f:
        json.dump(aliases, f, ensure_ascii=False)
    print(f"merged {len(alias)} duplicate bus stops into {len(set(alias.values()))} stops; "
          f"{len(aliases)} route aliases written to {aliases_path}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
