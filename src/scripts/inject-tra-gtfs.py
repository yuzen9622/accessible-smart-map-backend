#!/usr/bin/env python3
"""Inject the TRA timetable into the TDX national GTFS zip (Phase 16.5).

Two modes, chosen per run:

  native   (2026-10 onward) the TDX national feed itself carries a dated TRA
           timetable: one trip per train per service date (calendar_dates),
           ~59 days ahead, with track shapes. When it covers at least
           NATIVE_MIN_DAYS ahead it is KEPT as-is — it is strictly more
           accurate than a weekly pattern (holidays, one-off changes) — and
           enriched with what it lacks: route_long_name gets the train
           type (區間/自強/…, which the backend shows as trainTypeName) and
           trips of WheelChairFlag=1 trains get wheelchair_accessible=1.
           Stop sequences farther than 500 m from their assigned shape are
           rebuilt from TRA track geometry. Unrepairable patterns abort without
           replacing the input zip. Only stale injected rows are removed.
  inject   fallback when the feed has no usable TRA timetable (the original
           behaviour documented below).

TDX ships TRA stops/agency in the national feed but no timetable (routes/
trips/calendar are absent), and its rail GTFS endpoint only serves TRTC —
so OTP could never plan a TRA leg and every 台鐵 itinerary depended on the
rate-limited TDX MaaS API. This script converts the TRA v3
GeneralTrainTimetable JSON into GTFS rows referencing the feed's existing
`TRA_<StationID>` stops (all timetable stations are present, verified
2026-06-12).

Mapping notes:
  routes.txt    one route per TrainTypeCode (區間/自強/…), route_id TRA_<code>
                so systemFromId() yields "TRA" downstream
  calendar.txt  one service per distinct Mon–Sun pattern; the feed publishes
                EffectiveDate == ExpireDate (a "current version" snapshot),
                so validity runs EffectiveDate → +45 days and relies on the
                weekly rebuild to roll forward. NationalHolidays /
                DayBeforeHoliday flags are NOT expressible in calendar.txt
                and are ignored (same drift class as any static GTFS).
  trips.txt     trip_id TRA_<TrainNo> (unique; trainNoFromTripId() parses
                this), wheelchair_accessible=1 when WheelChairFlag=1, empty
                (unknown) otherwise — 0-flagged trains are NOT marked
                inaccessible, or router-config's 3600s inaccessibleCost
                would funnel wheelchair plans onto the 164 flagged trains.
  stop_times.txt cross-midnight stops emit GTFS 24+h times (25:10:00);
                the offset is detected from decreasing clock values.
  shapes.txt    when the optional TRA Shape JSON (TDX Rail/TRA/Shape, WKT
                LINESTRING per line) is supplied, each trip gets a real
                track-following shape: every consecutive stop pair is
                projected onto the nearest TRA line geometry and the matching
                sub-polyline sliced out, then the per-hop slices are stitched
                into one shape (TRA_SHP_<n>). Shapes are deduped by stop
                sequence, so the ~900 trips collapse to a few hundred shapes.
                A hop whose stations sit > SHAPE_PERP_MAX off every line
                (junctions, lines absent from the Shape feed) falls back to a
                straight segment for that hop only. Without the Shape JSON the
                trip keeps shape_id="" (OTP then draws station-to-station
                straight lines, the legacy behaviour).

Idempotent: re-running first drops previously injected TRA_ rows (and
TRA_SHP_ shapes).

Usage: inject-tra-gtfs.py <feed.zip> <general-train-timetable.json> [<tra-shape.json>]
"""
import csv
import io
import json
import hashlib
import heapq
import re
import os
import sys
import tempfile
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from tra_shape_geometry import (
    MY, Shape, coordinates, find_misaligned_patterns, load_tra_geometry,
)

CALENDAR_DAYS = 45
NATIVE_MIN_DAYS = 14
TAIPEI = timezone(timedelta(hours=8))
INJECTED_SERVICE_PREFIX = "TRA_SVC_"
INJECTED_ROUTE = re.compile(r"^TRA_[^_]+$")
DAY_KEYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
            "Saturday", "Sunday")

