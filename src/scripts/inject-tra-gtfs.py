#!/usr/bin/env python3
"""Inject the TRA timetable into the TDX national GTFS zip (Phase 16.5).

Two modes, chosen per run:

  native   (2026-10 onward) the TDX national feed itself carries a dated TRA
           timetable: one trip per train per service date (calendar_dates),
           ~59 days ahead, with track shapes. When it covers at least
           NATIVE_MIN_DAYS ahead it is KEPT as-is — it is strictly more
           accurate than a weekly pattern (holidays, one-off changes) — and
           only enriched with what it lacks: route_long_name gets the train
           type (區間/自強/…, which the backend shows as trainTypeName) and
           trips of WheelChairFlag=1 trains get wheelchair_accessible=1.
           Only rows written by an earlier injection are removed.
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
import math
import re
import os
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone

CALENDAR_DAYS = 45
NATIVE_MIN_DAYS = 14
TAIPEI = timezone(timedelta(hours=8))
INJECTED_SERVICE_PREFIX = "TRA_SVC_"
INJECTED_ROUTE = re.compile(r"^TRA_[^_]+$")
DAY_KEYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
            "Saturday", "Sunday")

# Shape generation ----------------------------------------------------------
SHAPE_PREFIX = "TRA_SHP_"
SHAPE_PERP_MAX = 600.0  # m — reject a line whose track sits farther from a stop
LAT0 = 23.7             # Taiwan mid-latitude for the local planar projection
MX = math.cos(math.radians(LAT0)) * 111320.0  # metres per degree longitude
MY = 110540.0                                  # metres per degree latitude


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


class Shape:
    """One TRA line's track geometry, prepared for projection + slicing.

    Distances are computed in a local equirectangular projection (metres),
    accurate enough across Taiwan for nearest-line selection and slicing.
    """
    __slots__ = ("lon", "lat", "xs", "ys", "cd", "bbox")

    def __init__(self, pts):
        self.lon = [p[0] for p in pts]
        self.lat = [p[1] for p in pts]
        self.xs = [p[0] * MX for p in pts]
        self.ys = [p[1] * MY for p in pts]
        cd = [0.0]
        for i in range(1, len(pts)):
            cd.append(cd[-1] + math.hypot(self.xs[i] - self.xs[i - 1],
                                          self.ys[i] - self.ys[i - 1]))
        self.cd = cd
        self.bbox = (min(self.lon), min(self.lat), max(self.lon), max(self.lat))

    def project(self, lon: float, lat: float):
        """Nearest point on the line. Returns (along_m, perp_m, lon, lat)."""
        px, py = lon * MX, lat * MY
        xs, ys, cd = self.xs, self.ys, self.cd
        best_perp = 1e18
        best_along = 0.0
        best_lon, best_lat = lon, lat
        for i in range(len(xs) - 1):
            ax, ay = xs[i], ys[i]
            dx, dy = xs[i + 1] - ax, ys[i + 1] - ay
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else ((px - ax) * dx + (py - ay) * dy) / seg2
            if t < 0.0:
                t = 0.0
            elif t > 1.0:
                t = 1.0
            cx, cy = ax + t * dx, ay + t * dy
            perp = (px - cx) ** 2 + (py - cy) ** 2
            if perp < best_perp:
                best_perp = perp
                best_along = cd[i] + t * math.sqrt(seg2)
                best_lon = self.lon[i] + t * (self.lon[i + 1] - self.lon[i])
                best_lat = self.lat[i] + t * (self.lat[i + 1] - self.lat[i])
        return best_along, math.sqrt(best_perp), best_lon, best_lat

    def at(self, d: float):
        """Point at along-distance d (clamped), via binary search."""
        cd = self.cd
        if d <= cd[0]:
            return (self.lon[0], self.lat[0])
        if d >= cd[-1]:
            return (self.lon[-1], self.lat[-1])
        lo, hi = 0, len(cd) - 1
        while lo < hi:
            m = (lo + hi) // 2
            if cd[m] < d:
                lo = m + 1
            else:
                hi = m
        i = lo
        seg = cd[i] - cd[i - 1]
        t = 0.0 if seg == 0 else (d - cd[i - 1]) / seg
        return (self.lon[i - 1] + t * (self.lon[i] - self.lon[i - 1]),
                self.lat[i - 1] + t * (self.lat[i] - self.lat[i - 1]))

    def slice(self, d0: float, d1: float):
        """Sub-polyline between along-distances d0..d1, in travel order."""
        rev = d0 > d1
        lo, hi = (d1, d0) if rev else (d0, d1)
        cd = self.cd
        out = [self.at(lo)]
        for i in range(len(cd)):
            if lo < cd[i] < hi:
                out.append((self.lon[i], self.lat[i]))
        out.append(self.at(hi))
        if rev:
            out.reverse()
        return out


class TraShaper:
    """Builds a track-following shape for a trip's ordered stop list.

    Each consecutive stop pair is sliced from the nearest fitting line and the
    slices stitched together. Per-hop results are memoised on (from, to) — the
    network has only ~245 stations, so a few hundred distinct hops cover every
    trip.
    """

    def __init__(self, shapes, coord):
        self.shapes = shapes
        self.coord = coord
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
        else:
            geom = [a, b]  # no fitting line: straight segment for this hop only
        self._hop[key] = geom
        return geom

    def build(self, stop_ids):
        """Return the trip's stitched shape as [(lon, lat), …] (dups dropped)."""
        out = []
        for i in range(len(stop_ids) - 1):
            for p in self._hop_geom(stop_ids[i], stop_ids[i + 1]):
                if not out or out[-1] != p:
                    out.append(p)
        return out


