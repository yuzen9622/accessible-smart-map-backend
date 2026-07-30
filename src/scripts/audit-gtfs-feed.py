#!/usr/bin/env python3
"""Measure a GTFS feed's service coverage and gate a rebuild on regressions.

gtfs-validator answers "is this file legal GTFS?". It cannot answer the question
that has actually broken this deployment: "did the new feed lose service the old
one had?" A feed whose bus routes all lost their trips is perfectly legal GTFS —
and unroutable. This script measures coverage and refuses a swap that would drop
it.

Two modes:

  audit-gtfs-feed.py FEED.zip [--json OUT.json]
      Print (and optionally save) the coverage metrics for one feed.

  audit-gtfs-feed.py NEW.zip --baseline OLD.zip|OLD.json
      Compare against the currently deployed feed and exit non-zero if any
      dimension regressed past the tolerance. This is the gate.
"""

import argparse
import collections
import csv
import io
import json
import re
import sys
import zipfile
from datetime import date

# A dimension may shrink this much before it counts as a regression. Real feeds
# breathe week to week (services expire, operators drop runs); the failures this
# guards against are cliffs, not drift.
DEFAULT_TOLERANCE = 0.20

# A city/agency below this many routes-with-service is too small for a
# percentage to mean anything; only a drop to zero is reported for those.
SMALL_GROUP = 5

# A route carrying fewer than this many trips a day is servable on paper only —
# OTP will board it, but the wait makes it useless in a plan. Counting routes
# above this line is what separates "the backfill produced something" from "the
# backfill produced usable service"; Tainan showed 308 routes with service whose
# median was 1 trip a day.
USABLE_TRIPS_PER_DAY = 6


def read_rows(zf, name):
    """Stream a GTFS table as dicts, tolerating a UTF-8 BOM."""
    with zf.open(name) as fh:
        yield from csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig"))


def city_of(route_id):
    """Leading alphabetic run of a TDX route_id — its operator/city scope."""
    m = re.match(r"^([A-Za-z]+)", route_id)
    return m.group(1) if m else "?"


def provenance_of(trip_id):
    """Which backfill channel produced this trip, per patch_gtfs's trip_id prefixes."""
    if trip_id.startswith("freqpatched_"):
        return "frequency_template"
    if trip_id.startswith("patched_"):
        return "tdx_timetable"
    return "upstream"


def measure(path, on_date):
    """Collect the coverage metrics that decide whether a feed is servable."""
    zf = zipfile.ZipFile(path)
    names = set(zf.namelist())

    route_type, route_agency = {}, {}
    for r in read_rows(zf, "routes.txt"):
        route_type[r["route_id"]] = r.get("route_type", "")
        route_agency[r["route_id"]] = r.get("agency_id", "") or "?"

    trips_per_route = collections.Counter()
    total_trips = 0
    backfill = collections.Counter()
    for r in read_rows(zf, "trips.txt"):
        trips_per_route[r["route_id"]] += 1
        total_trips += 1
        backfill[provenance_of(r["trip_id"])] += 1

    # bus_live counts routes OTP can board at all; bus_usable counts the ones it
    # can board often enough to matter. Both are needed: a backfill channel can
    # regress from "usable service" to "one trip a day" without changing _live_.
    bus_live = collections.Counter()
    bus_usable = collections.Counter()
    bus_total = collections.Counter()
    rail_trips = collections.Counter()
    rail_live = collections.Counter()
    for rid, rtype in route_type.items():
        trips = trips_per_route.get(rid, 0)
        if rtype == "3":
            bus_total[city_of(rid)] += 1
            if trips:
                bus_live[city_of(rid)] += 1
            if trips >= USABLE_TRIPS_PER_DAY:
                bus_usable[city_of(rid)] += 1
        else:
            rail_trips[route_agency[rid]] += trips
            if trips:
                rail_live[route_agency[rid]] += 1

    active_services = 0
    if "calendar.txt" in names:
        stamp = on_date.strftime("%Y%m%d")
        for r in read_rows(zf, "calendar.txt"):
            if r["start_date"] <= stamp <= r["end_date"]:
                active_services += 1

    stops = wheelchair_stops = 0
    for r in read_rows(zf, "stops.txt"):
        stops += 1
        if r.get("wheelchair_boarding") == "1":
            wheelchair_stops += 1

    def row_count(name):
        if name not in names:
            return 0
        with zf.open(name) as fh:
            return max(sum(1 for _ in fh) - 1, 0)

    return {
        "date": on_date.isoformat(),
        "total_trips": total_trips,
        "active_services": active_services,
        "stops": stops,
        "wheelchair_stops": wheelchair_stops,
        "pathways": row_count("pathways.txt"),
        "levels": row_count("levels.txt"),
        "frequencies": row_count("frequencies.txt"),
        "bus_routes_total": dict(bus_total),
        "bus_routes_live": dict(bus_live),
        "bus_routes_usable": dict(bus_usable),
        "usable_threshold": USABLE_TRIPS_PER_DAY,
        "backfill": dict(backfill),
        "rail_trips": dict(rail_trips),
        "rail_routes_live": dict(rail_live),
    }


