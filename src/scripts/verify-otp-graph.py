#!/usr/bin/env python3
"""Quality gate for an OTP graph, run against a loaded OTP before it serves.

The healthcheck after a rebuild only proves OTP started. Every graph that
actually broke production started fine: bus shapes assigned to the wrong
sub-route (14% of bus patterns drawn as straight lines), a stray zip loaded as
a duplicate feed, a county's buses deleted, rail calendars already expired.
This asks the loaded graph those questions and exits non-zero on any failure,
so build-otp-graph.sh keeps the old graph serving instead of promoting.

  verify-otp-graph.py --otp http://127.0.0.1:18081 [--expect-feeds 1]
                      [--feed NEW.zip --baseline OLD.zip]
  verify-otp-graph.py --feed NEW.zip --feed-only

Checks:
  feeds      exactly --expect-feeds GTFS feeds are loaded (a second one is a
             stray zip ingested as a duplicate network)
  geometry   share of patterns per mode whose geometry has no more points
             than stops (drawn stop-to-stop) stays under the mode's limit
  tra-shape  every TRA stop sequence fits its assigned shape within 500 m
             (requires --feed; independent of the service audit)
  coverage   buses exist in at least --min-bus-cities route_id prefixes
  freshness  every --require rail/metro operator runs trips today
  trips      fixed trips that only make sense by a given mode use it, with
             real leg geometry
  audit      the feed lost no service versus the deployed one
             (audit-gtfs-feed.py; only with --feed and --baseline)

Run it against the serving graph any time: --otp http://127.0.0.1:18080
"""
import argparse
import collections
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import zipfile

