#!/usr/bin/env python3
import argparse
import csv
import hashlib
import inspect
import json
import math
import random
import shutil
import statistics
import subprocess
import sys
import time
import warnings
from collections import Counter, defaultdict
from pathlib import Path


INCLUDED_HIGHWAYS = frozenset(
    {
        "footway",
        "path",
        "pedestrian",
        "steps",
        "living_street",
        "track",
        "road",
        "residential",
        "service",
        "unclassified",
        "tertiary",
        "tertiary_link",
        "secondary",
        "secondary_link",
        "primary",
        "primary_link",
    }
)

ROAD_HIGHWAYS = frozenset(
    {
        "living_street",
        "road",
        "residential",
        "service",
        "unclassified",
        "tertiary",
        "tertiary_link",
        "secondary",
        "secondary_link",
        "primary",
        "primary_link",
    }
)

TAIPEI_BBOX = (121.43, 24.94, 121.71, 25.25)
SLOPE_AREAS = {
    "beitou_hills": (121.470, 25.125, 121.555, 25.205),
    "wenshan_hills": (121.535, 24.945, 121.625, 25.015),
    "xinyi_plan_flat": (121.557, 25.030, 121.574, 25.045),
}
SAMPLE_SEED = 20260819


def parse_args(argv):
    """@param argv command-line argument tokens.
    @returns parsed evaluation configuration.
    """
    parser = argparse.ArgumentParser(
        description="Evaluate Taiwan government sidewalk, ramp, and 20 m DTM data."
    )
    parser.add_argument("--sidewalk-wgs", type=Path, required=True)
    parser.add_argument("--sidewalk-twd", type=Path, required=True)
    parser.add_argument("--ramps-twd", type=Path, required=True)
    parser.add_argument("--mongo-kerbs-json", type=Path, required=True)
    parser.add_argument("--osm-pbf", type=Path, required=True)
    parser.add_argument("--dtm-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(argv)


def require_file(path, label):
    """@param path expected existing input file.
    @param label human-readable input label.
    @returns validated path.
    """
    if not path.is_file():
        raise SystemExit(f"{label} not found: {path}")
    return path


def require_command(command):
    """@param command external command required by the evaluation.
    @returns resolved executable path.
    """
    resolved = shutil.which(command)
    if not resolved:
        raise SystemExit(f"Required command not found: {command}")
    return resolved


def run_command(command):
    """@param command external command argv sequence.
    @returns elapsed wall-clock seconds.
    """
    started = time.perf_counter()
    subprocess.run(command, check=True)
    return round(time.perf_counter() - started, 3)


def load_json(path):
    """@param path UTF-8 or UTF-8 BOM JSON input path.
    @returns decoded JSON value.
    """
    with path.open(encoding="utf-8-sig") as handle:
        return json.load(handle)


def write_json(path, value):
    """@param path JSON destination path.
    @param value JSON-serializable value.
    @returns None.
    """
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)


def write_csv(path, rows):
    """@param path CSV destination path.
    @param rows non-empty sequence of dictionary rows.
    @returns None.
    """
    if not rows:
        raise SystemExit(f"Refusing to write an empty CSV: {path}")
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def sha256(path):
    """@param path file whose content hash is requested.
    @returns lowercase SHA-256 digest.
    """
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def non_empty(value):
    """@param value source attribute value.
    @returns whether the value is neither null nor blank text.
    """
    return value is not None and str(value).strip() != ""


def normalize_name(value):
    """@param value road name requiring conservative address-format normalization.
    @returns normalized road-name comparison key.
    """
    text = str(value or "").replace("臺", "台").replace("?", "").replace("�", "")
    text = text.split("(", 1)[0]
    for digit, chinese in {
        "0": "零",
        "1": "一",
        "2": "二",
        "3": "三",
        "4": "四",
        "5": "五",
        "6": "六",
        "7": "七",
        "8": "八",
        "9": "九",
    }.items():
        text = text.replace(f"{digit}段", f"{chinese}段")
    return "".join(text.split()).lower()


def haversine_m(start, end):
    """@param start longitude-latitude coordinate pair.
    @param end longitude-latitude coordinate pair.
    @returns great-circle distance in metres.
    """
    lon1, lat1 = start
    lon2, lat2 = end
    radius = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    value = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def line_length_m(coords):
    """@param coords ordered longitude-latitude coordinate pairs.
    @returns polyline length in metres.
    """
    return sum(haversine_m(start, end) for start, end in zip(coords, coords[1:]))


