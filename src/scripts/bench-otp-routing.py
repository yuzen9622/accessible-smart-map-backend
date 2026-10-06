#!/usr/bin/env python3
"""Latency and result-quality benchmark for the routing stack.

Unlike probe-otp-routing.py (a pass/fail gate for a new graph), this records
raw per-query results so two runs — before and after a config, graph or code
change — can be compared:

  otp      plan a fixed origin/destination set x accessibility profiles
           directly against OTP, timing every query with OTP's own
           debugOutput (immune to other traffic on a shared server)
  api      the same set through POST /api/v1/a11y/accessible-route, to see
           what users get (status, fallback label, leg summary, latency)
  compare  p50/p95 latency, timeout share, and the share of the baseline's
           good itineraries (Pareto on arrival, walk, transfers) that no
           longer have an equivalent in the candidate run

Usage:
  bench-otp-routing.py otp --out base.jsonl [--otp URL] [--date 2026-10-14]
  bench-otp-routing.py api --out base-api.jsonl [--api URL]
  bench-otp-routing.py compare base.jsonl after.jsonl
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

OTP_MODES = "WALK,BUS,TROLLEYBUS,RAIL,SUBWAY,TRAM,MONORAIL"

# (label, origin, destination, long_trip)
ODS = [
    ("TC NUTC->CMUH", (24.1497433, 120.6837712), (24.1572247, 120.6804919), False),
    ("TC NUTC->TaichungStn", (24.1497433, 120.6837712), (24.1373, 120.6869), False),
    ("TP TaipeiMain->NTUH", (25.0478, 121.5170), (25.0402, 121.5190), False),
    ("TP Ximen->CityHall", (25.0421, 121.5081), (25.0412, 121.5654), False),
    ("TP Banqiao->Taipei101", (25.0141, 121.4637), (25.0339, 121.5645), False),
    ("KH Main->Formosa", (22.6394, 120.3024), (22.6312, 120.3019), False),
    ("KEE Stn->Miaokou", (25.1316, 121.7392), (25.1285, 121.7435), False),
    ("HSZ Stn->NTHU", (24.8016, 120.9716), (24.7961, 120.9967), False),
    ("TC NUTC->Taipei101", (24.1497433, 120.6837712), (25.0339, 121.5645), True),
]

# (name, backend mode, avoidStairs override, OTP walkSpeed, OTP wheelchair).
# The first four are the plain modes; the rest are the combinations a profile
# or request override produces (avoidStairs on a walking mode, or a wheelchair
# request that waives it).
PROFILES = [
    ("normal", "normal", None, 1.3, False),
    ("elderly", "elderly", None, 0.9, False),
    ("visual", "visual_impaired", None, 1.0, False),
    ("wheelchair", "wheelchair", None, 0.8, True),
    ("normal+avoidStairs", "normal", True, 1.3, True),
    ("elderly+avoidStairs", "elderly", True, 0.9, True),
    ("visual+avoidStairs", "visual_impaired", True, 1.0, True),
    ("wheelchair-waived", "wheelchair", False, 0.8, False),
]
CORE = {"normal", "elderly", "visual", "wheelchair"}


def post_json(url, payload, timeout):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:  # noqa: BLE001
            return e.code, {}


def departure_times(n):
    """n departures from 12:00 in 2-minute steps, wrapping within the hour."""
    return [f"12:{(2 * i) % 60:02d}" for i in range(n)]


def summarize_itinerary(it):
    transit = [leg for leg in it["legs"] if leg["mode"] != "WALK"]
    return {
        "start": it["legs"][0]["startTime"],
        "end": it["legs"][-1]["endTime"],
        "duration": it["duration"],
        "walk": round(it["walkDistance"]),
        "transfers": max(len(transit) - 1, 0),
        "transit": bool(transit),
        "routes": [(leg["route"] or {}).get("shortName") or leg["mode"] for leg in transit],
    }


def otp_query(od, prof, date, at, args):
    _, frm, to, _ = od
    modes = ",".join("{mode:%s}" % m for m in OTP_MODES.split(","))
    q = (
        "{ plan(from:{lat:%f,lon:%f}, to:{lat:%f,lon:%f}, date:\"%s\", time:\"%s\","
        " wheelchair:%s, walkSpeed:%s, numItineraries:%d, searchWindow:%d, maxTransfers:%d,"
        " transportModes:[%s]) { debugOutput{ totalTime pathCalculationTime timedOut }"
        " routingErrors{ code } itineraries{ duration walkDistance"
        " legs{ mode startTime endTime route{ shortName } } } } }"
        % (frm[0], frm[1], to[0], to[1], date, at, str(prof[4]).lower(), prof[3],
           args.num_itineraries, args.search_window, args.max_transfers, modes)
    )
    t0 = time.time()
    try:
        status, body = post_json(f"{args.otp}/otp/gtfs/v1", {"query": q}, args.timeout)
    except Exception as e:  # noqa: BLE001
        return {"wall": time.time() - t0, "error": str(e)}
    wall = time.time() - t0
    if status != 200 or "errors" in body or not (body.get("data") or {}).get("plan"):
        return {"wall": wall, "error": json.dumps(body.get("errors") or status)[:200]}
    plan = body["data"]["plan"]
    dbg = plan.get("debugOutput") or {}
    return {
        "wall": wall,
        "otpTotalMs": dbg.get("totalTime"),
        "otpPathMs": dbg.get("pathCalculationTime"),
        "timedOut": dbg.get("timedOut"),
        "errors": sorted({e["code"] for e in plan.get("routingErrors") or []}),
        "itineraries": [summarize_itinerary(it) for it in plan.get("itineraries") or []],
    }


def api_query(od, prof, date, at, args):
    _, frm, to, _ = od
    body = {
        "origin": {"latitude": frm[0], "longitude": frm[1]},
        "destination": {"latitude": to[0], "longitude": to[1]},
        "travelMode": "transit",
        "mode": prof[1],
        "departureTime": f"{date}T{at}:00",
    }
    if prof[2] is not None:
        body["avoidStairs"] = prof[2]
    t0 = time.time()
    try:
        status, resp = post_json(f"{args.api}/api/v1/a11y/accessible-route", body, args.timeout)
    except Exception as e:  # noqa: BLE001
        return {"wall": time.time() - t0, "error": str(e)}
    data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
    return {
        "wall": time.time() - t0,
        "status": status,
        "reason": data.get("reason"),
        "fallback": data.get("fallback"),
        "routes": [
            {
                "minutes": r.get("totalMinutes"),
                "legs": [
                    leg["type"] if leg["type"] == "WALK"
                    else f'{leg["type"]}:{leg.get("routeName") or leg.get("lineName") or leg.get("trainNo") or ""}'
                    for leg in r.get("legs", [])
                ],
                "degraded": bool(r.get("degraded")),
            }
            for r in data.get("routes", [])
        ],
    }


def run(kind, args):
    query = otp_query if kind == "otp" else api_query
    samples = args.samples if kind == "otp" else args.api_samples
    with open(args.out, "w", encoding="utf-8") as out:
        out.write(json.dumps({"meta": {"kind": kind, "label": args.label, "date": args.date,
                                       "at": time.strftime("%F %T"), "searchWindow": args.search_window,
                                       "numItineraries": args.num_itineraries}}) + "\n")
        for od in ODS:
            for prof in PROFILES:
                n = samples if prof[0] in CORE else max(samples // 3, 3)
                if od[3]:
                    n = max(n // 3, 3)
                walls = []
                for at in departure_times(n):
                    rec = query(od, prof, args.date, at, args)
                    rec.update({"od": od[0], "profile": prof[0], "time": at})
                    out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    out.flush()
                    walls.append(rec["wall"])
                print(f"{od[0]:24s} {prof[0]:20s} n={n:2d} p50={statistics.median(walls):5.2f}s "
                      f"max={max(walls):6.2f}s", flush=True)
    return 0


def load(path):
    meta, rows = None, []
    with open(path, encoding="utf-8") as f:
        for line in f:
            obj = json.loads(line)
            if "meta" in obj:
                meta = obj["meta"]
            else:
                rows.append(obj)
    return meta, rows


def pct(values, q):
    if not values:
        return float("nan")
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


def pareto(its):
    good = []
    for it in its:
        dominated = any(
            o is not it and o["end"] <= it["end"] and o["walk"] <= it["walk"]
            and o["transfers"] <= it["transfers"]
            and (o["end"], o["walk"], o["transfers"]) != (it["end"], it["walk"], it["transfers"])
            for o in its
        )
        if not dominated:
            good.append(it)
    return good


def covered(it, candidates):
    return any(
        c["end"] <= it["end"] + 120 and c["walk"] <= it["walk"] * 1.1 + 50
        and c["transfers"] <= it["transfers"]
        for c in candidates
    )


def compare(base_path, cand_path):
    _, base = load(base_path)
    _, cand = load(cand_path)
    by_key = {(r["od"], r["profile"], r["time"]): r for r in cand}
    groups = {}
    for r in base:
        groups.setdefault((r["od"], r["profile"]), []).append(r)
    print(f"{'od':24s} {'profile':20s} {'p50 base':>9s} {'p50 new':>8s} {'p95 base':>9s} {'p95 new':>8s}"
          f" {'err b/n':>8s} {'lost':>6s} {'transit->none':>13s}")
    tot_good = tot_lost = 0
    for (od, prof), rows in groups.items():
        pairs = [(r, by_key.get((od, prof, r["time"]))) for r in rows]
        pairs = [(b, c) for b, c in pairs if c]
        if not pairs:
            continue
        def ms(r):
            return r.get("otpTotalMs") or r["wall"] * 1000
        bt = [ms(b) for b, _ in pairs if "error" not in b]
        ct = [ms(c) for _, c in pairs if "error" not in c]
        berr = sum("error" in b or b.get("timedOut") for b, _ in pairs)
        cerr = sum("error" in c or c.get("timedOut") for _, c in pairs)
        good = lost = lost_transit = 0
        for b, c in pairs:
            bits = pareto(b.get("itineraries") or [])
            cits = c.get("itineraries") or []
            for it in bits:
                good += 1
                if not covered(it, cits):
                    lost += 1
            if any(i["transit"] for i in b.get("itineraries") or []) and not any(
                i["transit"] for i in cits
            ):
                lost_transit += 1
        tot_good += good
        tot_lost += lost
        print(f"{od:24s} {prof:20s} {pct(bt, .5):8.0f}ms {pct(ct, .5):7.0f}ms {pct(bt, .95):8.0f}ms"
              f" {pct(ct, .95):7.0f}ms {berr:3d}/{cerr:<3d} {lost:3d}/{good:<3d} {lost_transit:6d}/{len(pairs)}")
    print(f"TOTAL lost good itineraries: {tot_lost}/{tot_good}"
          f" ({(100 * tot_lost / tot_good) if tot_good else 0:.1f}%)")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("otp", "api"):
        p = sub.add_parser(name)
        p.add_argument("--out", required=True)
        p.add_argument("--label", default="")
        p.add_argument("--otp", default="http://localhost:18080")
        p.add_argument("--api", default="http://localhost:8000")
        p.add_argument("--date", default="2026-10-14", help="fixed service date (YYYY-MM-DD)")
        p.add_argument("--samples", type=int, default=30)
        p.add_argument("--api-samples", type=int, default=6)
        p.add_argument("--timeout", type=int, default=120)
        p.add_argument("--search-window", type=int, default=3600)
        p.add_argument("--num-itineraries", type=int, default=8)
        p.add_argument("--max-transfers", type=int, default=3, help="OTP value (backend sends transfers + 1)")
    c = sub.add_parser("compare")
    c.add_argument("base")
    c.add_argument("candidate")
    a = ap.parse_args()
    if a.cmd == "compare":
        return compare(a.base, a.candidate)
    return run(a.cmd, a)


if __name__ == "__main__":
    sys.exit(main())
