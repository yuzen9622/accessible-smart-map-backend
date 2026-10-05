#!/usr/bin/env python3
"""Acceptance probe for a freshly built OTP graph.

A rebuild that "succeeds" can still serve a graph that silently routes
everything by bus (expired rail calendars) or returns nothing for some
trips. This probe asks the running OTP the questions a user would, with
the same variables the backend sends, and fails loudly:

  1. freshness  every required rail/metro operator runs trips today
  2. rail use   trips that only make sense by rail actually use it
                (Nangang→Taipei Main by metro/TRA, Taipei→Zuoying by THSR,
                wheelchair Banqiao→Taipei 101 by metro)
  3. latency    short trips around Taipei hubs, wheelchair and normal,
                answer within --slow seconds and never come back empty
                when a walk-only query finds a route

Usage: probe-otp-routing.py [--otp http://localhost:18080] [--time 10:00]
                            [--require THSR,TRA,TRTC,KRTC,NTMC,TYMC] [--slow 8]
Exit 0 when every check passes, 1 otherwise.
"""
import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

TAIPEI = timezone(timedelta(hours=8))
MODES = "WALK,BUS,TROLLEYBUS,RAIL,SUBWAY,TRAM,MONORAIL"

RAIL_CASES = [
    ("Nangang→TaipeiMain", (25.0530, 121.6067), (25.0478, 121.5170), "false", {"SUBWAY", "RAIL"}, None),
    ("TaipeiMain→Zuoying", (25.0478, 121.5170), (22.6870, 120.3090), "false", {"RAIL"}, "THSR"),
    ("Banqiao→Taipei101 wheelchair", (25.0141, 121.4637), (25.0339, 121.5645), "true", {"SUBWAY"}, None),
]

HUBS = {
    "TaipeiMain": (25.0478, 121.5170), "Ximen": (25.0421, 121.5081),
    "Zhongshan": (25.0527, 121.5203), "CityHall": (25.0412, 121.5654),
    "SongshanStn": (25.0493, 121.5779), "BanqiaoStn": (25.0141, 121.4637),
    "Gongguan": (25.0146, 121.5343), "Shilin": (25.0938, 121.5262),
    "Taipei101": (25.0339, 121.5645), "Dongmen": (25.0339, 121.5287),
}


def post(otp, query, timeout):
    req = urllib.request.Request(
        f"{otp}/otp/routers/default/index/graphql",
        data=json.dumps({"query": query}).encode(),
        headers={"content-type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def plan(otp, frm, to, wheelchair, modes, date, at, timeout):
    speed = "0.8" if wheelchair == "true" else "1.3"
    tm = ",".join("{mode:%s}" % m for m in modes.split(","))
    q = ('{ plan(from:{lat:%f,lon:%f}, to:{lat:%f,lon:%f}, date:"%s", time:"%s",'
         ' wheelchair:%s, walkSpeed:%s, numItineraries:8, searchWindow:3600, transportModes:[%s])'
         ' { routingErrors{code} itineraries{ legs{ mode route{ agency{ gtfsId } } } } } }'
         % (frm[0], frm[1], to[0], to[1], date, at, wheelchair, speed, tm))
    t0 = time.time()
    try:
        body = post(otp, q, timeout)
    except Exception as e:  # noqa: BLE001
        return time.time() - t0, None, f"request failed: {e}"
    dt = time.time() - t0
    if "errors" in body:
        return dt, None, body["errors"][0].get("message", "graphql error")
    return dt, body["data"]["plan"]["itineraries"], ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--otp", default="http://localhost:18080")
    ap.add_argument("--time", default="10:00")
    ap.add_argument("--require", default="THSR,TRA,TRTC,KRTC,NTMC,TYMC")
    ap.add_argument("--slow", type=float, default=8.0)
    ap.add_argument("--timeout", type=int, default=30)
    a = ap.parse_args()
    now = datetime.now(TAIPEI)
    date, ymd = now.strftime("%Y-%m-%d"), now.strftime("%Y%m%d")
    failures = []

    body = post(a.otp, '{ routes(transportModes:[RAIL,SUBWAY,TRAM,MONORAIL]) { agency { gtfsId }'
                       ' patterns { tripsForDate(serviceDate:"%s") { gtfsId } } } }' % ymd, a.timeout)
    trips = {}
    for route in body["data"]["routes"]:
        agency = route["agency"]["gtfsId"].split(":", 1)[-1]
        trips[agency] = trips.get(agency, 0) + sum(len(p["tripsForDate"]) for p in route["patterns"])
    for agency in sorted({x for x in a.require.split(",") if x} | set(trips)):
        n = trips.get(agency, 0)
        if n == 0:
            # tripsForDate omits headway (frequencies.txt) trips; recount those
            # operators from each trip's activeDates.
            recount = post(a.otp, '{ agency(id:"1:%s") { routes { patterns { trips { activeDates } } } } }'
                           % agency, a.timeout)
            agency_data = (recount.get("data") or {}).get("agency") or {}
            n = sum(1 for r in agency_data.get("routes", []) for p in r["patterns"]
                    for t in p["trips"] if ymd in t["activeDates"])
        ok = n > 0
        print(f"{'ok  ' if ok else 'FAIL'} freshness {agency}: {n} trips on {ymd}")
        if not ok and agency in a.require.split(","):
            failures.append(f"{agency} has no trips today")

    for label, frm, to, wheelchair, want_modes, want_agency in RAIL_CASES:
        dt, its, err = plan(a.otp, frm, to, wheelchair, MODES, date, a.time, a.timeout)
        legs = [leg for it in (its or []) for leg in it["legs"]]
        modes = {leg["mode"] for leg in legs}
        agencies = {
            (((leg.get("route") or {}).get("agency")) or {}).get("gtfsId", "").split(":", 1)[-1]
            for leg in legs
        }
        ok = bool(modes & want_modes) and (want_agency is None or want_agency in agencies)
        print(f"{'ok  ' if ok else 'FAIL'} rail-use {label}: {dt:.1f}s modes={sorted(modes)} {err}")
        if not ok:
            failures.append(f"{label} does not use {sorted(want_modes)}{' via ' + want_agency if want_agency else ''}")

    for name, (lat, lng) in HUBS.items():
        near = (lat + 0.0045, lng + 0.003)
        for frm, to, direction in ((lat, lng), near, "out"), (near, (lat, lng), "in"):
            for wheelchair in ("true", "false"):
                dt, its, err = plan(a.otp, frm, to, wheelchair, MODES, date, a.time, a.timeout)
                if its:
                    ok = dt <= a.slow
                    why = f"slow {dt:.1f}s"
                else:
                    _, walk, _ = plan(a.otp, frm, to, wheelchair, "WALK", date, a.time, a.timeout)
                    ok = not walk
                    why = f"empty after {dt:.1f}s while walk-only finds a route {err}"
                label = f"{name} {direction} wheelchair={wheelchair}"
                print(f"{'ok  ' if ok else 'FAIL'} latency {label}: {dt:.1f}s")
                if not ok:
                    failures.append(f"{label}: {why}")

    print(f"RESULT {'PASS' if not failures else 'FAIL'} ({len(failures)} failures)")
    for f in failures:
        print(f"  - {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
