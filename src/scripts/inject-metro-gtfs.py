#!/usr/bin/env python3
"""Inject metro / LRT frequency schedules into the TDX national GTFS zip.

Sibling of inject-tra-gtfs.py. The TDX national feed ships every metro line's
routes.txt + stops.txt rows, but its rail GTFS endpoint only emits trips for a
handful of TRTC/KRTC lines — so文湖線(TRTC BR)、環狀線(NTMC Y)、台中綠線(TMRT G)、
機捷一方向、淡海/安坑輕軌、貓空纜車 all carry ZERO trips. OTP can't board a line
with no trip, so every such leg silently fell through to the rate-limited TDX
MaaS planner (which returns bus instead). This converts the TDX Metro
S2STravelTime + Frequency APIs into a frequency-based GTFS schedule for ONLY
those gap lines, leaving the feed's working lines untouched.

Additionally, this script checks if existing metro trips in the feed are missing
their corresponding shape points in shapes.txt (a common TDX data issue for systems
like TMRT that have native trips but no shapes in shapes.txt). If missing, it fetches
the shapes from TDX and injects them under their native shape_ids.

Metro runs on headways, not numbered trains (unlike TRA), so each gap route
gets ONE template trip whose stop_times encode the ride-time pattern, plus a
single frequencies.txt window — OTP clones it across the day. One window per
trip (not TDX's gapped/overlapping headway bands) keeps the feed valid: the
build's gtfs-validator gate aborts on overlapping frequencies.

Mapping (all driven off S2STravelTime, which carries station names + ordering):
  gap route   route_type==1 feed routes that have NO trip after the idempotent
              strip below; system/variant parsed from the route_id
              (SYS_LINE_VARIANT_DIR, e.g. TRTC_BR_BR-1_0 → TRTC / BR-1 / dir 0)
  stations    chained from a matching S2STravelTime record (RouteID==variant);
              a single record is reversed to synthesise the opposite direction
  stop_times  arrival = Σ RunTime, departure += StopTime (seconds, from TDX);
              the template trip starts at the line's operation-start time
  frequencies headway = mean(Min,Max HeadwayMins) across the line, default 10m
              when Frequency is absent/malformed (fail-soft, same as the live
              fetchMetroHeadway fallback); window = OperationTime, default
              06:00–24:00
  calendar    one shared MRT_DAILY service, every day, EffectiveDate → +60d;
              the weekly graph rebuild rolls it forward
  routes      REUSED as-is — the feed already defines these route_ids, so this
              script never writes routes.txt (avoids duplicate-id validator errors)

Rows reference existing feed stops `{SYS}_{StationID}` (e.g. TRTC_BR13 松山機場);
a gap route whose stations are missing from the feed, or whose line has no TDX
S2STravelTime, is skipped and logged — it just stays 0-trips (no regression).

Idempotent: re-running first drops previously injected MRT_ rows.

Usage: inject-metro-gtfs.py <feed.zip> <metro-data-dir>
  where <metro-data-dir> holds {SYSTEM}.s2s.json, {SYSTEM}.freq.json, and
  {SYSTEM}.shape.json files (raw TDX /Rail/Metro/S2STravelTime/{SYSTEM},
  /Frequency/{SYSTEM}, and /Shape/{SYSTEM} responses).
"""
import csv
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from datetime import date, timedelta

CALENDAR_DAYS = 60
SERVICE_ID = "MRT_DAILY"
TRIP_PREFIX = "MRT_"
DEFAULT_HEADWAY_MIN = 10
DEFAULT_OP_START = 6 * 3600       # 06:00
DEFAULT_OP_END = 24 * 3600        # 24:00
# Fullwidth/halfwidth dashes + tilde used between terminals in route_long_name.
DASH_SPLIT = re.compile(r"[－—–\-~～]")

log = lambda *a: print("[inject-metro-gtfs]", *a)


def read_rows(zf, name):
    with zf.open(name) as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        return reader.fieldnames, list(reader)


def hhmm_to_sec(value):
    """'HH:MM' (or 'HH:MM:SS', '24:00') → seconds; None when malformed."""
    if not value:
        return None
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", value.strip())
    if not m:
        return None
    return int(m[1]) * 3600 + int(m[2]) * 60 + (int(m[3]) if m[3] else 0)


def hms(sec):
    """Seconds → 'HH:MM:SS', preserving GTFS times past 24:00:00."""
    sec = int(round(sec))
    return f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}"


