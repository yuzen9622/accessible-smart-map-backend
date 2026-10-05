#!/usr/bin/env python3
"""Refuse a GTFS feed whose rail/metro timetables run out too soon.

Rail and metro calendars cover only the window TDX publishes (about 4–8
weeks) and rely on the scheduled rebuild to roll forward. A feed that is
already near its end would be promoted, look healthy, and silently decay to
bus-only routing within days. This gate fails the build instead.

For every agency that owns rail/metro/tram/monorail routes (route_type 0, 1,
2, 5, 7, 12 and the extended 100–199 / 400–499 / 900–999 ranges), it checks
that at least one trip is active during the 7 days starting at today +
--min-days (Asia/Taipei), so weekday-only operators are not misreported.

Operators listed in --require must be present: the TRA and metro injection
steps are fail-soft, so a TDX outage would otherwise promote a graph that has
no TRA trips at all without anyone noticing.

Usage: check-feed-service-window.py <feed.zip> [--min-days 14]
                                    [--require THSR,TRA,TRTC,KRTC,NTMC,TYMC]
Exit 0 when every operator is covered, 1 otherwise (offenders listed).
"""
import argparse
import collections
import csv
import io
import sys
import zipfile
from datetime import datetime, timedelta, timezone

TAIPEI = timezone(timedelta(hours=8))
RAIL_TYPES = {0, 1, 2, 5, 7, 12}
RAIL_RANGES = [(100, 199), (400, 499), (900, 999)]


def is_rail(route_type: str) -> bool:
    try:
        value = int(route_type)
    except ValueError:
        return False
    return value in RAIL_TYPES or any(lo <= value <= hi for lo, hi in RAIL_RANGES)


def rows(zf: zipfile.ZipFile, name: str):
    if name not in zf.namelist():
        return []
    with zf.open(name) as fh:
        return list(csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig")))


def active_on(service_id, day, weekday, calendar, added, removed) -> bool:
    if day in removed.get(service_id, ()):
        return False
    if day in added.get(service_id, ()):
        return True
    cal = calendar.get(service_id)
    return bool(cal) and cal["start_date"] <= day <= cal["end_date"] and cal[weekday] == "1"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("feed")
    parser.add_argument("--min-days", type=int, default=14)
    parser.add_argument("--require", default="THSR,TRA,TRTC,KRTC,NTMC,TYMC")
    args = parser.parse_args()
    required = {a.strip() for a in args.require.split(",") if a.strip()}

    start = datetime.now(TAIPEI) + timedelta(days=args.min_days)
    window = [
        (d.strftime("%Y%m%d"), d.strftime("%A").lower())
        for d in (start + timedelta(days=i) for i in range(7))
    ]
    label = f"{window[0][0]}–{window[-1][0]}"

    with zipfile.ZipFile(args.feed) as zf:
        routes = {r["route_id"]: r for r in rows(zf, "routes.txt")}
        calendar = {r["service_id"]: r for r in rows(zf, "calendar.txt")}
        added = collections.defaultdict(set)
        removed = collections.defaultdict(set)
        for r in rows(zf, "calendar_dates.txt"):
            (added if r["exception_type"] == "1" else removed)[r["service_id"]].add(r["date"])
        trips = collections.Counter()
        active = collections.Counter()
        for trip in rows(zf, "trips.txt"):
            route = routes.get(trip["route_id"])
            if not route or not is_rail(route.get("route_type", "")):
                continue
            agency = route.get("agency_id") or "(none)"
            trips[agency] += 1
            if any(
                active_on(trip["service_id"], day, weekday, calendar, added, removed)
                for day, weekday in window
            ):
                active[agency] += 1

    short = sorted(agency for agency in set(trips) | required if active[agency] == 0)
    for agency in sorted(set(trips) | required):
        print(f"{agency}: {active[agency]}/{trips[agency]} trips active during {label}")
    if short:
        print(f"FAIL: no trips during {label} (from today + {args.min_days}d) for: {', '.join(short)}")
        return 1
    print(f"OK: every rail/metro operator runs during {label}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