def report(m):
    """Print a human-readable summary of one feed's metrics."""
    live = sum(m["bus_routes_live"].values())
    usable = sum(m["bus_routes_usable"].values())
    total = sum(m["bus_routes_total"].values())
    thr = m["usable_threshold"]
    print(f"trips={m['total_trips']:,}  services_active_on_{m['date']}={m['active_services']:,}")
    print(f"stops={m['stops']:,} (wheelchair_boarding=1: {m['wheelchair_stops']:,})")
    print(f"pathways={m['pathways']:,}  levels={m['levels']:,}  frequencies={m['frequencies']:,}")
    print(f"backfill channels: {m['backfill']}")
    print(f"bus routes={total:,}  with service={live:,} ({live * 100 // max(total, 1)}%)"
          f"  usable>={thr}/day={usable:,} ({usable * 100 // max(total, 1)}%)")
    print(f"\nbus routes by city (usable = >={thr} trips/day):")
    print(f"  {'city':6s} {'routes':>6s} {'live':>6s} {'usable':>6s} {'live-but-thin':>13s}")
    for city, tot in sorted(m["bus_routes_total"].items(), key=lambda kv: -kv[1]):
        got = m["bus_routes_live"].get(city, 0)
        use = m["bus_routes_usable"].get(city, 0)
        print(f"  {city:6s} {tot:6d} {got:6d} {use:6d} {got - use:13d}")
    print("\nnon-bus trips, by agency:")
    for agency, trips in sorted(m["rail_trips"].items(), key=lambda kv: -kv[1]):
        if trips:
            print(f"  {agency:12s} trips={trips:6d}  routes_with_service={m['rail_routes_live'].get(agency, 0)}")


def compare(new, old, tolerance):
    """Return the list of regressions that should block a graph swap."""
    bad = []

    def check(label, old_v, new_v, small=0):
        if old_v <= 0:
            return
        if new_v == 0:
            bad.append(f"{label}: {old_v} -> 0 (vanished)")
        elif old_v > small and new_v < old_v * (1 - tolerance):
            drop = (old_v - new_v) * 100 // old_v
            bad.append(f"{label}: {old_v} -> {new_v} (-{drop}%)")

    check("total trips", old["total_trips"], new["total_trips"])
    check("services active today", old["active_services"], new["active_services"])
    check("stops", old["stops"], new["stops"])
    check("pathways", old["pathways"], new["pathways"])
    check("levels", old["levels"], new["levels"])

    for city, old_live in old["bus_routes_live"].items():
        check(f"bus with service [{city}]", old_live, new["bus_routes_live"].get(city, 0), SMALL_GROUP)

    for city, old_usable in old.get("bus_routes_usable", {}).items():
        check(f"bus usable [{city}]", old_usable, new["bus_routes_usable"].get(city, 0), SMALL_GROUP)

    # A backfill channel going quiet is the failure that silently guts the feed:
    # patch_gtfs exiting non-zero, or a TDX endpoint moving, leaves legal GTFS
    # with no bus service at all.
    for channel, old_trips in old.get("backfill", {}).items():
        check(f"backfill channel [{channel}]", old_trips, new["backfill"].get(channel, 0), SMALL_GROUP)

    for agency, old_trips in old["rail_trips"].items():
        check(f"trips [{agency}]", old_trips, new["rail_trips"].get(agency, 0), SMALL_GROUP)

    return bad


def load_baseline(path, on_date):
    """A baseline may be a previously saved metrics JSON or another feed zip."""
    if path.endswith(".json"):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return measure(path, on_date)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("feed", help="GTFS zip to measure")
    ap.add_argument("--baseline", help="deployed feed zip or saved metrics json to compare against")
    ap.add_argument("--json", help="write this feed's metrics to a json file")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE,
                    help=f"fractional drop allowed per dimension (default {DEFAULT_TOLERANCE})")
    ap.add_argument("--date", help="date used for calendar coverage (YYYY-MM-DD, default today)")
    args = ap.parse_args()

    on_date = date.fromisoformat(args.date) if args.date else date.today()
    metrics = measure(args.feed, on_date)
    report(metrics)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(metrics, fh, ensure_ascii=False, indent=2)
        print(f"\nmetrics written to {args.json}")

    if not args.baseline:
        return 0

    regressions = compare(metrics, load_baseline(args.baseline, on_date), args.tolerance)
    print(f"\n=== regression check vs {args.baseline} (tolerance {args.tolerance:.0%}) ===")
    if not regressions:
        print("PASS — no dimension regressed")
        return 0
    for line in regressions:
        print(f"  REGRESSION  {line}")
    print(f"FAIL — {len(regressions)} regression(s)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