def coordinates_in_bbox(coords, bbox):
    """@param coords ordered longitude-latitude coordinate pairs.
    @param bbox west south east north bounds.
    @returns whether every coordinate lies within the bounding box.
    """
    west, south, east, north = bbox
    return all(west <= lon <= east and south <= lat <= north for lon, lat in coords)


def way_intersects_bbox(coords, bbox):
    """@param coords ordered longitude-latitude coordinate pairs.
    @param bbox west south east north bounds.
    @returns whether the way bounding box intersects the target bounding box.
    """
    west, south, east, north = bbox
    lons = [point[0] for point in coords]
    lats = [point[1] for point in coords]
    return not (
        max(lons) < west
        or min(lons) > east
        or max(lats) < south
        or min(lats) > north
    )


def polygon_points(geometry):
    """@param geometry GeoJSON MultiPolygon geometry.
    @returns all exterior and interior ring points as longitude-latitude pairs.
    """
    return [
        (float(lon), float(lat))
        for polygon in geometry.get("coordinates", [])
        for ring in polygon
        for lon, lat in ring
    ]


def point_to_segment_m(point, start, end):
    """@param point longitude-latitude point.
    @param start segment start longitude-latitude point.
    @param end segment end longitude-latitude point.
    @returns local equirectangular point-to-segment distance in metres.
    """
    lon, lat = point
    scale_x = 111320.0 * math.cos(math.radians(lat))
    scale_y = 110540.0
    px, py = lon * scale_x, lat * scale_y
    ax, ay = start[0] * scale_x, start[1] * scale_y
    bx, by = end[0] * scale_x, end[1] * scale_y
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    ratio = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy))


def distance_to_way_m(point, way):
    """@param point longitude-latitude point.
    @param way OSM way dictionary with a coordinate polyline.
    @returns nearest point-to-way distance in metres.
    """
    return min(
        point_to_segment_m(point, start, end)
        for start, end in zip(way["coords"], way["coords"][1:])
    )