def zh(name_obj):
    return (name_obj or {}).get("Zh_tw", "") if isinstance(name_obj, dict) else ""


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def parse_route_id(route_id):
    """SYS_LINE_VARIANT_DIR → (system, lineId, variant, direction). Defensive."""
    parts = route_id.split("_")
    if len(parts) < 3:
        return None
    has_dir = parts[-1] in ("0", "1")
    direction = parts[-1] if has_dir else "0"
    variant = parts[-2] if has_dir else parts[-1]
    return parts[0], parts[1], variant, direction


def chain_from_record(record):
    """S2STravelTime record → (stations, legs), or ([], []) if not a line chain.

    stations: [(StationID, Zh_name), ...] in travel order.
    legs:     [(RunTime, StopTime), ...] — RunTime to reach station i+1,
              StopTime dwell once there. Both seconds, straight from TDX.

    Some systems (e.g. TYMC) return a FULL station-to-station matrix instead of
    adjacent-only segments; chaining that yields ~n² bogus stops. We accept the
    record only when its sorted segments form a contiguous, repeat-free path
    (seg[i].To == seg[i+1].From) — i.e. genuine adjacent legs. A matrix fails
    this and the variant is skipped (stays 0-trips, no garbage in the feed).
    """
    tts = sorted(record.get("TravelTimes", []), key=lambda t: t.get("Sequence", 0))
    if not tts:
        return [], []
    stations = [(tts[0]["FromStationID"], zh(tts[0].get("FromStationName")))]
    legs = []
    seen = {tts[0]["FromStationID"]}
    for i, seg in enumerate(tts):
        if i > 0 and seg["FromStationID"] != tts[i - 1]["ToStationID"]:
            return [], []  # non-contiguous → full matrix, not a line path
        to_id = seg["ToStationID"]
        if to_id in seen:
            return [], []  # repeated station → not a simple path
        seen.add(to_id)
        stations.append((to_id, zh(seg.get("ToStationName"))))
        legs.append((seg.get("RunTime", 0) or 0, seg.get("StopTime", 0) or 0))
    return stations, legs


def reverse_chain(stations, legs):
    return stations[::-1], legs[::-1]


def stop_times_for(stations, legs, start_sec, system, valid_stop_ids):
    """Build stop_time rows; drop stations absent from the feed (data drift)."""
    rows = []
    t = start_sec
    for i, (sid, _name) in enumerate(stations):
        if i > 0:
            run, stop = legs[i - 1]
            t += run
            arr = t
            t += stop
            dep = t
        else:
            arr = dep = t
        feed_stop = f"{system}_{sid}"
        if feed_stop not in valid_stop_ids:
            continue  # skip the station, keep the trip (mirrors TRA)
        rows.append((feed_stop, arr, dep))
    return rows