# Shape generation ----------------------------------------------------------
SHAPE_PREFIX = "TRA_SHP_"
REPAIRED_SHAPE_PREFIX = "TRA_REPAIRED_"
SHAPE_PERP_MAX = 600.0  # m — reject a line whose track sits farther from a stop
SHAPE_JOIN_MAX = 10.0   # m — only join separate parts where their tracks meet


def read_rows(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        reader = csv.DictReader(text)
        return reader.fieldnames, list(reader)


def hms(value: str) -> str:
    return value if value.count(":") == 2 else value + ":00"


def minutes_of(value: str) -> int:
    h, m = value.split(":")[:2]
    return int(h) * 60 + int(m)


def plus24(value: str) -> str:
    h, rest = value.split(":", 1)
    return f"{int(h) + 24}:{rest}"


def parse_wkt(geom: str):
    """Parse a WKT (MULTI)LINESTRING into [(lon, lat), …]."""
    s = geom.replace("MULTILINESTRING", "").replace("LINESTRING", "")
    s = s.replace("(", " ").replace(")", " ").replace(",", " ")
    n = s.split()
    return [(float(n[i]), float(n[i + 1])) for i in range(0, len(n) - 1, 2)]




class TraShaper:
    """Builds a track-following shape for a trip's ordered stop list.

    Each consecutive stop pair is sliced from the nearest fitting line and the
    slices stitched together. Per-hop results are memoised on (from, to) — the
    network has only ~245 stations, so a few hundred distinct hops cover every
    trip.
    """

    def __init__(self, shapes, coord, connect_lines=False):
        self.shapes = shapes
        self.coord = coord
        self.connect_lines = connect_lines
        self._line_graph = None
        self._line_coord = None
        self.bbox_pad = SHAPE_PERP_MAX / MY + 0.005  # deg envelope around a line
        self._hop = {}

    def _fits(self, bbox, lon, lat) -> bool:
        pad = self.bbox_pad
        return (bbox[0] - pad <= lon <= bbox[2] + pad
                and bbox[1] - pad <= lat <= bbox[3] + pad)

    def _hop_geom(self, a_id: str, b_id: str):
        key = (a_id, b_id)
        cached = self._hop.get(key)
        if cached is not None:
            return cached
        a = self.coord.get(a_id)
        b = self.coord.get(b_id)
        if not a or not b:
            self._hop[key] = []
            return []
        best = None
        for sh in self.shapes:
            if not (self._fits(sh.bbox, a[0], a[1])
                    and self._fits(sh.bbox, b[0], b[1])):
                continue
            pa = sh.project(a[0], a[1])
            pb = sh.project(b[0], b[1])
            err = pa[1] if pa[1] > pb[1] else pb[1]
            if best is None or err < best[0]:
                best = (err, sh, pa, pb)
        if best and best[0] <= SHAPE_PERP_MAX:
            _, sh, pa, pb = best
            geom = [a] + sh.slice(pa[0], pb[0]) + [b]
        elif self.connect_lines:
            geom = self._connected_hop_geom(a_id, b_id)
        else:
            geom = [a, b]  # no fitting line: straight segment for this hop only
        self._hop[key] = geom
        return geom

    def _connected_hop_geom(self, start, end):
        """Connect line slices at shared stations or matching track endpoints.

        Used for native repairs, which may not fall back to a straight hop.
        Edges follow actual track geometry; distance is along the track plus
        station connectors. Parts may end between stations (e.g. Taoyuan);
        their endpoints must lie within 10 m of another track to join it.
        """
        if self._line_graph is None:
            graph = {}
            nodes = dict(self.coord)
            junctions = set()
            for index, shape in enumerate(self.shapes):
                for end_index in (0, -1):
                    sid = f"@track_{index}_{end_index}"
                    nodes[sid] = (shape.lon[end_index], shape.lat[end_index])
                    junctions.add(sid)
            for shape in self.shapes:
                projected = []
                for sid, (lon, lat) in nodes.items():
                    if self._fits(shape.bbox, lon, lat):
                        along, perp, _, _ = shape.project(lon, lat)
                        limit = SHAPE_JOIN_MAX if sid in junctions else SHAPE_PERP_MAX
                        if perp <= limit:
                            projected.append((along, sid, perp))
                projected.sort()
                for (da, a, pa), (db, b, pb) in zip(projected, projected[1:]):
                    cost = db - da + pa + pb
                    graph.setdefault(a, []).append((b, cost, shape, da, db))
                    graph.setdefault(b, []).append((a, cost, shape, db, da))
            self._line_graph = graph
            self._line_coord = nodes
        queue, distances, previous = [(0.0, start)], {start: 0.0}, {}
        while queue:
            distance, sid = heapq.heappop(queue)
            if distance != distances[sid]:
                continue
            if sid == end:
                break
            for to, cost, shape, da, db in self._line_graph.get(sid, []):
                candidate = distance + cost
                if candidate < distances.get(to, float("inf")):
                    distances[to] = candidate
                    previous[to] = (sid, shape, da, db)
                    heapq.heappush(queue, (candidate, to))
        if end not in distances:
            return []
        slices, sid = [], end
        while sid != start:
            before, shape, da, db = previous[sid]
            slices.append([self._line_coord[before]] + shape.slice(da, db) + [self._line_coord[sid]])
            sid = before
        return [point for segment in reversed(slices) for point in segment]

    def build(self, stop_ids):
        """Return the trip's stitched shape as [(lon, lat), …] (dups dropped)."""
        out = []
        for i in range(len(stop_ids) - 1):
            for p in self._hop_geom(stop_ids[i], stop_ids[i + 1]):
                if not out or out[-1] != p:
                    out.append(p)
        return out


def load_tra_shapes(shape_path: str, split_parts=False):
    """Load TDX Rail/TRA/Shape JSON into a list of Shape (or [] on any issue)."""
    try:
        data = json.load(open(shape_path, encoding="utf-8"))
    except (OSError, ValueError):
        return []
    records = data.get("Shapes") if isinstance(data, dict) else data
    shapes = []
    for rec in records or []:
        geom = rec.get("Geometry") or ""
        # MULTILINESTRING components are not consecutive track segments. Native
        # repairs connect them via real shared stations, never by flattening WKT.
        parts = re.findall(r"\(([^()]*)\)", geom) if split_parts else [geom]
        for part in parts:
            pts = [coordinates(*p) for p in parse_wkt(part)]
            if len(pts) >= 2:
                shapes.append(Shape(pts))
    return shapes


def is_injected_trip(row) -> bool:
    return row["service_id"].startswith(INJECTED_SERVICE_PREFIX)


def native_tra_window(zf: zipfile.ZipFile, trips, calendar):
    """Service-date range of the feed's own TRA timetable, when it is usable.

    Returns (first, last) "YYYYMMDD" when TDX's native TRA trips run at least
    NATIVE_MIN_DAYS ahead of today (Asia/Taipei), otherwise None.
    """
    services = {r["service_id"] for r in trips
                if r["trip_id"].startswith("TRA_") and not is_injected_trip(r)}
    if not services:
        return None
    dates = set()
    for r in calendar:
        if r["service_id"] in services:
            dates.update((r["start_date"], r["end_date"]))
    if "calendar_dates.txt" in zf.namelist():
        for r in read_rows(zf, "calendar_dates.txt")[1]:
            if r["service_id"] in services and r.get("exception_type") == "1":
                dates.add(r["date"])
    if not dates:
        return None
    today = datetime.now(TAIPEI).date()
    horizon = (today + timedelta(days=NATIVE_MIN_DAYS)).strftime("%Y%m%d")
    first, last = min(dates), max(dates)
    return (first, last) if last >= horizon else None


def repair_native_shapes(zf, trips, tra_shapes, log):
    """Repair only misassigned native shapes; abort before writing on failure."""
    coord, patterns, shapes = load_tra_geometry(zf, trips)
    failures = find_misaligned_patterns(coord, patterns, shapes)
    log(f"native TRA shape check: {len(failures)}/{len(patterns)} patterns misaligned")
    if not failures:
        return {}, set()
    if not tra_shapes:
        raise ValueError("native TRA shapes are misaligned; usable TRA Shape JSON is required")
    shaper = TraShaper(tra_shapes, coord, connect_lines=True)
    replacements, repaired_trips, new_shapes = {}, set(), {}
    for key, stop, distance in failures:
        old_shape, seq = key
        if len(seq) < 2 or any(s not in coord for s in seq):
            raise ValueError(f"cannot repair TRA pattern {old_shape}: missing stops/coordinates")
        shape_id = REPAIRED_SHAPE_PREFIX + hashlib.sha256(
            json.dumps(seq, separators=(",", ":")).encode("utf-8")).hexdigest()[:20]
        if shape_id not in new_shapes:
            points = shaper.build(seq)
            # TraShaper's legacy fallback includes the stations and would pass
            # a distance check even if the entire hop were a straight line.
            unsupported = [(a, b) for a, b in zip(seq, seq[1:])
                           if len(shaper._hop[(a, b)]) <= 2]
            if unsupported or len(points) < 2:
                raise ValueError(f"cannot repair TRA pattern {old_shape}: "
                                 f"no track geometry for hops {unsupported}")
            shape = Shape(points)
            if find_misaligned_patterns(coord, {(shape_id, seq): []}, {shape_id: shape}):
                raise ValueError(f"rebuilt TRA shape {shape_id} failed alignment")
            new_shapes[shape_id] = shape
        for tid in patterns[key]:
            replacements[tid] = shape_id
            repaired_trips.add(tid)
        log(f"repaired {old_shape} -> {shape_id}: trips={len(patterns[key])}, "
            f"worst_stop={stop}, distance={distance:.0f}m")
    for trip in trips:
        if trip["trip_id"] in replacements:
            trip["shape_id"] = replacements[trip["trip_id"]]
    log(f"native TRA shapes repaired: {len(new_shapes)} shapes, {len(repaired_trips)} trips")
    return new_shapes, repaired_trips


def write_native_shapes(zf, out, new_shapes, referenced_shapes):
    """Stream original columns/rows unchanged; append only repaired shapes."""
    has_shapes = "shapes.txt" in zf.namelist()
    with out.open("shapes.txt", "w") as raw:
        dst = io.TextIOWrapper(raw, encoding="utf-8")
        fields = ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]
        needs_newline = False
        if has_shapes:
            with zf.open("shapes.txt") as in_f:
                src = io.TextIOWrapper(in_f, encoding="utf-8-sig", newline="")
                header = src.readline()
                fields = next(csv.reader([header]))
                id_index = fields.index("shape_id")
                dst.write(header)
                needs_newline = not header.endswith(("\n", "\r"))
                for line in src:
                    sid = next(csv.reader([line]))[id_index]
                    if sid in new_shapes:
                        continue
                    if sid.startswith((SHAPE_PREFIX, REPAIRED_SHAPE_PREFIX)) and sid not in referenced_shapes:
                        continue
                    dst.write(line)
                    needs_newline = not line.endswith(("\n", "\r"))
        else:
            csv.writer(dst).writerow(fields)
        if new_shapes and needs_newline:
            dst.write("\n")
        writer = csv.DictWriter(dst, fieldnames=fields, extrasaction="ignore")
        for sid, shape in new_shapes.items():
            for seq, (lon, lat, distance) in enumerate(zip(shape.lon, shape.lat, shape.cd), 1):
                writer.writerow({"shape_id": sid, "shape_pt_lat": lat, "shape_pt_lon": lon,
                                 "shape_pt_sequence": seq, "shape_dist_traveled": distance})
        dst.flush()


