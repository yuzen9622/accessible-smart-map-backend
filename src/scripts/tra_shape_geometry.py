"""Shared TRA shape projection and GTFS stop-to-shape validation (stdlib only)."""
import csv
import io
import math
from collections import defaultdict

MAX_STOP_SHAPE_DISTANCE_M = 500.0
LAT0 = 23.7
MX = math.cos(math.radians(LAT0)) * 111320.0
MY = 110540.0


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


def csv_rows(zf, name):
    """Stream CSV rows; national shapes/stop_times must not be read wholesale."""
    with zf.open(name) as src:
        yield from csv.DictReader(io.TextIOWrapper(src, encoding="utf-8-sig"))


def coordinates(lon, lat):
    point = (float(lon), float(lat))
    if not all(math.isfinite(v) for v in point):
        raise ValueError("non-finite coordinate")
    if not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
        raise ValueError("coordinate out of range")
    return point


def load_tra_geometry(zf, trips=None):
    """Return coordinates, (shape_id, stop sequence) -> trip ids, and shapes.

    Every dated trip is checked; only identical shape/ordered-stop combinations
    share a check. Other operators' large geometries are streamed past.
    """
    if trips is None:
        trips = csv_rows(zf, "trips.txt")
    trip_shapes = {r["trip_id"]: r.get("shape_id", "") for r in trips
                   if r["trip_id"].startswith("TRA_")}
    coord = {}
    for row in csv_rows(zf, "stops.txt"):
        if row["stop_id"].startswith("TRA_"):
            try:
                coord[row["stop_id"]] = coordinates(row["stop_lon"], row["stop_lat"])
            except (KeyError, TypeError, ValueError):
                pass  # Missing coordinates fail the pattern check below.
    sequences = defaultdict(list)
    for row in csv_rows(zf, "stop_times.txt"):
        tid = row["trip_id"]
        if tid in trip_shapes:
            sequences[tid].append((int(row["stop_sequence"]), row["stop_id"]))
    patterns = defaultdict(list)
    for tid, sid in trip_shapes.items():
        stops = tuple(stop for _, stop in sorted(sequences.pop(tid, [])))
        patterns[(sid, stops)].append(tid)

    wanted = set(trip_shapes.values()) - {""}
    points = defaultdict(list)
    invalid = set()
    if "shapes.txt" in zf.namelist():
        for row in csv_rows(zf, "shapes.txt"):
            sid = row["shape_id"]
            if sid not in wanted:
                continue
            try:
                point = coordinates(row["shape_pt_lon"], row["shape_pt_lat"])
                points[sid].append((int(row["shape_pt_sequence"]), point))
            except (KeyError, TypeError, ValueError):
                invalid.add(sid)
    shapes = {}
    for sid, rows in points.items():
        if sid not in invalid and len(rows) >= 2:
            shape = Shape([point for _, point in sorted(rows)])
            if shape.cd[-1] > 0:
                shapes[sid] = shape
    return coord, dict(patterns), shapes


def find_misaligned_patterns(coord, patterns, shapes):
    """Return (pattern key, worst stop id, distance m) for every invalid pattern.

    Distance is to line segments, not just vertices. Missing geometry/stops and
    invalid coordinates count as infinity, so they cannot silently pass.
    """
    failures = []
    distances = {}
    for key in patterns:
        sid, stops = key
        shape = shapes.get(sid)
        worst_stop, worst = "", 0.0
        if shape is None or len(stops) < 2:
            failures.append((key, stops[0] if stops else "", math.inf))
            continue
        for stop in stops:
            cache_key = (sid, stop)
            if cache_key not in distances:
                point = coord.get(stop)
                distances[cache_key] = shape.project(*point)[1] if point else math.inf
            distance = distances[cache_key]
            if distance > worst:
                worst_stop, worst = stop, distance
        if worst > MAX_STOP_SHAPE_DISTANCE_M:
            failures.append((key, worst_stop, worst))
    return failures