def load_tra_shapes(shape_path: str):
    """Load TDX Rail/TRA/Shape JSON into a list of Shape (or [] on any issue)."""
    try:
        data = json.load(open(shape_path, encoding="utf-8"))
    except (OSError, ValueError):
        return []
    records = data.get("Shapes") if isinstance(data, dict) else data
    shapes = []
    for rec in records or []:
        pts = parse_wkt(rec.get("Geometry") or "")
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


def enrich_native(zf, zip_path, log, routes_fields, routes, trips_fields,
                  trips, cal_fields, calendar, timetables, first, last):
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
    with tempfile.NamedTemporaryFile(dir=".", suffix=".zip", delete=False) as tmp:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
            for name in zf.namelist():
                if name in rewritten:
                    fields, rows = rewritten[name]
                    buf = io.StringIO()
                    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
                    w.writeheader()
                    w.writerows(rows)
                    out.writestr(name, buf.getvalue())
                elif name == "stop_times.txt" and stale_trips:
                    with out.open(name, "w") as f, zf.open(name) as in_f:
                        dst = io.TextIOWrapper(f, encoding="utf-8")
                        src = csv.DictReader(io.TextIOWrapper(in_f, encoding="utf-8-sig"))
                        w = csv.DictWriter(dst, fieldnames=src.fieldnames)
                        w.writeheader()
                        for row in src:
                            if row["trip_id"] not in stale_trips:
                                w.writerow(row)
                        dst.flush()
                elif name == "shapes.txt":
                    with out.open(name, "w") as f, zf.open(name) as in_f:
                        dst = io.TextIOWrapper(f, encoding="utf-8")
                        src = io.TextIOWrapper(in_f, encoding="utf-8-sig")
                        dst.write(src.readline())
                        for line in src:
                            if not line.startswith(SHAPE_PREFIX):
                                dst.write(line)
                        dst.flush()
                else:
                    out.writestr(name, zf.read(name))
        tmp_path = tmp.name
    os.replace(tmp_path, zip_path)
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
            enrich_native(zf, zip_path, log, routes_fields, routes,
                          trips_fields, trips, cal_fields, calendar,
                          timetables, first, last)
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
