#!/usr/bin/env python3
"""Route-planning quality evaluation against a running backend.

Sends a stratified sample of real POST /api/v1/a11y/accessible-route requests
and scores the answers on four axes:

  1. availability  HTTP success, non-empty candidates and usable answers are
                   counted apart; recall uses fixed known-feasible requests
                   and independent positive OTP evidence. An empty 2 h oracle
                   window is an observation, never proof of infeasibility.
  2. correctness   hard constraints (transfer cap, step-free walking when
                   avoidStairs is engaged, no ferry/air stops, walk answers to
                   transit requests carry data.fallback), unknown walk
                   accessibility share, geometric continuity, reachable
                   boarding and feasible transfer timing
  3. waiting time  client wall time to the answer: p50/p95/p99/max, share
                   within 5 s, timeout share; first calls and immediate repeats
                   are kept apart without assuming their cache-hit state
  4. confidence    every county x travel mode x need x distance x time slot
                   stratum keeps its own denominator; proportions carry Wilson
                   95% intervals and strata below --min-n are flagged

Origins are GTFS stops of the sampled counties, destinations any stop at the
sampled straight-line distance, both jittered up to 60 m to mimic addresses.
Departures are fixed slots on the next Monday and Saturday (Taipei time).

Backend calls run one at a time first; the oracle runs afterwards in parallel
so its OTP load never overlaps a timed request. Writes records.jsonl and
oracle.jsonl (appended as they go, so a rerun resumes) and report.md under --out.

Usage: eval-route-quality.py [--base http://localhost:8000] [--otp http://localhost:18080]
                             [--feed otp-data/feed-1.gtfs.zip] [--n 250] [--seed 7]
                             [--repeat 0.3] [--timeout 90] [--min-n 30] [--out DIR]
       eval-route-quality.py --report-only DIR --baseline BASELINE_DIR

--baseline accepts records.jsonl or an evaluation directory (repeatable).
--known-feasible accepts an additional fixed-case JSON collection (repeatable).
The bundled regression cases are always included with their exact dates; expired
cases are reported as unmeasured, never silently moved to another service day.
"""
import argparse
import csv
import hashlib
import io
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

TAIPEI = timezone(timedelta(hours=8))
OTP_MODES = "WALK,BUS,TROLLEYBUS,RAIL,SUBWAY,TRAM,MONORAIL"
WALK_SPEED = {"wheelchair": 0.8, "elderly": 0.9, "visual_impaired": 1.0, "normal": 1.3}
TRANSIT_LEGS = {"BUS", "METRO", "THSR", "TRA"}
LEAK_STOP_PREFIXES = ("SHIP", "AirLine")
MAX_TRANSFERS = 2
WALK_FALLBACK_KM = 1.5
REGRESSION_CASES = Path(__file__).with_name("fixtures") / "route-known-feasible.json"

COUNTIES = {
    "TPE": "臺北市", "NWT": "新北市", "TAO": "桃園市", "TXG": "臺中市", "TNN": "臺南市",
    "KHH": "高雄市", "HSZ": "新竹市", "ILA": "宜蘭縣", "HUA": "花蓮縣", "TTT": "臺東縣",
}
BANDS = [("0.3-1.5km", 0.3, 1.5, 0.2), ("1.5-5km", 1.5, 5, 0.25), ("5-20km", 5, 20, 0.25),
         ("20-80km", 20, 80, 0.15), ("80km+", 80, 400, 0.15)]
NEEDS = [("normal", "normal", None, 0.33), ("normal+avoidStairs", "normal", True, 0.07),
         ("wheelchair", "wheelchair", None, 0.33), ("elderly", "elderly", None, 0.17),
         ("visual_impaired", "visual_impaired", None, 0.10)]
SLOT_TIMES = [("weekday-07:45", 0, "07:45"), ("weekday-12:30", 0, "12:30"),
              ("weekday-17:45", 0, "17:45"), ("weekday-22:15", 0, "22:15"),
              ("weekend-13:00", 5, "13:00")]
DIMENSIONS = ["county", "travel", "need", "band", "slot"]