def main(zip_path, metro_dir):
    start = date.today()
    start_date = start.strftime("%Y%m%d")
    end_date = (start + timedelta(days=CALENDAR_DAYS)).strftime("%Y%m%d")

    with zipfile.ZipFile(zip_path) as zf:
        routes_fields, routes = read_rows(zf, "routes.txt")
        trips_fields, trips = read_rows(zf, "trips.txt")
        cal_fields, calendar = read_rows(zf, "calendar.txt")
        st_fields, stop_times = read_rows(zf, "stop_times.txt")
        freq_fields, freqs = read_rows(zf, "frequencies.txt")
        valid_stop_ids = {r["stop_id"] for r in read_rows(zf, "stops.txt")[1]}

        # Load existing valid shape IDs (skipping previous injected shape IDs)
        valid_shape_ids = set()
        if "shapes.txt" in zf.namelist():
            with zf.open("shapes.txt") as f:
                wrapper = io.TextIOWrapper(f, encoding="utf-8-sig")
                wrapper.readline()  # skip header
                for line in wrapper:
                    parts = line.split(',', 1)
                    if parts:
                        sid = parts[0]
                        if not sid.startswith(TRIP_PREFIX):
                            valid_shape_ids.add(sid)

        # ── Idempotency: strip a previous injection (everything we add is MRT_-keyed) ──
        before = (len(trips), len(calendar), len(stop_times), len(freqs))
        trips = [r for r in trips if not r["trip_id"].startswith(TRIP_PREFIX)]
        calendar = [r for r in calendar if r["service_id"] != SERVICE_ID]
        stop_times = [r for r in stop_times if not r["trip_id"].startswith(TRIP_PREFIX)]
        freqs = [r for r in freqs if not r["trip_id"].startswith(TRIP_PREFIX)]
        stripped = tuple(b - len(x) for b, x in zip(
            before, (trips, calendar, stop_times, freqs)))
        if any(stripped):
            log(f"stripped previous injection: trips={stripped[0]} "
                f"calendar={stripped[1]} stop_times={stripped[2]} freq={stripped[3]}")

        # ── Gap detection: route_type==1 routes with no trip (post-strip) ──
        routes_with_trips = {r["route_id"] for r in trips}
        routes_by_id = {r["route_id"]: r for r in routes}
        gap_routes = sorted(
            rid for rid, r in routes_by_id.items()
            if (r.get("route_type") or "").strip() == "1"
            and rid not in routes_with_trips
        )

        # Group gap routes by (system, line_id, variant): the two directions share a source.
        by_variant = {}
        for rid in gap_routes:
            parsed = parse_route_id(rid)
            if not parsed:
                continue
            system, line_id, variant, _dir = parsed
            by_variant.setdefault((system, line_id, variant), []).append(rid)

        # Lazily load each system's TDX data once.
        s2s_cache, freq_cache, shape_cache = {}, {}, {}

        def s2s_records(system, line_id, variant):
            if system not in s2s_cache:
                s2s_cache[system] = load_json(os.path.join(metro_dir, f"{system}.s2s.json"))
            recs = [r for r in s2s_cache[system] if r.get("RouteID") == variant]
            if not recs:  # some lines key only by LineID (single variant)
                recs = [r for r in s2s_cache[system] if r.get("LineID") == line_id]
            return recs

        def headway_secs(system, line_id, variant):
            if system not in freq_cache:
                freq_cache[system] = load_json(os.path.join(metro_dir, f"{system}.freq.json"))
            recs = [r for r in freq_cache[system] if r.get("RouteID") == variant] \
                or [r for r in freq_cache[system] if r.get("LineID") == line_id]
            vals, op_start, op_end = [], None, None
            for r in recs:
                for h in r.get("Headways", []):
                    nums = [v for v in (h.get("MinHeadwayMins"), h.get("MaxHeadwayMins"))
                            if isinstance(v, (int, float))]
                    if nums:
                        vals.append(sum(nums) / len(nums))
                ot = r.get("OperationTime") or {}
                s, e = hhmm_to_sec(ot.get("StartTime")), hhmm_to_sec(ot.get("EndTime"))
                if s is not None and e is not None and op_start is None:
                    op_start, op_end = s, (e + 24 * 3600 if e <= s else e)
            hw = round((sum(vals) / len(vals) if vals else DEFAULT_HEADWAY_MIN) * 60)
            return hw, (op_start if op_start is not None else DEFAULT_OP_START), \
                (op_end if op_end is not None else DEFAULT_OP_END)

        def load_shapes(system):
            if system not in shape_cache:
                shape_cache[system] = load_json(os.path.join(metro_dir, f"{system}.shape.json"))
            return shape_cache[system]

        def parse_geometry(geometry_str):
            if not geometry_str:
                return []
            # Strip geometry type and all parentheses to handle LINESTRING and MULTILINESTRING robustly
            cleaned = geometry_str.replace("MULTILINESTRING", "").replace("LINESTRING", "")
            cleaned = cleaned.replace("(", "").replace(")", "").strip()
            coords = []
            for pt in cleaned.split(','):
                parts = pt.strip().split()
                if len(parts) == 2:
                    try:
                        lon, lat = float(parts[0]), float(parts[1])
                        coords.append((lat, lon))
                    except ValueError:
                        continue
            return coords

        def find_shape(system, line_id, variant, direction):
            shapes = load_shapes(system)
            if not shapes:
                return []
            dir_val = str(direction)
            match = None
            # 1. Exact RouteID and Direction
            for s in shapes:
                if s.get("RouteID") == variant and str(s.get("Direction", "")) == dir_val:
                    match = s
                    break
            # 2. RouteID only
            if not match:
                for s in shapes:
                    if s.get("RouteID") == variant:
                        match = s
                        break
            # 3. LineID and Direction
            if not match:
                for s in shapes:
                    if s.get("LineID") == line_id and str(s.get("Direction", "")) == dir_val:
                        match = s
                        break
            # 4. LineID only
            if not match:
                for s in shapes:
                    if s.get("LineID") == line_id:
                        match = s
                        break
            if not match:
                return []
            coords = parse_geometry(match.get("Geometry"))
            matched_dir = str(match.get("Direction", ""))
            # If shape is direction-agnostic (or Direction=0) and direction is 1, reverse points
            if direction == "1" and (matched_dir == "" or matched_dir == "0"):
                coords = coords[::-1]
            return coords

        new_trips, new_st, new_freq = [], [], []
        new_shapes = {}
        covered, skipped = [], []

        # ── Step 1: Gap routes (no trips in feed) ──
        for (system, line_id, variant), rids in sorted(by_variant.items()):
            recs = s2s_records(system, line_id, variant)
            if not recs:
                skipped.append(f"{system}/{variant} (no S2STravelTime)")
                continue
            # One chain per S2S record; reverse a lone record to get both directions.
            chains = [chain_from_record(r) for r in recs]
            chains = [c for c in chains if len(c[0]) >= 2]
            if not chains:
                skipped.append(f"{system}/{variant} (empty travel times)")
                continue
            if len(chains) == 1:
                chains.append(reverse_chain(*chains[0]))

            hw_secs, op_start, op_end = headway_secs(system, line_id, variant)

            for rid in rids:
                _sys, _line, _var, direction = parse_route_id(rid)
                long_name = (routes_by_id[rid].get("route_long_name")
                             or routes_by_id[rid].get("route_short_name") or "")
                origin_term = DASH_SPLIT.split(long_name)[0].strip()
                # Prefer the chain whose first station matches the route's origin
                # terminal; fall back to direction index when names don't line up.
                chosen = next(
                    (c for c in chains
                     if origin_term and c[0] and c[0][0][1]
                     and (c[0][0][1] in origin_term or origin_term in c[0][0][1])),
                    chains[int(direction) % len(chains)],
                )
                rows = stop_times_for(chosen[0], chosen[1], op_start, system, valid_stop_ids)
                if len(rows) < 2:
                    skipped.append(f"{rid} (<2 stations in feed)")
                    continue
                trip_id = f"{TRIP_PREFIX}{rid}"
                
                # Fetch rail line shape geometry
                shape_id = f"{TRIP_PREFIX}{rid}"
                shape_pts = find_shape(system, line_id, variant, direction)
                if shape_pts:
                    new_shapes[shape_id] = shape_pts
                    shape_val = shape_id
                else:
                    shape_val = ""

                new_trips.append({
                    "route_id": rid, "service_id": SERVICE_ID, "trip_id": trip_id,
                    "shape_id": shape_val, "direction_id": direction, "bikes_allowed": "",
                })
                for seq, (stop_id, arr, dep) in enumerate(rows, start=1):
                    new_st.append({
                        "trip_id": trip_id, "arrival_time": hms(arr),
                        "departure_time": hms(dep), "stop_id": stop_id,
                        "stop_sequence": str(seq),
                    })
                new_freq.append({
                    "trip_id": trip_id, "start_time": hms(op_start),
                    "end_time": hms(op_end), "headway_secs": str(hw_secs),
                })
                covered.append(f"{rid}({len(rows)}st,{hw_secs // 60}m,shape:{bool(shape_pts)})")

        # ── Step 2: Non-gap routes (already have trips, but shape is missing from shapes.txt) ──
        # A sibling trip's shape on the same route+direction beats anything we can
        # look up: it is already carried by trips with this stop sequence, so OTP
        # is known to accept it. find_shape's LineID fallbacks, by contrast, can
        # return a whole-line geometry for a branch (or the reverse orientation),
        # which OTP silently discards as unfit — leaving straight lines.
        sibling_shape = {}
        for t in trips:
            sid = t.get("shape_id")
            if sid and sid in valid_shape_ids:
                sibling_shape.setdefault((t["route_id"], t.get("direction_id") or ""), sid)

        # Check existing trips for missing shape data
        adopted_sibling_shapes = 0
        injected_native_shapes = 0
        for trip in trips:
            # Skip injected MRT_ trips
            if trip["trip_id"].startswith(TRIP_PREFIX):
                continue
            rid = trip["route_id"]
            shape_id = trip.get("shape_id")
            if shape_id and (shape_id in valid_shape_ids or shape_id in new_shapes):
                continue

            # Check if this route is a metro route (type 1)
            route = routes_by_id.get(rid)
            if not route or (route.get("route_type") or "").strip() != "1":
                continue

            # Parse route details
            parsed = parse_route_id(rid)
            if not parsed:
                continue
            system, line_id, variant, direction = parsed

            # Find shapes for this trip
            # A blank direction_id column is as good as absent: passing "" on to
            # find_shape defeats its reverse-for-direction-1 check, which would
            # hang a direction-agnostic shape on the trip backwards.
            direction_id = trip.get("direction_id") or direction

            # Trips that arrive with no shape_id at all (the official TRTC 文湖線
            # graft writes an empty one) would otherwise render as station-to-
            # station straight lines: adopt a sibling's shape, and only mint one
            # from the Metro API when the route has no usable shape anywhere.
            if not shape_id:
                adopted = (sibling_shape.get((rid, direction_id))
                           or sibling_shape.get((rid, "")))
                if adopted:
                    trip["shape_id"] = adopted
                    adopted_sibling_shapes += 1
                    continue

            shape_pts = find_shape(system, line_id, variant, direction_id)
            if not shape_pts:
                continue
            if not shape_id:
                shape_id = f"{TRIP_PREFIX}NAT_{rid}_{direction_id}"
                trip["shape_id"] = shape_id
                if shape_id in valid_shape_ids or shape_id in new_shapes:
                    continue
            new_shapes[shape_id] = shape_pts
            injected_native_shapes += 1
            # Mark as valid so we don't process it multiple times
            valid_shape_ids.add(shape_id)

        if new_trips:
            calendar.append({
                "service_id": SERVICE_ID,
                "monday": "1", "tuesday": "1", "wednesday": "1", "thursday": "1",
                "friday": "1", "saturday": "1", "sunday": "1",
                "start_date": start_date, "end_date": end_date,
            })

        log(f"injecting: trips={len(new_trips)} stop_times={len(new_st)} "
            f"freq={len(new_freq)} gap_shapes={len(new_shapes) - injected_native_shapes} "
            f"native_shapes={injected_native_shapes} "
            f"adopted_sibling_shapes={adopted_sibling_shapes} calendar {start_date}–{end_date}")
        log("covered: " + (", ".join(covered) if covered else "(none)"))
        if skipped:
            log("skipped: " + ", ".join(skipped))

        _rewrite(zip_path, zf, {
            "trips.txt": (trips_fields, trips + new_trips),
            "calendar.txt": (cal_fields, calendar),
            "stop_times.txt": (st_fields, stop_times + new_st),
            "frequencies.txt": (freq_fields, freqs + new_freq),
        }, new_shapes)
    log(f"rewrote {zip_path}")