from tra_shape_geometry import (
    MAX_STOP_SHAPE_DISTANCE_M,
    find_misaligned_patterns,
    load_tra_geometry,
)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Measured: BUS 1.3%, SUBWAY 5.1%, RAIL 7.9% (2026-10-02; the RAIL share is 99
# cross-line TRA patterns of the native timetable still drawn straight). The
# shape misassignment this guards against measured 14.5% for BUS. FERRY and
# AIRPLANE have no shapes by design and are never routed, so they are ignored.
DEFAULT_GEOMETRY_LIMITS = {"BUS": 5.0, "RAIL": 10.0, "SUBWAY": 10.0}

# label, from, to, wheelchair, any of these modes, agency that must appear,
# leg mode whose geometry must be real (more than this many points)
TRIP_CASES = [
    ("Tianmu→TaipeiMain bus", (25.1176, 121.5316), (25.0478, 121.5170), "false", {"BUS"}, None, ("BUS", 10)),
    ("Nangang→TaipeiMain", (25.0530, 121.6067), (25.0478, 121.5170), "false", {"SUBWAY", "RAIL"}, None, None),
    ("TaipeiMain→Zuoying", (25.0478, 121.5170), (22.6870, 120.3090), "false", {"RAIL"}, "THSR", ("RAIL", 10)),
    ("Taichung→Fengyuan", (24.1372, 120.6869), (24.2541, 120.7234), "false", {"RAIL"}, "TRA", ("RAIL", 10)),
    ("Banqiao→Taipei101 wheelchair", (25.0141, 121.4637), (25.0339, 121.5645), "true", {"SUBWAY"}, None, ("SUBWAY", 10)),
]


def load_probe():
    """Reuse probe-otp-routing.py's GraphQL client and freshness semantics."""
    spec = importlib.util.spec_from_file_location("probe", os.path.join(SCRIPT_DIR, "probe-otp-routing.py"))
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    return probe


def wait_ready(probe, otp, timeout_s):
    """Block until OTP answers GraphQL — it only binds after the graph loads."""
    deadline = time.time() + timeout_s
    while True:
        try:
            body = probe.post(otp, "{ feeds { feedId } }", 10)
            return [f["feedId"] for f in body["data"]["feeds"]]
        except Exception:  # noqa: BLE001
            if time.time() > deadline:
                return None
            time.sleep(10)


def plan_legs(probe, otp, frm, to, wheelchair, date, at, timeout):
    speed = "0.8" if wheelchair == "true" else "1.3"
    tm = ",".join("{mode:%s}" % m for m in probe.MODES.split(","))
    q = ('{ plan(from:{lat:%f,lon:%f}, to:{lat:%f,lon:%f}, date:"%s", time:"%s",'
         ' wheelchair:%s, walkSpeed:%s, numItineraries:8, searchWindow:3600, transportModes:[%s])'
         ' { itineraries{ legs{ mode legGeometry{ length } route{ agency{ gtfsId } } } } } }'
         % (frm[0], frm[1], to[0], to[1], date, at, wheelchair, speed, tm))
    body = probe.post(otp, q, timeout)
    if "errors" in body:
        raise RuntimeError(body["errors"][0].get("message", "graphql error"))
    return [leg for it in body["data"]["plan"]["itineraries"] for leg in it["legs"]]


class Gate:
    def __init__(self):
        self.failures = []

    def check(self, ok, name, detail):
        print(f"{'ok  ' if ok else 'FAIL'} {name}: {detail}")
        if not ok:
            self.failures.append(f"{name}: {detail}")


def check_tra_shapes(gate, feed):
    """Reject wrong-branch or missing TRA geometry, even without a baseline."""
    try:
        with zipfile.ZipFile(feed) as zf:
            coord, patterns, shapes = load_tra_geometry(zf)
        failures = find_misaligned_patterns(coord, patterns, shapes)
    except (OSError, zipfile.BadZipFile, KeyError, ValueError) as exc:
        gate.check(False, "tra-shape", f"cannot validate {feed}: {exc}")
        return
    gate.check(not failures, "tra-shape",
               f"{len(failures)}/{len(patterns)} TRA patterns exceed "
               f"{MAX_STOP_SHAPE_DISTANCE_M:g} m or have missing geometry/stops")
    for key, stop, distance in failures:
        print(f"  shape={key[0] or '(missing)'} trip={patterns[key][0]} "
              f"stop={stop or '(missing)'} distance={distance:.0f} m "
              f"({len(patterns[key])} trips)")


def report_result(gate):
    print(f"RESULT {'PASS' if not gate.failures else 'FAIL'} ({len(gate.failures)} failures)")
    for failure in gate.failures:
        print(f"  - {failure}")
    return 1 if gate.failures else 0


def check_geometry(gate, probe, otp, limits, timeout):
    body = probe.post(otp, "{ patterns { patternGeometry { length } stops { gtfsId } route { mode } } }", timeout)
    total, straight = collections.Counter(), collections.Counter()
    for p in body["data"]["patterns"]:
        mode = p["route"]["mode"]
        total[mode] += 1
        if ((p["patternGeometry"] or {}).get("length") or 0) <= len(p["stops"]):
            straight[mode] += 1
    for mode in sorted(total):
        pct = straight[mode] / total[mode] * 100
        detail = f"{mode} {straight[mode]}/{total[mode]} patterns drawn stop-to-stop ({pct:.1f}%)"
        if mode in limits:
            gate.check(pct <= limits[mode], "geometry", f"{detail}, limit {limits[mode]:.1f}%")
        else:
            print(f"info geometry: {detail}, not gated")
    for mode in limits:
        if mode not in total:
            gate.check(False, "geometry", f"no {mode} patterns at all")


def check_bus_coverage(gate, probe, otp, min_cities, timeout):
    body = probe.post(otp, "{ routes(transportModes:[BUS]) { gtfsId } }", timeout)
    prefixes = collections.Counter()
    for r in body["data"]["routes"]:
        local = r["gtfsId"].split(":", 1)[-1]
        m = re.match(r"^([A-Za-z]+)", local)
        prefixes[m.group(1) if m else "?"] += 1
    gate.check(len(prefixes) >= min_cities, "coverage",
               f"{sum(prefixes.values())} bus routes in {len(prefixes)} prefixes (need >= {min_cities}): "
               + " ".join(f"{k}={v}" for k, v in sorted(prefixes.items())))


def check_freshness(gate, probe, otp, required, ymd, timeout):
    body = probe.post(otp, '{ routes(transportModes:[RAIL,SUBWAY,TRAM,MONORAIL]) { agency { gtfsId }'
                           ' patterns { tripsForDate(serviceDate:"%s") { gtfsId } } } }' % ymd, timeout)
    trips = collections.Counter()
    for route in body["data"]["routes"]:
        agency = route["agency"]["gtfsId"].split(":", 1)[-1]
        trips[agency] += sum(len(p["tripsForDate"]) for p in route["patterns"])
    for agency in required:
        n = trips.get(agency, 0)
        if n == 0:
            # tripsForDate omits headway (frequencies.txt) trips.
            recount = probe.post(otp, '{ agency(id:"1:%s") { routes { patterns { trips { activeDates } } } } }'
                                 % agency, timeout)
            data = (recount.get("data") or {}).get("agency") or {}
            n = sum(1 for r in data.get("routes", []) for p in r["patterns"]
                    for t in p["trips"] if ymd in t["activeDates"])
        gate.check(n > 0, "freshness", f"{agency} runs {n} trips on {ymd}")


def check_trips(gate, probe, otp, date, at, timeout):
    for label, frm, to, wheelchair, want_modes, want_agency, geom in TRIP_CASES:
        try:
            legs = plan_legs(probe, otp, frm, to, wheelchair, date, at, timeout)
        except Exception as e:  # noqa: BLE001
            gate.check(False, "trip", f"{label}: request failed: {e}")
            continue
        modes = {leg["mode"] for leg in legs}
        agencies = {(((leg.get("route") or {}).get("agency")) or {}).get("gtfsId", "").split(":", 1)[-1]
                    for leg in legs}
        problems = []
        if not modes & want_modes:
            problems.append(f"no {'/'.join(sorted(want_modes))} leg")
        if want_agency and want_agency not in agencies:
            problems.append(f"no {want_agency} leg")
        if geom:
            mode, min_points = geom
            points = [leg["legGeometry"]["length"] for leg in legs if leg["mode"] == mode and leg.get("legGeometry")]
            if points and max(points) <= min_points:
                problems.append(f"{mode} legs drawn straight (max {max(points)} points)")
        detail = f"{label}: modes={sorted(modes)}"
        gate.check(not problems, "trip", detail + (f" — {'; '.join(problems)}" if problems else ""))


def check_audit(gate, feed, baseline):
    proc = subprocess.run([sys.executable, os.path.join(SCRIPT_DIR, "audit-gtfs-feed.py"), feed,
                           "--baseline", baseline], capture_output=True, text=True)
    out = (proc.stdout + proc.stderr).strip()
    regressions = [line.strip() for line in out.splitlines() if "REGRESSION" in line]
    if proc.returncode == 0:
        gate.check(True, "audit", f"no service regression versus {os.path.basename(baseline)}")
    else:
        print(out)
        gate.check(False, "audit", f"{len(regressions) or 'unknown'} regression(s) versus {os.path.basename(baseline)}"
                   " — compare per-city total trips before overriding (OTP_VERIFY_SKIP_AUDIT=1)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--otp", default="http://127.0.0.1:18080")
    ap.add_argument("--expect-feeds", type=int, default=1)
    ap.add_argument("--min-bus-cities", type=int, default=20)
    ap.add_argument("--require", default="THSR,TRA,TRTC,KRTC,NTMC,TYMC")
    ap.add_argument("--geometry-limit", action="append", default=[], metavar="MODE=PCT",
                    help="override a mode's stop-to-stop limit, e.g. BUS=8")
    ap.add_argument("--feed", help="new feed zip, for TRA shape validation and the service audit")
    ap.add_argument("--feed-only", action="store_true", help="validate --feed TRA shapes without contacting OTP")
    ap.add_argument("--baseline", help="deployed feed zip or audit json, for the audit check")
    ap.add_argument("--time", default="10:00")
    ap.add_argument("--wait", type=int, default=0, help="seconds to wait for OTP to finish loading")
    ap.add_argument("--timeout", type=int, default=120)
    a = ap.parse_args()
    if a.feed_only and not a.feed:
        ap.error("--feed-only requires --feed")

    gate = Gate()
    if a.feed:
        check_tra_shapes(gate, a.feed)
    else:
        print("info tra-shape: no --feed supplied — TRA stop-to-shape alignment not checked")
    if a.feed_only:
        return report_result(gate)

    limits = dict(DEFAULT_GEOMETRY_LIMITS)
    for item in a.geometry_limit:
        mode, _, pct = item.partition("=")
        limits[mode.upper()] = float(pct)

    probe = load_probe()
    feeds = wait_ready(probe, a.otp, a.wait)
    if feeds is None:
        gate.check(False, "ready", f"OTP at {a.otp} did not answer within {a.wait}s")
        return report_result(gate)
    gate.check(len(feeds) == a.expect_feeds, "feeds", f"loaded {feeds}, expected {a.expect_feeds}")

    now = probe.datetime.now(probe.TAIPEI)
    check_geometry(gate, probe, a.otp, limits, a.timeout)
    check_bus_coverage(gate, probe, a.otp, a.min_bus_cities, a.timeout)
    check_freshness(gate, probe, a.otp, [x for x in a.require.split(",") if x], now.strftime("%Y%m%d"), a.timeout)
    check_trips(gate, probe, a.otp, now.strftime("%Y-%m-%d"), a.time, a.timeout)
    if a.feed and a.baseline:
        if os.environ.get("OTP_VERIFY_SKIP_AUDIT") == "1":
            print("info audit: skipped by OTP_VERIFY_SKIP_AUDIT=1")
        else:
            check_audit(gate, a.feed, a.baseline)
    else:
        print("info audit: no baseline feed (first build on this machine) — not gated")

    return report_result(gate)


if __name__ == "__main__":
    sys.exit(main())