def boundary_distance_m(boundary, way):
    """@param boundary government polygon boundary points.
    @param way OSM way dictionary with a coordinate polyline.
    @returns minimum and median sampled boundary distances in metres.
    """
    stride = max(1, len(boundary) // 100)
    distances = sorted(distance_to_way_m(point, way) for point in boundary[::stride])
    return distances[0], distances[len(distances) // 2]


def apply_with_locations(osmium, handler, pbf_path):
    """@param osmium imported pyosmium module.
    @param handler initialized SimpleHandler instance.
    @param pbf_path input OSM PBF path.
    @returns None after applying nodes and ways with coordinate locations.
    """
    apply_file = getattr(handler, "apply_file", None)
    if apply_file:
        try:
            parameters = inspect.signature(apply_file).parameters
        except (TypeError, ValueError):
            parameters = {}
        if "idx" in parameters:
            apply_file(str(pbf_path), locations=True, idx="sparse_mem_array")
            return
        try:
            apply_file(str(pbf_path), locations=True)
            return
        except TypeError:
            pass
    if not all(
        hasattr(osmium, attribute)
        for attribute in ("NodeLocationsForWays", "apply", "index")
    ):
        raise SystemExit("This pyosmium build cannot provide node locations for ways")
    reader = osmium.io.Reader(str(pbf_path))
    location_store = osmium.index.create_map("sparse_mem_array")
    location_handler = osmium.NodeLocationsForWays(location_store)
    try:
        osmium.apply(reader, location_handler, handler)
    finally:
        reader.close()


def collect_osm_ways(pbf_path):
    """@param pbf_path OSM PBF containing Taiwan nodes and ways.
    @returns included walking-network ways intersecting the Taipei study bounding box.
    """
    try:
        import osmium
    except ImportError as error:
        raise SystemExit("pyosmium is required for OSM-way evaluation") from error

    class WayCollector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.ways = []
            self.invalid_location_count = 0

        def way(self, way):
            tags = dict(way.tags)
            highway = tags.get("highway")
            if highway not in INCLUDED_HIGHWAYS:
                return
            if tags.get("foot") in {"no", "private"}:
                return
            if tags.get("access") in {"no", "private"}:
                return
            try:
                coords = [(node.location.lon, node.location.lat) for node in way.nodes]
            except Exception:
                self.invalid_location_count += 1
                return
            if len(coords) < 2 or not way_intersects_bbox(coords, TAIPEI_BBOX):
                return
            self.ways.append(
                {
                    "id": way.id,
                    "highway": highway,
                    "name": tags.get("name"),
                    "name_zh": tags.get("name:zh"),
                    "footway": tags.get("footway"),
                    "sidewalk": tags.get("sidewalk"),
                    "coords": coords,
                }
            )

    collector = WayCollector()
    apply_with_locations(osmium, collector, pbf_path)
    return collector.ways, collector.invalid_location_count


def make_way_grid(ways, cell_size=0.002):
    """@param ways OSM way dictionaries with coordinate polylines.
    @param cell_size spatial-grid cell size in degrees.
    @returns grid cell size and mapping from cells to OSM-way list indexes.
    """
    grid = defaultdict(set)
    for index, way in enumerate(ways):
        lons = [point[0] for point in way["coords"]]
        lats = [point[1] for point in way["coords"]]
        min_x = math.floor(min(lons) / cell_size)
        max_x = math.floor(max(lons) / cell_size)
        min_y = math.floor(min(lats) / cell_size)
        max_y = math.floor(max(lats) / cell_size)
        if (max_x - min_x + 1) * (max_y - min_y + 1) > 900:
            continue
        for cell_x in range(min_x, max_x + 1):
            for cell_y in range(min_y, max_y + 1):
                grid[(cell_x, cell_y)].add(index)
    return cell_size, grid


def grid_candidates(boundary, cell_size, grid, padding=0.0003):
    """@param boundary government polygon boundary points.
    @param cell_size spatial-grid cell size in degrees.
    @param grid mapping from cells to OSM-way list indexes.
    @param padding coordinate buffer applied to the boundary bounding box.
    @returns set of candidate OSM-way list indexes.
    """
    lons = [point[0] for point in boundary]
    lats = [point[1] for point in boundary]
    min_x = math.floor((min(lons) - padding) / cell_size)
    max_x = math.floor((max(lons) + padding) / cell_size)
    min_y = math.floor((min(lats) - padding) / cell_size)
    max_y = math.floor((max(lats) + padding) / cell_size)
    candidates = set()
    for cell_x in range(min_x, max_x + 1):
        for cell_y in range(min_y, max_y + 1):
            candidates.update(grid.get((cell_x, cell_y), ()))
    return candidates


def sidewalk_summary(features, payload):
    """@param features Taipei government sidewalk GeoJSON features.
    @param payload complete GeoJSON document.
    @returns count, field-completeness, district, and geometry summaries.
    """
    fields = ("SW_WTH", "SWW_WTH", "SW_RAMP")
    properties = [feature.get("properties", {}) for feature in features]
    field_summary = {
        field: {
            "present": sum(non_empty(row.get(field)) for row in properties),
            "total": len(properties),
            "present_pct": round(
                sum(non_empty(row.get(field)) for row in properties) / len(properties) * 100,
                3,
            ),
        }
        for field in fields
    }
    lengths = [float(row["SW_LENG"]) for row in properties if non_empty(row.get("SW_LENG"))]
    return {
        "features": len(features),
        "crs": payload.get("crs", {}).get("properties", {}).get("name"),
        "geometry_types": dict(
            Counter(
                feature.get("geometry", {}).get("type")
                for feature in features
                if feature.get("geometry")
            )
        ),
        "districts": dict(
            sorted(Counter(row.get("VILL_NAME") for row in properties).items())
        ),
        "fields": field_summary,
        "total_length_m": round(sum(lengths), 2),
        "median_length_m": round(statistics.median(lengths), 3),
        "record_to_osm_footway_pct": round(len(features) / 25378 * 100, 3),
        "record_to_osm_walkable_road_pct": round(len(features) / 12756 * 100, 3),
    }


def sidewalk_osm_sample(features, ways):
    """@param features Taipei government sidewalk GeoJSON features.
    @param ways included Taipei OSM way dictionaries.
    @returns random-sample summary and per-record OSM-candidate rows.
    """
    cell_size, grid = make_way_grid(ways)
    sample = random.Random(SAMPLE_SEED).sample(list(enumerate(features)), 100)
    rows = []
    for number, (feature_index, feature) in enumerate(sample, start=1):
        properties = feature.get("properties", {})
        boundary = polygon_points(feature.get("geometry", {}))
        if not boundary:
            raise SystemExit(f"Sidewalk feature {feature_index} has no geometry")
        candidates = []
        for way_index in grid_candidates(boundary, cell_size, grid):
            minimum, median = boundary_distance_m(boundary, ways[way_index])
            if minimum <= 35:
                candidates.append((minimum, median, ways[way_index]))
        candidates.sort(key=lambda value: (value[0], value[1], value[2]["id"]))
        if not candidates:
            raise SystemExit(f"No OSM candidate within 35 m for feature {feature_index}")
        government_name = normalize_name(properties.get("NAME"))
        same_name = [
            candidate
            for candidate in candidates
            if government_name
            and government_name
            == normalize_name(candidate[2].get("name") or candidate[2].get("name_zh"))
        ]
        nearest_minimum, nearest_median, nearest_way = candidates[0]
        selected_minimum, selected_median, selected_way = (
            same_name[0] if same_name else candidates[0]
        )
        rows.append(
            {
                "sample": number,
                "feature_index": feature_index,
                "district": properties.get("VILL_NAME"),
                "gov_name": properties.get("NAME"),
                "pstart": properties.get("PSTART"),
                "pend": properties.get("PEND"),
                "nearest_osm_way_id": nearest_way["id"],
                "nearest_osm_name": nearest_way.get("name") or nearest_way.get("name_zh") or "",
                "nearest_highway": nearest_way["highway"],
                "nearest_boundary_min_m": round(nearest_minimum, 3),
                "nearest_boundary_median_m": round(nearest_median, 3),
                "strict_10m_spatial_match": nearest_minimum <= 10,
                "within_15m_spatial_match": nearest_minimum <= 15,
                "selected_osm_way_id": selected_way["id"],
                "selected_name": selected_way.get("name") or selected_way.get("name_zh") or "",
                "selected_highway": selected_way["highway"],
                "selected_boundary_min_m": round(selected_minimum, 3),
                "selected_boundary_median_m": round(selected_median, 3),
                "same_name_osm_ways_35m": len(same_name),
                "all_osm_ways_35m": len(candidates),
                "top_candidates": " | ".join(
                    f"{way['id']}:{way.get('name') or way.get('name_zh') or '-'}:{way['highway']}:{minimum:.2f}/{median:.2f}"
                    for minimum, median, way in candidates[:8]
                ),
            }
        )
    same_name_counts = Counter(row["same_name_osm_ways_35m"] for row in rows)
    distances = sorted(row["nearest_boundary_min_m"] for row in rows)
    return {
        "sample_seed": SAMPLE_SEED,
        "sample_size": len(rows),
        "strict_10m_spatial_matches": sum(row["strict_10m_spatial_match"] for row in rows),
        "within_15m_spatial_matches": sum(row["within_15m_spatial_match"] for row in rows),
        "nearest_boundary_distance_median": round(statistics.median(distances), 3),
        "nearest_boundary_distance_max": round(max(distances), 3),
        "same_name_osm_ways_35m_distribution": {
            str(key): value for key, value in sorted(same_name_counts.items())
        },
        "single_same_name_way": same_name_counts.get(1, 0),
        "multiple_same_name_ways": sum(
            value for key, value in same_name_counts.items() if key > 1
        ),
        "no_same_name_way": same_name_counts.get(0, 0),
    }, rows


def transform_ramps(ramps_twd, output_dir):
    """@param ramps_twd TWD97 GeoJSON path.
    @param output_dir isolated evaluation output directory.
    @returns transformed WGS84 GeoJSON path and elapsed seconds.
    """
    ogr2ogr = require_command("ogr2ogr")
    output_path = output_dir / "taipei-ramps-epsg4326.geojson"
    elapsed = run_command(
        [
            ogr2ogr,
            "-f",
            "GeoJSON",
            "-t_srs",
            "EPSG:4326",
            str(output_path),
            str(ramps_twd),
        ]
    )
    return output_path, elapsed


def mongo_coordinates(payload):
    """@param payload exported MongoDB kerb-cut document array.
    @returns longitude-latitude tuples for valid Point locations.
    """
    if not isinstance(payload, list):
        raise SystemExit("Mongo kerb export must be a JSON array")
    coordinates = []
    for document in payload:
        location = document.get("location", {})
        point = location.get("coordinates") if isinstance(location, dict) else None
        if isinstance(point, list) and len(point) >= 2:
            coordinates.append((float(point[0]), float(point[1])))
    if not coordinates:
        raise SystemExit("Mongo kerb export has no Point coordinates")
    return coordinates


def overlap_summary(ramp_features, kerb_points):
    """@param ramp_features WGS84 government ramp GeoJSON features.
    @param kerb_points MongoDB kerb-cut longitude-latitude points.
    @returns bidirectional nearest-neighbour overlap statistics.
    """
    ramps = [
        tuple(feature["geometry"]["coordinates"])
        for feature in ramp_features
        if feature.get("geometry", {}).get("type") == "Point"
    ]
    cell_degrees = 0.0002
    grid = defaultdict(list)
    for index, (lon, lat) in enumerate(ramps):
        grid[(round(lon / cell_degrees), round(lat / cell_degrees))].append(index)
    nearest = []
    for point in kerb_points:
        lon, lat = point
        cell_x = round(lon / cell_degrees)
        cell_y = round(lat / cell_degrees)
        positions = []
        for offset_x in range(-5, 6):
            for offset_y in range(-5, 6):
                positions.extend(grid.get((cell_x + offset_x, cell_y + offset_y), ()))
        if positions:
            distance, ramp_index = min(
                (haversine_m(point, ramps[index]), index) for index in positions
            )
        else:
            distance, ramp_index = float("inf"), None
        nearest.append((distance, ramp_index))
    thresholds = {}
    for threshold in (5, 10, 20, 50):
        matches = [index for index, (distance, _) in enumerate(nearest) if distance <= threshold]
        matched_ramps = {
            ramp_index
            for distance, ramp_index in nearest
            if distance <= threshold and ramp_index is not None
        }
        thresholds[str(threshold)] = {
            "matched_mongo_documents": len(matches),
            "matched_mongo_pct": round(len(matches) / len(kerb_points) * 100, 3),
            "matched_government_features": len(matched_ramps),
            "matched_government_pct": round(len(matched_ramps) / len(ramps) * 100, 3),
        }
    finite_distances = sorted(distance for distance, _ in nearest if math.isfinite(distance))
    return {
        "ramp_features": len(ramps),
        "ramp_unique_coordinates": len(set(ramps)),
        "kerb_cut_documents": len(kerb_points),
        "kerb_cut_unique_coordinates": len(set(kerb_points)),
        "thresholds_m": thresholds,
        "nearest_distance_quantiles_m": {
            str(percentile): round(
                finite_distances[round((len(finite_distances) - 1) * percentile)], 3
            )
            for percentile in (0, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1)
        },
    }


def build_dem(dtm_dir, output_dir):
    """@param dtm_dir flat directory containing paired source .grd and .hdr files.
    @param output_dir isolated evaluation output directory.
    @returns EPSG:4326 GeoTIFF path, conversion duration, and raster metadata.
    """
    for command in ("gdalwarp", "gdalbuildvrt", "gdal_translate"):
        require_command(command)
    grids = sorted(dtm_dir.glob("*.grd"))
    if not grids:
        raise SystemExit(f"No .grd DTM files found in {dtm_dir}")
    tile_dir = output_dir / "dtm-4326-tiles"
    tile_dir.mkdir()
    started = time.perf_counter()
    for grid in grids:
        tile = tile_dir / f"{grid.stem}.tif"
        run_command(
            [
                "gdalwarp",
                "-q",
                "-s_srs",
                "EPSG:3826",
                "-t_srs",
                "EPSG:4326",
                "-tr",
                "0.0002",
                "0.0002",
                "-tap",
                "-r",
                "bilinear",
                "-of",
                "GTiff",
                "-co",
                "TILED=YES",
                "-co",
                "COMPRESS=DEFLATE",
                str(grid),
                str(tile),
            ]
        )
    vrt = output_dir / "taipei-dtm-epsg4326.vrt"
    run_command(["gdalbuildvrt", "-q", str(vrt), *(str(path) for path in sorted(tile_dir.glob("*.tif")))])
    output_tif = output_dir / "taipei-20m-dtm-epsg4326.tif"
    run_command(
        [
            "gdal_translate",
            "-q",
            "-of",
            "GTiff",
            "-co",
            "TILED=YES",
            "-co",
            "COMPRESS=DEFLATE",
            str(vrt),
            str(output_tif),
        ]
    )
    elapsed = round(time.perf_counter() - started, 3)
    try:
        import rasterio
    except ImportError as error:
        raise SystemExit("rasterio is required to validate the reprojected DTM") from error
    with rasterio.open(output_tif) as dataset:
        epsg = dataset.crs.to_epsg() if dataset.crs else None
        if epsg != 4326:
            raise SystemExit(f"DTM output CRS must be EPSG:4326, got {dataset.crs}")
        metadata = {
            "path": str(output_tif),
            "epsg": epsg,
            "width": dataset.width,
            "height": dataset.height,
            "bounds": [
                round(dataset.bounds.left, 7),
                round(dataset.bounds.bottom, 7),
                round(dataset.bounds.right, 7),
                round(dataset.bounds.top, 7),
            ],
            "tile_count": len(grids),
        }
    return output_tif, elapsed, metadata


def elevation_at(dataset, band, point):
    """@param dataset EPSG:4326 rasterio dataset.
    @param band loaded elevation band array.
    @param point longitude-latitude point.
    @returns elevation in metres or None when outside the raster.
    """
    row, column = dataset.index(point[0], point[1])
    if not (0 <= row < dataset.height and 0 <= column < dataset.width):
        return None
    value = float(band[row, column])
    return value if value > -9999 else None


def read_elevation_band(dataset):
    """@param dataset open rasterio dataset.
    @returns first raster band while isolating the current rasterio NumPy warning.
    """
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Setting the shape on a NumPy array has been deprecated.*",
            category=DeprecationWarning,
        )
        return dataset.read(1)


def road_candidates(ways, bbox):
    """@param ways included Taipei OSM way dictionaries.
    @param bbox west south east north selection bounds.
    @returns roads fully inside the selection bounds and at least 80 metres long.
    """
    return [
        way
        for way in ways
        if way["highway"] in ROAD_HIGHWAYS
        and coordinates_in_bbox(way["coords"], bbox)
        and line_length_m(way["coords"]) >= 80
    ]


def slope_records(label, ways, dataset, band):
    """@param label named geographic sample area.
    @param ways selected OSM road ways.
    @param dataset EPSG:4326 rasterio dataset.
    @param band loaded elevation band array.
    @returns endpoint-slope records for the selected ways.
    """
    records = []
    for way in ways:
        start = way["coords"][0]
        end = way["coords"][-1]
        length_m = line_length_m(way["coords"])
        start_elevation = elevation_at(dataset, band, start)
        end_elevation = elevation_at(dataset, band, end)
        signed_slope = None
        absolute_slope = None
        if start_elevation is not None and end_elevation is not None:
            signed_slope = round((end_elevation - start_elevation) / length_m * 100, 3)
            absolute_slope = round(abs(signed_slope), 3)
        records.append(
            {
                "area": label,
                "id": way["id"],
                "name": way.get("name") or way.get("name_zh") or "",
                "highway": way["highway"],
                "length_m": round(length_m, 2),
                "start": [round(start[0], 7), round(start[1], 7)],
                "end": [round(end[0], 7), round(end[1], 7)],
                "elevation_start_m": start_elevation,
                "elevation_end_m": end_elevation,
                "signed_slope_pct": signed_slope,
                "absolute_slope_pct": absolute_slope,
            }
        )
    return records


def slope_summary(records):
    """@param records endpoint-slope record dictionaries.
    @returns descriptive statistics for absolute slope percentages.
    """
    slopes = [record["absolute_slope_pct"] for record in records if record["absolute_slope_pct"] is not None]
    return {
        "count": len(records),
        "with_elevation": len(slopes),
        "median_absolute_slope_pct": round(statistics.median(slopes), 3),
        "mean_absolute_slope_pct": round(statistics.mean(slopes), 3),
        "min_absolute_slope_pct": min(slopes),
        "max_absolute_slope_pct": max(slopes),
        "greater_than_2pct": sum(slope > 2 for slope in slopes),
        "less_or_equal_1pct": sum(slope <= 1 for slope in slopes),
    }


def evaluate_slopes(ways, dem_path):
    """@param ways included Taipei OSM way dictionaries.
    @param dem_path validated EPSG:4326 DTM GeoTIFF path.
    @returns sampled hill and flat area endpoint-slope results.
    """
    try:
        import rasterio
    except ImportError as error:
        raise SystemExit("rasterio is required for DTM slope evaluation") from error
    candidates = {label: road_candidates(ways, bbox) for label, bbox in SLOPE_AREAS.items()}
    required = {"beitou_hills": 10, "wenshan_hills": 10, "xinyi_plan_flat": 20}
    for label, required_count in required.items():
        if len(candidates[label]) < required_count:
            raise SystemExit(f"{label} has only {len(candidates[label])} eligible OSM ways")
    chooser = random.Random(SAMPLE_SEED)
    selected = {
        label: chooser.sample(candidates[label], required_count)
        for label, required_count in required.items()
    }
    with rasterio.open(dem_path) as dataset:
        if dataset.crs is None or dataset.crs.to_epsg() != 4326:
            raise SystemExit(f"DTM must be EPSG:4326 before sampling, got {dataset.crs}")
        band = read_elevation_band(dataset)
        records = {
            label: slope_records(label, selected[label], dataset, band)
            for label in selected
        }
    hilly = records["beitou_hills"] + records["wenshan_hills"]
    return {
        "selection_seed": SAMPLE_SEED,
        "bboxes": SLOPE_AREAS,
        "candidate_counts": {label: len(value) for label, value in candidates.items()},
        "selection": {label: len(value) for label, value in selected.items()},
        "hilly_summary": slope_summary(hilly),
        "flat_summary": slope_summary(records["xinyi_plan_flat"]),
        "records": records,
    }


def main(argv=None):
    """@param argv optional command-line argument tokens.
    @returns process exit status.
    """
    args = parse_args(sys.argv[1:] if argv is None else argv)
    for path, label in (
        (args.sidewalk_wgs, "WGS84 sidewalk GeoJSON"),
        (args.sidewalk_twd, "TWD97 sidewalk GeoJSON"),
        (args.ramps_twd, "TWD97 ramps GeoJSON"),
        (args.mongo_kerbs_json, "Mongo kerb-cut export"),
        (args.osm_pbf, "OSM PBF"),
    ):
        require_file(path, label)
    if not args.dtm_dir.is_dir():
        raise SystemExit(f"DTM directory not found: {args.dtm_dir}")
    if args.output_dir.exists():
        raise SystemExit(f"Output directory must not already exist: {args.output_dir}")
    args.output_dir.mkdir(parents=True)

    wgs_payload = load_json(args.sidewalk_wgs)
    twd_payload = load_json(args.sidewalk_twd)
    sidewalk_features = wgs_payload.get("features", [])
    if len(sidewalk_features) < 100:
        raise SystemExit("WGS84 sidewalk input must contain at least 100 features")
    sidewalk = sidewalk_summary(sidewalk_features, wgs_payload)
    sidewalk["twd97_feature_count"] = len(twd_payload.get("features", []))
    sidewalk["twd97_crs"] = twd_payload.get("crs", {}).get("properties", {}).get("name")

    ramps_wgs, ramp_transform_seconds = transform_ramps(args.ramps_twd, args.output_dir)
    ramp_payload = load_json(ramps_wgs)
    kerb_points = mongo_coordinates(load_json(args.mongo_kerbs_json))
    ramps = overlap_summary(ramp_payload.get("features", []), kerb_points)
    ramps["transform_seconds"] = ramp_transform_seconds

    dem_path, dem_seconds, dem_metadata = build_dem(args.dtm_dir, args.output_dir)
    osm_started = time.perf_counter()
    ways, invalid_location_count = collect_osm_ways(args.osm_pbf)
    osm_seconds = round(time.perf_counter() - osm_started, 3)
    matching, sample_rows = sidewalk_osm_sample(sidewalk_features, ways)
    write_csv(args.output_dir / "sidewalk-osm-sample.csv", sample_rows)
    slopes = evaluate_slopes(ways, dem_path)
    write_json(args.output_dir / "dtm-slope-sample.json", slopes)

    result = {
        "inputs": {
            "sidewalk_wgs_sha256": sha256(args.sidewalk_wgs),
            "sidewalk_twd_sha256": sha256(args.sidewalk_twd),
            "ramps_twd_sha256": sha256(args.ramps_twd),
            "osm_pbf_sha256": sha256(args.osm_pbf),
        },
        "sidewalk": sidewalk,
        "ramps": ramps,
        "dtm": {"conversion_seconds": dem_seconds, **dem_metadata},
        "osm": {
            "included_taipei_ways": len(ways),
            "invalid_location_count": invalid_location_count,
            "collection_seconds": osm_seconds,
        },
        "sidewalk_osm_matching": matching,
        "slopes": slopes,
    }
    write_json(args.output_dir / "results.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