def haversine_m(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def jitter(rng, p, max_m=60):
    r, t = rng.uniform(0, max_m), rng.uniform(0, 2 * math.pi)
    return (p[0] + r * math.cos(t) / 111320, p[1] + r * math.sin(t) / (111320 * math.cos(math.radians(p[0]))))


def load_stops(feed):
    stops = []
    with zipfile.ZipFile(feed) as zf, zf.open("stops.txt") as f:
        for s in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
            if s.get("location_type") not in ("", "0", None):
                continue
            prefix = "".join(ch for ch in s["stop_id"][:3] if ch.isalpha())
            stops.append((float(s["stop_lat"]), float(s["stop_lon"]), prefix))
    return stops


def slot_dates(now):
    today = now.date()
    days = {weekday: today + timedelta(days=(weekday - today.weekday()) % 7 or 7) for weekday in (0, 5)}
    return {label: datetime.combine(days[weekday], datetime.strptime(hm, "%H:%M").time(), TAIPEI)
            for label, weekday, hm in SLOT_TIMES}


def weighted(rng, items):
    return rng.choices(items, weights=[it[-1] for it in items], k=1)[0]


def build_sample(stops, n, seed, now):
    rng = random.Random(seed)
    by_county = defaultdict(list)
    grid = defaultdict(list)
    for s in stops:
        if s[2] in COUNTIES:
            by_county[s[2]].append(s)
        grid[(int(s[0] / 0.05), int(s[1] / 0.05))].append(s)
    slots = slot_dates(now)
    counties = sorted(COUNTIES)
    sample = []
    for i in range(n):
        county = counties[i % len(counties)]
        band, lo, hi, _ = weighted(rng, BANDS)
        origin = rng.choice(by_county[county])
        dest = None
        for _ in range(4000):
            if hi <= 20:
                reach = int(hi / 5.5) + 1
                cell = (int(origin[0] / 0.05) + rng.randint(-reach, reach), int(origin[1] / 0.05) + rng.randint(-reach, reach))
                if not grid.get(cell):
                    continue
                cand = rng.choice(grid[cell])
            else:
                cand = rng.choice(stops)
            if lo * 1000 <= haversine_m(origin, cand) <= hi * 1000:
                dest = cand
                break
        if dest is None:
            continue
        need, mode, avoid, _ = weighted(rng, NEEDS)
        roll = rng.random()
        travel = "walk" if hi <= 5 and roll < 0.3 else "drive" if hi <= 80 and roll > 0.9 else "transit"
        slot = SLOT_TIMES[i % len(SLOT_TIMES)][0]
        o, d = jitter(rng, origin), jitter(rng, dest)
        sample.append({
            "id": i, "county": county, "band": band, "need": need, "mode": mode, "avoidStairs": avoid,
            "travel": travel, "slot": slot, "departure": slots[slot].isoformat(),
            "origin": [round(o[0], 6), round(o[1], 6)], "destination": [round(d[0], 6), round(d[1], 6)],
            "straight_km": round(haversine_m(o, d) / 1000, 2), "repeat": rng.random(),
        })
    return sample


def post_json(url, body, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.load(resp), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            payload = json.load(e)
        except Exception:  # noqa: BLE001
            payload = None
        return e.code, payload, time.time() - t0
    except Exception as e:  # noqa: BLE001
        return None, {"clientError": str(e)[:200]}, time.time() - t0


def request_body(case):
    """The exact HTTP body is the reference identity, not the sample's numeric id."""
    if "request" in case:
        return case["request"]
    body = {
        "origin": {"latitude": case["origin"][0], "longitude": case["origin"][1]},
        "destination": {"latitude": case["destination"][0], "longitude": case["destination"][1]},
        "travelMode": case["travel"], "mode": case["mode"], "departureTime": case["departure"],
    }
    if case.get("avoidStairs") is not None:
        body["avoidStairs"] = case["avoidStairs"]
    return body


def request_identity(case):
    return json.dumps(request_body(case), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def call_backend(base, case, timeout):
    body = request_body(case)
    return post_json(f"{base}/api/v1/a11y/accessible-route", body, timeout)


def step_free(case):
    return case["avoidStairs"] if case["avoidStairs"] is not None else case["mode"] == "wheelchair"


def oracle(otp, case, timeout):
    """Positive evidence only: a 2 h window cannot disprove a 24 h route.

    OTP's maxTransfers bounds rides, not transfers, hence MAX_TRANSFERS + 1.
    """
    if case["travel"] == "drive":
        return {"feasible": None, "observation": "not_applicable"}
    dep = datetime.fromisoformat(case["departure"])
    modes = "WALK" if case["travel"] == "walk" else OTP_MODES
    query = ('{ plan(from:{lat:%f,lon:%f}, to:{lat:%f,lon:%f}, date:"%s", time:"%s", wheelchair:%s,'
             ' walkSpeed:%s, numItineraries:3, searchWindow:7200, maxTransfers:%d, transportModes:[%s])'
             ' { itineraries { legs { mode } } } }'
             % (case["origin"][0], case["origin"][1], case["destination"][0], case["destination"][1],
                dep.strftime("%Y-%m-%d"), dep.strftime("%H:%M:%S"), str(step_free(case)).lower(),
                WALK_SPEED[case["mode"]], MAX_TRANSFERS + 1, ",".join("{mode:%s}" % m for m in modes.split(","))))
    status, body, _ = post_json(f"{otp}/otp/routers/default/index/graphql", {"query": query}, timeout)
    if status != 200 or not body or body.get("errors"):
        return {"feasible": None, "observation": "upstream_unknown"}
    its = body["data"]["plan"]["itineraries"]
    if case["travel"] == "walk" or (its and case["straight_km"] <= WALK_FALLBACK_KM):
        found = bool(its)
    else:
        found = any(any(leg["mode"] != "WALK" for leg in it["legs"]) for it in its)
    return {"feasible": True if found else None,
            "observation": "found" if found else "observed_no_candidates",
            "search_window_seconds": 7200}


def hhmm(value):
    if not value or ":" not in value:
        return None
    h, m = value.split(":")[:2]
    return int(h) * 60 + int(m)


def check_route(route, case, data):
    legs = route.get("legs") or []
    issues = []
    transit = [leg for leg in legs if leg.get("type") in TRANSIT_LEGS]
    if case["travel"] == "transit" and len(transit) - 1 > MAX_TRANSFERS:
        issues.append(f"transfers:{len(transit) - 1}")
    allowed = {"transit": TRANSIT_LEGS | {"WALK"}, "walk": {"WALK"}, "drive": {"DRIVE", "WALK"}}[case["travel"]]
    for leg in legs:
        if leg.get("type") not in allowed:
            issues.append(f"mode:{leg.get('type')}")
        for key in ("departureStopId", "arrivalStopId", "departureStationUid", "arrivalStationUid"):
            if str(leg.get(key) or "").startswith(LEAK_STOP_PREFIXES):
                issues.append(f"leak:{leg.get(key)}")
    if step_free(case):
        for leg in legs:
            if leg.get("type") == "WALK" and any(s.get("stairs") for s in leg.get("steps") or []):
                issues.append("stairs")
                break

    geometry = []
    points = [leg.get("polyline") or [] for leg in legs]
    for leg, pl in zip(legs, points):
        if len(pl) < 2:
            geometry.append(f"empty:{leg.get('type')}")
        elif leg.get("type") in TRANSIT_LEGS and len(pl) == 2 and haversine_m(pl[0][::-1], pl[1][::-1]) > 1000:
            geometry.append(f"straight:{leg.get('type')}")
    boarding = []
    for i in range(1, len(legs)):
        if points[i - 1] and points[i]:
            gap = haversine_m(points[i - 1][-1][::-1], points[i][0][::-1])
            if gap > 150:
                (boarding if legs[i].get("type") in TRANSIT_LEGS else geometry).append(f"gap:{int(gap)}m@{i}")
    if points and points[0] and haversine_m(points[0][0][::-1], case["origin"]) > 250:
        geometry.append("start-far")
    if points and points[-1] and haversine_m(points[-1][-1][::-1], case["destination"]) > 250:
        geometry.append("end-far")

    timing = []
    prev_arr, walk_min = None, 0
    for leg in legs:
        if leg.get("type") in TRANSIT_LEGS:
            dep, arr = hhmm(leg.get("departureTime")), hhmm(leg.get("arrivalTime"))
            if dep is not None and arr is not None and (arr - dep) % 1440 > 720:
                timing.append("arrives-before-departs")
            if prev_arr is not None and dep is not None:
                slack = (dep - prev_arr - walk_min + 720) % 1440 - 720
                if slack < -1:
                    timing.append(f"transfer:{slack}min")
            prev_arr, walk_min = (arr if arr is not None else prev_arr), 0
        elif leg.get("type") == "WALK" and prev_arr is not None:
            walk_min += leg.get("minutesEst") or 0

    walk_m = sum(leg.get("distanceM") or 0 for leg in legs if leg.get("type") == "WALK")
    unknown_m = sum(leg.get("distanceM") or 0 for leg in legs if leg.get("type") == "WALK"
                    and (leg.get("surfaceType") in (None, "unknown")) and leg.get("maxSlopePercent") is None
                    and leg.get("minPathWidthCm") is None)
    return {
        "constraint": issues, "geometry": geometry, "boarding": boarding, "timing": timing,
        "walk_m": walk_m, "unknown_walk_m": unknown_m, "confidence": route.get("dataConfidence"),
        "transit_legs": len(transit), "minutes": route.get("totalMinutes"),
    }


def evaluate(case, status, body, latency):
    data = (body or {}).get("data") or {}
    routes = (data.get("routes") or []) if status == 200 else []
    checks = [check_route(r, case, data) for r in routes]
    if case["travel"] == "transit" and checks and not any(c["transit_legs"] for c in checks) and not data.get("fallback"):
        for c in checks:
            c["constraint"].append("walk-without-fallback")
    usable = [c for c in checks if not (c["constraint"] or c["geometry"] or c["boarding"] or c["timing"])]
    return {
        "status": status, "latency": round(latency, 3), "reason": data.get("reason") or (body or {}).get("clientError"),
        "routes": len(routes), "usable_routes": len(usable), "fallback": (data.get("fallback") or {}).get("reason"),
        "has_transit": any(c["transit_legs"] for c in checks), "checks": checks,
    }


def usable_answer(record):
    attempt = record["first"]
    return bool(attempt["status"] == 200 and attempt["usable_routes"]
                and (record["travel"] != "transit" or attempt["has_transit"] or attempt["fallback"]))


def load_references(baselines=(), known_paths=()):
    """Freeze positive references before examining the candidate run's answers."""
    entries, sources = {}, []
    specs = [(REGRESSION_CASES, "fixed"), *((Path(p), "fixed") for p in known_paths),
             *((Path(p), "baseline") for p in baselines)]
    for source, kind in specs:
        if source.is_dir():
            source = source / "records.jsonl"
        raw = source.read_bytes()
        provenance = {"path": str(source.resolve()), "sha256": hashlib.sha256(raw).hexdigest(), "kind": kind}
        sources.append(provenance)
        if kind == "fixed":
            cases = json.loads(raw)["cases"]
        else:
            cases = [json.loads(line) for line in raw.splitlines() if line.strip()]
        for case in cases:
            if kind == "fixed":
                if case.get("known_feasible") is not True:
                    raise ValueError(f"Fixed case {case.get('id')} must explicitly set known_feasible=true")
            elif not usable_answer(case):
                continue
            identity = request_identity(case)
            entry = entries.setdefault(identity, {"case": {k: v for k, v in case.items()
                                                           if k not in ("first", "again", "feasible")},
                                                  "required": False, "sources": []})
            entry["required"] |= kind == "fixed"
            entry["sources"].append(provenance)
    return {"sources": sources, "entries": entries}


def reference_set(out_dir, baselines=(), known_paths=()):
    path = Path(out_dir) / "reference-set.json"
    if path.exists() and not baselines and not known_paths:
        return json.loads(path.read_text())
    refs = load_references(baselines, known_paths)
    path.write_text(json.dumps(refs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return refs


def include_fixed_cases(sample, references):
    """The permanent cases are sent through the real evaluator, not only listed."""
    result = list(sample)
    seen = {request_identity(c) for c in sample}
    for identity, entry in references["entries"].items():
        if entry["required"] and identity not in seen:
            result.append(dict(entry["case"]))
            seen.add(identity)
    return result


def feed_service_range(feed):
    """Broad feed date bounds; these do not assert that a particular trip runs."""
    dates = []
    with zipfile.ZipFile(feed) as zf:
        for name, keys in [("calendar.txt", ("start_date", "end_date")), ("calendar_dates.txt", ("date",))]:
            if name not in zf.namelist():
                continue
            with zf.open(name) as f:
                for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
                    dates.extend(datetime.strptime(row[k], "%Y%m%d").date() for k in keys if row.get(k))
    return (min(dates), max(dates)) if dates else None


def fixed_case_unavailable(case, now, bounds):
    departure = datetime.fromisoformat(case["departure"])
    if departure <= now:
        return "expired_departure_not_rebased"
    if bounds and not bounds[0] <= departure.astimezone(TAIPEI).date() <= bounds[1]:
        return "outside_feed_service_dates"
    return None


def run(args):
    os.makedirs(args.out, exist_ok=True)
    now = datetime.now(TAIPEI)
    meta_path = Path(args.out) / "meta.json"
    previous_meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    sample_start = datetime.fromisoformat(previous_meta["started"]) if previous_meta else now
    sample = build_sample(load_stops(args.feed), args.n, args.seed, sample_start)
    if args.bands:
        sample = [c for c in sample if c["band"] in args.bands.split(",")]
    references = reference_set(args.out, args.baseline, args.known_feasible)
    sample = include_fixed_cases(sample, references)
    bounds = feed_service_range(args.feed)
    unavailable = []
    for case in sample:
        entry = references["entries"].get(request_identity(case), {})
        reason = fixed_case_unavailable(case, now, bounds) if entry.get("required") else None
        if reason:
            unavailable.append({"request_identity": request_identity(case), "reason": reason})
    excluded = {c["request_identity"] for c in unavailable}
    sample = [c for c in sample if request_identity(c) not in excluded]
    path = os.path.join(args.out, "records.jsonl")
    done = set()
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            done = {request_identity(json.loads(line)) for line in f if line.strip()}
    with open(os.path.join(args.out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"started": sample_start.isoformat(), "last_started": now.isoformat(),
                   "base": args.base, "otp": args.otp, "seed": args.seed,
                   "n": len(sample), "timeout": args.timeout, "reference_sources": references["sources"],
                   "unmeasured_fixed_cases": unavailable,
                   "feed_service_dates": [d.isoformat() for d in bounds] if bounds else None},
                  f, ensure_ascii=False, indent=1)
    with open(path, "a", encoding="utf-8") as out:
        for k, case in enumerate(sample):
            if request_identity(case) in done:
                continue
            status, body, latency = call_backend(args.base, case, args.timeout)
            record = dict(case, first=evaluate(case, status, body, latency))
            if case.get("repeat", 1) < args.repeat:
                status, body, latency = call_backend(args.base, case, args.timeout)
                record["again"] = evaluate(case, status, body, latency)
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            out.flush()
            first = record["first"]
            print(f"[{k + 1}/{len(sample)}] {case['county']} {case['travel']} {case['need']} {case['band']} "
                  f"{case['slot']}: {first['status']} {first['latency']:.1f}s routes={first['routes']} "
                  f"usable={first['usable_routes']}", flush=True)
    run_oracle(args, sample)
    return report(args.out, args.min_n, args.timeout)


def run_oracle(args, sample):
    """Second pass, after every timed backend call, so oracle load never overlaps a measurement."""
    path = os.path.join(args.out, "oracle.jsonl")
    done = set()
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            done = {o["request_identity"] for o in map(json.loads, filter(str.strip, f))
                    if "request_identity" in o}
    todo = [c for c in sample if request_identity(c) not in done]
    with open(path, "a", encoding="utf-8") as out, ThreadPoolExecutor(args.oracle_workers) as pool:
        for case, result in zip(todo, pool.map(lambda c: oracle(args.otp, c, args.timeout), todo)):
            out.write(json.dumps({"id": case["id"], "request_identity": request_identity(case), **result}) + "\n")
            out.flush()
    print(f"oracle: {len(todo)} cases checked", flush=True)


def load_records(out_dir):
    with open(os.path.join(out_dir, "records.jsonl"), encoding="utf-8") as f:
        recs = [json.loads(line) for line in f if line.strip()]
    evidence, legacy_evidence = {}, {}
    path = os.path.join(out_dir, "oracle.jsonl")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for o in map(json.loads, filter(str.strip, f)):
                if "request_identity" in o:
                    evidence[o["request_identity"]] = o
                else:
                    legacy_evidence[o["id"]] = o
    identities_by_id = defaultdict(set)
    for r in recs:
        identities_by_id[r["id"]].add(request_identity(r))
    for r in recs:
        observation = evidence.get(request_identity(r))
        if observation is None and len(identities_by_id[r["id"]]) == 1:
            observation = legacy_evidence.get(r["id"])
        observation = observation or {"feasible": r.get("feasible")}
        legacy_value = observation.get("feasible")
        r["feasible"] = True if legacy_value is True else None
        r["oracle_observation"] = observation.get("observation") or (
            "found" if legacy_value is True else "observed_no_candidates" if legacy_value is False else "unknown")
        for attempt in (r["first"], r.get("again")):
            checks = (attempt or {}).get("checks") or []
            for c in checks:
                c["constraint"] = [x for x in c["constraint"] if x != "walk-without-fallback"]
            if r["travel"] == "transit" and checks and not attempt["has_transit"] and not attempt["fallback"]:
                for c in checks:
                    c["constraint"].append("walk-without-fallback")
            if attempt:
                attempt["usable_routes"] = sum(not (c["constraint"] or c["geometry"] or c["boarding"] or c["timing"])
                                               for c in checks)
    return recs


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def binom_cdf(n, p):
    logs = [math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
            + k * math.log(p) + (n - k) * math.log(1 - p) for k in range(n + 1)]
    total, out = 0.0, []
    for v in logs:
        total += math.exp(v)
        out.append(total)
    return out


def quantile(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))]


def quantile_ci(values, q, conf=0.95):
    """Distribution-free order-statistic interval; None when n is too small."""
    s, n = sorted(values), len(values)
    cdf = binom_cdf(n, q)
    alpha = (1 - conf) / 2
    lows = [k for k in range(1, n + 1) if cdf[k - 1] <= alpha]
    highs = [k for k in range(1, n + 1) if cdf[k - 1] >= 1 - alpha]
    if not lows or not highs:
        return None
    return s[lows[-1] - 1], s[highs[0] - 1]


def pct(k, n):
    if n == 0:
        return "—"
    lo, hi = wilson(k, n)
    return f"{k}/{n} = {100 * k / n:.1f}% [{100 * lo:.1f}, {100 * hi:.1f}]"


def secs(v):
    return "—" if v is None else f"{v:.1f}s"


def latency_row(label, values, timeout):
    if not values:
        return f"| {label} | 0 | — | — | — | — | — | — |"
    ci = quantile_ci(values, 0.95) if len(values) >= 20 else None
    p95 = secs(quantile(values, 0.95)) + (f" [{ci[0]:.1f}, {ci[1]:.1f}]" if ci else " (n不足)")
    within = sum(v <= 5 for v in values)
    timeouts = sum(v >= timeout - 0.5 for v in values)
    return (f"| {label} | {len(values)} | {secs(quantile(values, 0.5))} | {p95} | {secs(quantile(values, 0.99))} | "
            f"{secs(max(values))} | {pct(within, len(values))} | {pct(timeouts, len(values))} |")


def report(out_dir, min_n, timeout, baselines=(), known_paths=()):
    recs = load_records(out_dir)
    references = reference_set(out_dir, baselines, known_paths)
    observed = {request_identity(r) for r in recs}
    for r in recs:
        r["reference_known"] = request_identity(r) in references["entries"]
        r["known_feasible"] = r["reference_known"] or r["feasible"] is True
    losses = [r for r in recs if r["reference_known"] and not usable_answer(r)]
    missing = [entry for key, entry in references["entries"].items() if key not in observed]
    summary = {
        "reference_sources": references["sources"],
        "reference_total": len(references["entries"]),
        "reference_usable": len({request_identity(r) for r in recs
                                 if r["reference_known"] and usable_answer(r)}),
        "matched_references": len(observed & references["entries"].keys()),
        "reference_losses": [{"id": r["id"], "request": request_body(r), "status": r["first"]["status"],
                              "reason": r["first"]["reason"]} for r in losses],
        "unmeasured_references": [{"request": request_body(e["case"]), "required": e["required"]}
                                  for e in missing],
        "missing_required": sum(e["required"] for e in missing),
    }
    (Path(out_dir) / "regression-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [f"# 路線規劃品質驗證（n={len(recs)}）", "", "比例皆附 Wilson 95% 區間；p95 附順序統計量 95% 區間。", ""]

    def first(r):
        return r["first"]
    n = len(recs)
    http_ok = sum(first(r)["status"] == 200 for r in recs)
    nonempty = sum(first(r)["routes"] > 0 for r in recs)
    usable = sum(first(r)["usable_routes"] > 0 for r in recs)
    feas = [r for r in recs if r["known_feasible"]]
    feas_hit = sum(usable_answer(r) for r in feas)
    feas_none = sum(first(r)["status"] != 200 or first(r)["routes"] == 0 for r in feas)
    no_candidates = [r for r in recs if r["oracle_observation"] == "observed_no_candidates"]
    lines += ["## 1. 可用性與找到路線", "", "| 指標 | 結果 |", "|---|---|",
              f"| HTTP 200 成功率 | {pct(http_ok, n)} |", f"| 非空候選率 | {pct(nonempty, n)} |",
              f"| 可用答案率（至少一條通過全部檢查） | {pct(usable, n)} |",
              f"| 已測已知可行樣本召回率（未測另列） | {pct(feas_hit, len(feas))} |",
              f"| 已知可行卻回無路線（錯判無路線率） | {pct(feas_none, len(feas))} |",
              f"| oracle 正向找到候選 | {sum(r['feasible'] is True for r in recs)} |",
              f"| oracle 短窗口未觀察到候選（可行性仍未知） | {len(no_candidates)} |",
              f"| oracle 其他未知／未適用 | {sum(r['feasible'] is None for r in recs) - len(no_candidates)} |",
              f"| 固定參照成功覆蓋率（全集含未測） | {pct(summary['reference_usable'], summary['reference_total'])} |",
              f"| 固定參照已配對／全集 | {summary['matched_references']} / {summary['reference_total']} |",
              f"| 已測固定參照失去可用答案 | {len(losses)} |",
              f"| 參照未測（不算成功）／其中必測案例 | {len(missing)} / {summary['missing_required']} |", "",
              "召回分母只使用 exact request 配對的固定參照或獨立 oracle 正向證據；不由本輪成功自行擴縮。",
              "2h oracle 空結果不能證明完整搜尋範圍內無路；已知可行也不是現地無障礙通行保證。", ""]
    for source in references["sources"]:
        lines.append(f"- 參照來源：{source['path']}；SHA256 `{source['sha256']}`")
    lines.append("")
    if losses:
        lines += ["固定參照退步（仍保留在召回分母）：", ""]
        for r in losses:
            lines.append(f"- #{r['id']} {r['mode']} {r['origin']}→{r['destination']} {r['departure']}: "
                         f"{first(r)['status']} {first(r)['reason'] or 'no usable answer'}")
        lines.append("")
    meta_path = Path(out_dir) / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    for item in meta.get("unmeasured_fixed_cases", []):
        lines.append(f"- 固定案例未發送：{item['reason']}；{item['request_identity']}")
    status_mix = defaultdict(int)
    for r in recs:
        status_mix[f"{first(r)['status']} {first(r)['reason'] or ''}".strip()] += 1
    lines += ["HTTP 狀態分布：" + "、".join(f"{k}×{v}" for k, v in sorted(status_mix.items(), key=lambda x: -x[1])), ""]

    routes = [(r, c) for r in recs for c in first(r)["checks"]]
    nr = len(routes)
    kinds = ["constraint", "geometry", "boarding", "timing"]
    lines += ["## 2. 安全與正確性", "", f"以回傳的 {nr} 條路線為分母。", "", "| 檢查 | 通過 |", "|---|---|"]
    names = {"constraint": "硬限制（轉乘上限／無階梯／無渡輪航空／步行改答帶 fallback）",
             "geometry": "幾何連續（非空、無直線、相鄰段 ≤150 m、起訖 ≤250 m）",
             "boarding": "可抵達上車（上車點與前一段 ≤150 m）", "timing": "可完成轉乘（時刻順序與步行時間）"}
    for k in kinds:
        lines.append(f"| {names[k]} | {pct(sum(not c[k] for _, c in routes), nr)} |")
    walk_m = sum(c["walk_m"] for _, c in routes)
    unknown_m = sum(c["unknown_walk_m"] for _, c in routes)
    low = sum(c["confidence"] == "low" for _, c in routes)
    lines += [f"| 步行段無障礙屬性未知的距離比例 | {100 * unknown_m / walk_m:.1f}%（{int(unknown_m)}/{int(walk_m)} m） |" if walk_m else "| 步行段未知比例 | — |",
              f"| dataConfidence=low 的路線 | {pct(low, nr)} |", ""]
    violations = [(r, c) for r, c in routes if any(c[k] for k in kinds)]
    if violations:
        lines += ["違規案例（前 20）：", ""]
        for r, c in violations[:20]:
            lines.append(f"- #{r['id']} {r['county']} {r['travel']} {r['need']} {r['band']} {r['slot']} "
                         f"{r['origin']}→{r['destination']}: " + "; ".join(x for k in kinds for x in c[k]))
        lines.append("")

    lines += ["## 3. 使用者等待時間", "", "| 分組 | n | p50 | p95 [95%] | p99 | max | ≤5 秒 | 逾時 |",
              "|---|---|---|---|---|---|---|---|"]
    lines.append(latency_row("首次請求（快取狀態未量測）", [first(r)["latency"] for r in recs], timeout))
    lines.append(latency_row("立即重送（快取狀態未量測）", [r["again"]["latency"] for r in recs if r.get("again")], timeout))
    lines.append(latency_row("首次・取得可用答案者", [first(r)["latency"] for r in recs if first(r)["usable_routes"]], timeout))
    for dim in ("travel", "band"):
        for key in sorted({r[dim] for r in recs}):
            lines.append(latency_row(f"{dim}={key}", [first(r)["latency"] for r in recs if r[dim] == key], timeout))
    lines += ["", "最慢 15 筆：", ""]
    for r in sorted(recs, key=lambda r: -first(r)["latency"])[:15]:
        lines.append(f"- {first(r)['latency']:.1f}s #{r['id']} {r['county']} {r['travel']} {r['need']} {r['band']} "
                     f"{r['slot']} {r['origin']}→{r['destination']} status={first(r)['status']} routes={first(r)['routes']}")
    lines.append("")

    lines += ["## 4. 可信程度", "", f"各維度邊際分組（n<{min_n} 標 ⚠️ 小樣本）。", ""]
    for dim in DIMENSIONS:
        lines += [f"### {dim}", "", "| 值 | n | 可用答案率 | 已測已知可行召回率（未測另列） | ≤5 秒 | p95 |", "|---|---|---|---|---|---|"]
        for key in sorted({r[dim] for r in recs}):
            group = [r for r in recs if r[dim] == key]
            gf = [r for r in group if r["known_feasible"]]
            lat = [first(r)["latency"] for r in group]
            flag = " ⚠️" if len(group) < min_n else ""
            label = COUNTIES.get(key, key)
            lines.append(f"| {label}{flag} | {len(group)} | {pct(sum(first(r)['usable_routes'] > 0 for r in group), len(group))} | "
                         f"{pct(sum(usable_answer(r) for r in gf), len(gf))} | "
                         f"{pct(sum(v <= 5 for v in lat), len(lat))} | {secs(quantile(lat, 0.95))} |")
        lines.append("")
    strata = defaultdict(list)
    for r in recs:
        strata[tuple(r[d] for d in DIMENSIONS)].append(r)
    small = sum(len(v) < min_n for v in strata.values())
    total_cells = len(COUNTIES) * 3 * len(NEEDS) * len(BANDS) * len(SLOT_TIMES)
    lines += [f"完整交叉分層：理論 {total_cells} 格，有樣本 {len(strata)} 格，其中 {small} 格 n<{min_n}；"
              f"最大格 n={max((len(v) for v in strata.values()), default=0)}。交叉格的比例不具統計意義，只能看邊際分組。", ""]
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--otp", default="http://localhost:18080")
    ap.add_argument("--feed", default="otp-data/feed-1.gtfs.zip")
    ap.add_argument("--n", type=int, default=250)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--repeat", type=float, default=0.3)
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument("--min-n", type=int, default=30)
    ap.add_argument("--oracle-workers", type=int, default=2)
    ap.add_argument("--oracle-only", action="store_true", help="rerun only the oracle pass for --out")
    ap.add_argument("--bands", help="comma-separated distance bands to keep, e.g. 20-80km,80km+")
    ap.add_argument("--out", default=os.path.join("logs", "route-eval", datetime.now(TAIPEI).strftime("%Y%m%d-%H%M")))
    ap.add_argument("--report-only", metavar="DIR")
    ap.add_argument("--baseline", action="append", default=[], metavar="PATH",
                    help="fixed reference records.jsonl or evaluation directory; match exact requests, repeatable")
    ap.add_argument("--known-feasible", action="append", default=[], metavar="PATH",
                    help="additional fixed-case JSON collection; bundled regression cases remain enabled")
    a = ap.parse_args()
    if a.report_only:
        result = report(a.report_only, a.min_n, a.timeout, a.baseline, a.known_feasible)
    elif a.oracle_only:
        run_oracle(a, load_records(a.out))
        result = report(a.out, a.min_n, a.timeout, a.baseline, a.known_feasible)
    else:
        result = run(a)
    return 1 if result["reference_losses"] or result["missing_required"] else 0


if __name__ == "__main__":
    sys.exit(main())