def _rewrite(zip_path, zf, rewritten, new_shapes=None):
    """Stream every entry through, replacing the rewritten ones."""
    with tempfile.NamedTemporaryFile(dir=os.path.dirname(zip_path) or ".",
                                     suffix=".zip", delete=False) as tmp:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
            for name in zf.namelist():
                if name in rewritten:
                    fields, rows = rewritten[name]
                    buf = io.StringIO()
                    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
                    w.writeheader()
                    w.writerows(rows)
                    out.writestr(name, buf.getvalue())
                elif name == "shapes.txt" and new_shapes is not None:
                    # Write shapes in streaming mode to keep memory usage low
                    with out.open("shapes.txt", "w") as f:
                        wrapper = io.TextIOWrapper(f, encoding="utf-8")
                        wrapper.write("shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n")
                        
                        # Copy existing shapes (skipping old injected shapes)
                        if "shapes.txt" in zf.namelist():
                            with zf.open("shapes.txt") as in_f:
                                in_wrapper = io.TextIOWrapper(in_f, encoding="utf-8-sig")
                                in_wrapper.readline() # skip original header
                                for line in in_wrapper:
                                    if line.startswith(TRIP_PREFIX):
                                        continue
                                    wrapper.write(line)
                        
                        # Append new shapes
                        for shape_id, points in new_shapes.items():
                            for seq, (lat, lon) in enumerate(points, start=1):
                                wrapper.write(f"{shape_id},{lat},{lon},{seq}\n")
                        # The wrapper outlives the `with`, so its buffer must be
                        # pushed down before the zip member closes — otherwise the
                        # tail (i.e. exactly these injected shapes) is dropped.
                        wrapper.flush()
                else:
                    out.writestr(name, zf.read(name))
            
            # If shapes.txt did not exist at all, write it now
            if "shapes.txt" not in zf.namelist() and new_shapes:
                with out.open("shapes.txt", "w") as f:
                    wrapper = io.TextIOWrapper(f, encoding="utf-8")
                    wrapper.write("shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n")
                    for shape_id, points in new_shapes.items():
                        for seq, (lat, lon) in enumerate(points, start=1):
                            wrapper.write(f"{shape_id},{lat},{lon},{seq}\n")
                    wrapper.flush()

        tmp_path = tmp.name
    os.replace(tmp_path, zip_path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