@contextmanager
def native_feed_output(zip_path):
    """Same-filesystem atomic replacement; failed writes leave no stray ZIP."""
    with tempfile.NamedTemporaryFile(dir=os.path.dirname(os.path.abspath(zip_path)),
                                     suffix=".zip", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        yield tmp_path
        os.replace(tmp_path, zip_path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def enrich_native(zf, zip_path, log, routes_fields, routes, trips_fields,
                  trips, cal_fields, calendar, timetables, first, last, tra_shapes):
    """Keep the native TRA timetable; add train types and wheelchair flags."""
    info_by_train = {tt["TrainInfo"]["TrainNo"]: tt["TrainInfo"] for tt in timetables}
    type_by_id = {tt["TrainInfo"]["TrainTypeID"]: tt["TrainInfo"]["TrainTypeName"]["Zh_tw"]
                  for tt in timetables}

    stale_routes = {r["route_id"] for r in routes if INJECTED_ROUTE.match(r["route_id"])}
    stale_trips = {r["trip_id"] for r in trips if is_injected_trip(r)}
    routes = [r for r in routes if r["route_id"] not in stale_routes]
    trips = [r for r in trips if r["trip_id"] not in stale_trips]
    calendar = [r for r in calendar
                if not r["service_id"].startswith(INJECTED_SERVICE_PREFIX)]
    new_shapes, repaired_trips = repair_native_shapes(zf, trips, tra_shapes, log)
    referenced_shapes = {r.get("shape_id", "") for r in trips}
    if new_shapes and "shape_id" not in trips_fields:
        trips_fields = list(trips_fields) + ["shape_id"]
    if "wheelchair_accessible" not in trips_fields:
        trips_fields = list(trips_fields) + ["wheelchair_accessible"]

    named = 0
    for r in routes:
        rid = r["route_id"]
        if not rid.startswith("TRA_"):
            continue
        parts = rid.split("_")
        info = info_by_train.get(parts[1]) if len(parts) > 1 else None
        name = (info["TrainTypeName"]["Zh_tw"] if info
                else type_by_id.get(parts[-1]))
        if name:
            r["route_long_name"] = name
            named += 1
    flagged = 0
    native_trips = 0
    for r in trips:
        if not r["trip_id"].startswith("TRA_"):
            continue
        native_trips += 1
        info = info_by_train.get(r["trip_id"].split("_")[1])
        if info and info.get("WheelChairFlag") == 1:
            r["wheelchair_accessible"] = "1"
            flagged += 1
    log(f"native TRA timetable kept: trips={native_trips} service dates "
        f"{first}–{last}; train types set on {named} routes, "
        f"wheelchair_accessible=1 on {flagged} trips"
        + (f"; removed earlier injection routes={len(stale_routes)} "
           f"trips={len(stale_trips)}" if stale_routes or stale_trips else ""))

    rewritten = {
        "routes.txt": (routes_fields, routes),
        "trips.txt": (trips_fields, trips),
        "calendar.txt": (cal_fields, calendar),
    }
    with native_feed_output(zip_path) as tmp_path:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as out:
            for name in zf.namelist():
                if name in rewritten:
                    fields, rows = rewritten[name]
                    buf = io.StringIO()
                    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
                    w.writeheader()
                    w.writerows(rows)
                    out.writestr(name, buf.getvalue())
                elif name == "stop_times.txt" and (stale_trips or repaired_trips):
                    with out.open(name, "w") as f, zf.open(name) as in_f:
                        dst = io.TextIOWrapper(f, encoding="utf-8")
                        src = csv.DictReader(io.TextIOWrapper(in_f, encoding="utf-8-sig"))
                        w = csv.DictWriter(dst, fieldnames=src.fieldnames)
                        w.writeheader()
                        for row in src:
                            if row["trip_id"] not in stale_trips:
                                if row["trip_id"] in repaired_trips and "shape_dist_traveled" in row:
                                    row["shape_dist_traveled"] = ""
                                w.writerow(row)
                        dst.flush()
                elif name == "shapes.txt":
                    write_native_shapes(zf, out, new_shapes, referenced_shapes)
                else:
                    out.writestr(name, zf.read(name))
            if "shapes.txt" not in zf.namelist() and new_shapes:
                write_native_shapes(zf, out, new_shapes, referenced_shapes)
    log(f"rewrote {zip_path}")


def main(zip_path: str, json_path: str, shape_path: str = None) -> None:
    log = lambda *a: print("[inject-tra-gtfs]", *a)
    data = json.load(open(json_path, encoding="utf-8"))
    timetables = data["TrainTimetables"]

    start = datetime.fromisoformat(data["EffectiveDate"]).date()
    start_date = start.strftime("%Y%m%d")
    end_date = (start + timedelta(days=CALENDAR_DAYS)).strftime("%Y%m%d")

    tra_shapes = load_tra_shapes(shape_path) if shape_path else []
    if shape_path and not tra_shapes:
        log(f"WARN: no usable TRA shapes from {shape_path} — trips stay shapeless")

    with zipfile.ZipFile(zip_path) as zf:
        routes_fields, routes = read_rows(zf, "routes.txt")
        trips_fields, trips = read_rows(zf, "trips.txt")
        cal_fields, calendar = read_rows(zf, "calendar.txt")

        native = native_tra_window(zf, trips, calendar)
        if native:
            first, last = native
            tra_shapes = load_tra_shapes(shape_path, split_parts=True) if shape_path else []
            enrich_native(zf, zip_path, log, routes_fields, routes,
                          trips_fields, trips, cal_fields, calendar,
                          timetables, first, last, tra_shapes)
            return

        st_fields, stop_times = read_rows(zf, "stop_times.txt")
        stops_rows = read_rows(zf, "stops.txt")[1]
        stop_ids = {r["stop_id"] for r in stops_rows}

        # TRA stop coordinates for shape projection (lon, lat).
        coord = {}
        for r in stops_rows:
            sid = r["stop_id"]
            if sid.startswith("TRA_"):
                try:
                    coord[sid] = (float(r["stop_lon"]), float(r["stop_lat"]))
                except (KeyError, ValueError, TypeError):
                    pass

        # Idempotency: strip rows from a previous injection.
        before = (len(routes), len(trips), len(calendar), len(stop_times))
        routes = [r for r in routes if not r["route_id"].startswith("TRA_")]
        trips = [r for r in trips if not r["trip_id"].startswith("TRA_")]
        calendar = [r for r in calendar
                    if not r["service_id"].startswith("TRA_SVC_")]
        stop_times = [r for r in stop_times
                      if not r["trip_id"].startswith("TRA_")]
        stripped = tuple(b - len(x) for b, x in zip(
            before, (routes, trips, calendar, stop_times)))
        if any(stripped):
            log(f"stripped previous injection: routes={stripped[0]} "
                f"trips={stripped[1]} calendar={stripped[2]} "
                f"stop_times={stripped[3]}")

        # trips.txt may lack the optional columns we populate.
        for col in ("trip_headsign", "wheelchair_accessible"):
            if col not in trips_fields:
                trips_fields = list(trips_fields) + [col]

        seen_routes, seen_services = {}, {}
        new_trips, new_st = [], []
        trip_seq = {}  # trip_id -> ordered tuple of stop_ids (for shape dedup)
        skipped_stations = 0

        for tt in timetables:
            info, days = tt["TrainInfo"], tt["ServiceDay"]
            stops = sorted(tt["StopTimes"], key=lambda s: s["StopSequence"])
            if any(f"TRA_{s['StationID']}" not in stop_ids for s in stops):
                skipped_stations += 1
                continue

            type_code = info["TrainTypeCode"] or info["TrainTypeID"]
            route_id = f"TRA_{type_code}"
            if route_id not in seen_routes:
                name = info["TrainTypeName"]["Zh_tw"]
                seen_routes[route_id] = {
                    "route_id": route_id, "agency_id": "TRA",
                    "route_short_name": name, "route_long_name": name,
                    "route_type": "2",
                }

            bits = "".join(str(days[k]) for k in DAY_KEYS)
            service_id = f"TRA_SVC_{bits}"
            if service_id not in seen_services:
                seen_services[service_id] = {
                    "service_id": service_id,
                    **{k.lower(): str(days[k]) for k in DAY_KEYS},
                    "start_date": start_date, "end_date": end_date,
                }

            trip_id = f"TRA_{info['TrainNo']}"
            new_trips.append({
                "route_id": route_id, "service_id": service_id,
                "trip_id": trip_id, "shape_id": "",
                "direction_id": str(info.get("Direction", 0)),
                "bikes_allowed": "",
                "trip_headsign": info.get("TripHeadSign", ""),
                "wheelchair_accessible":
                    "1" if info.get("WheelChairFlag") == 1 else "",
            })
            trip_seq[trip_id] = tuple(f"TRA_{s['StationID']}" for s in stops)

            offset, prev = False, -1
            for s in stops:
                arr = hms(s.get("ArrivalTime") or s.get("DepartureTime"))
                dep = hms(s.get("DepartureTime") or s.get("ArrivalTime"))
                if minutes_of(arr) < prev:
                    offset = True
                prev = minutes_of(dep)
                if offset:
                    arr, dep = plus24(arr), plus24(dep)
                new_st.append({
                    "trip_id": trip_id, "arrival_time": arr,
                    "departure_time": dep,
                    "stop_id": f"TRA_{s['StationID']}",
                    "stop_sequence": str(s["StopSequence"]),
                })

        # Shapes: one per distinct stop sequence, stitched from the TRA lines.
        new_shapes = {}
        if tra_shapes:
            shaper = TraShaper(tra_shapes, coord)
            sig_to_id = {}
            straight_hops = total_hops = 0
            for trip in new_trips:
                sig = trip_seq[trip["trip_id"]]
                shape_id = sig_to_id.get(sig)
                if shape_id is None:
                    pts = shaper.build(sig)
                    if len(pts) >= 2:
                        shape_id = f"{SHAPE_PREFIX}{len(sig_to_id) + 1}"
                        new_shapes[shape_id] = [(lat, lon) for lon, lat in pts]
                    else:
                        shape_id = ""
                    sig_to_id[sig] = shape_id
                trip["shape_id"] = shape_id
            for hop, geom in shaper._hop.items():
                total_hops += 1
                if len(geom) <= 2:
                    straight_hops += 1
            log(f"shapes: {len(new_shapes)} written "
                f"(from {len(sig_to_id)} stop sequences); "
                f"{straight_hops}/{total_hops} distinct hops fell back to "
                f"straight")

        log(f"injecting: routes={len(seen_routes)} trips={len(new_trips)} "
            f"services={len(seen_services)} stop_times={len(new_st)} "
            f"calendar {start_date}–{end_date}"
            + (f" (skipped {skipped_stations} trains w/ unknown stations)"
               if skipped_stations else ""))

        rewritten = {
            "routes.txt": (routes_fields, routes + list(seen_routes.values())),
            "trips.txt": (trips_fields, trips + new_trips),
            "calendar.txt": (cal_fields,
                             calendar + list(seen_services.values())),
            "stop_times.txt": (st_fields, stop_times + new_st),
        }
        with tempfile.NamedTemporaryFile(dir=".", suffix=".zip",
                                         delete=False) as tmp:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
                for name in zf.namelist():
                    if name in rewritten:
                        fields, rows = rewritten[name]
                        buf = io.StringIO()
                        w = csv.DictWriter(buf, fieldnames=fields,
                                           extrasaction="ignore")
                        w.writeheader()
                        w.writerows(rows)
                        out.writestr(name, buf.getvalue())
                    elif name == "shapes.txt" and new_shapes:
                        # Stream: keep existing shapes (drop our prior TRA_SHP_),
                        # append the freshly built ones — never hold 200 MB in RAM.
                        with out.open("shapes.txt", "w") as f:
                            w = io.TextIOWrapper(f, encoding="utf-8")
                            w.write("shape_id,shape_pt_lat,shape_pt_lon,"
                                    "shape_pt_sequence\n")
                            with zf.open("shapes.txt") as in_f:
                                src = io.TextIOWrapper(in_f, encoding="utf-8-sig")
                                src.readline()
                                for line in src:
                                    if not line.startswith(SHAPE_PREFIX):
                                        w.write(line)
                            for shape_id, points in new_shapes.items():
                                for seq, (lat, lon) in enumerate(points, 1):
                                    w.write(f"{shape_id},{lat},{lon},{seq}\n")
                            w.flush()
                    else:
                        out.writestr(name, zf.read(name))
            tmp_path = tmp.name

    os.replace(tmp_path, zip_path)
    log(f"rewrote {zip_path}")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    main(*sys.argv[1:4])
