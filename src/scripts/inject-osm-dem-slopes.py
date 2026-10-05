#!/usr/bin/env python3
"""Inject road incline (slope) tags into OSM PBF files using DEM (Digital Elevation Model) TIFFs.

Uses pyosmium and rasterio. If the libraries are not installed or if no DEM files are found,
this script exits with 0 (fail-soft warning) to avoid breaking the build pipeline.

Usage:
  python3 inject-osm-dem-slopes.py <input.osm.pbf> <output.osm.pbf> <dem-dir>
"""
import os
import sys
import math

log = lambda *a: print("[inject-osm-dem-slopes]", *a)

# ── 1. Safe dependency check ──
try:
    import osmium
    import rasterio
    import numpy as np
    from rasterio.warp import transform
    HAS_LIBS = True
except ImportError as e:
    HAS_LIBS = False
    MISSING_LIB = str(e).split("'")[-2] if "'" in str(e) else "pyosmium/rasterio"

# Haversine distance formula in meters
def haversine(lon1, lat1, lon2, lat2):
    R = 6371000  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (math.sin(delta_phi / 2) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


class DemReader:
    def __init__(self, dem_path):
        self.dataset = rasterio.open(dem_path)
        if self.dataset.crs is None:
            self.dataset.close()
            raise ValueError("DEM has no coordinate reference system")
        self.band = self.dataset.read(1, masked=True)
        self.is_wgs84 = self.dataset.crs.to_epsg() == 4326
        self.affine = self.dataset.transform
        self.inverse_affine = ~self.affine

    def pixel(self, lon, lat):
        """Convert a WGS84 query into the raster's own CRS before indexing."""
        if not self.is_wgs84:
            xs, ys = transform("EPSG:4326", self.dataset.crs, [lon], [lat])
            lon, lat = xs[0], ys[0]
        column, row = self.inverse_affine * (lon, lat)
        return math.floor(row), math.floor(column)

    def minimum_slope_span_m(self, lon, lat):
        """Require two cells across the larger local cell dimension for terrain slope."""
        py, px = self.pixel(lon, lat)
        if not (0 <= px < self.dataset.width and 0 <= py < self.dataset.height):
            return None
        coords = [self.affine * (x + 0.5, y + 0.5)
                  for x, y in ((px, py), (px + 1, py), (px, py + 1))]
        xs, ys = [p[0] for p in coords], [p[1] for p in coords]
        if not self.is_wgs84:
            xs, ys = transform(self.dataset.crs, "EPSG:4326", xs, ys)
        return 2 * max(haversine(xs[0], ys[0], xs[i], ys[i]) for i in (1, 2))

    def get_elevation(self, lon, lat):
        py, px = self.pixel(lon, lat)
        if 0 <= px < self.dataset.width and 0 <= py < self.dataset.height:
            val = self.band[py, px]
            if not np.ma.is_masked(val) and math.isfinite(float(val)) and val > -9999:
                return float(val)
        return None

    def close(self):
        self.dataset.close()


class MultiDemReader:
    def __init__(self, dem_dir):
        self.readers = []
        if not dem_dir or not os.path.isdir(dem_dir):
            return
        for fname in sorted(os.listdir(dem_dir)):
            if fname.lower().endswith(('.tif', '.tiff')):
                p = os.path.join(dem_dir, fname)
                try:
                    self.readers.append(DemReader(p))
                    log(f"Loaded DEM raster file: {fname}")
                except Exception as e:
                    log(f"WARN: Failed to load DEM file {p}: {e}")

    def get_elevation(self, lon, lat):
        for reader in self.readers:
            h = reader.get_elevation(lon, lat)
            if h is not None:
                return h
        return None

    def minimum_slope_span_m(self, lon, lat):
        for reader in self.readers:
            if reader.get_elevation(lon, lat) is not None:
                return reader.minimum_slope_span_m(lon, lat)
        return None

    def close(self):
        for r in self.readers:
            r.close()


if not HAS_LIBS:
    # Fail-soft exit if dependencies are missing
    def main():
        log(f"WARN: Python module '{MISSING_LIB}' not found.")
        log("Skipping DEM slope tag injection. Build pipeline will continue with original map tags.")
        sys.exit(0)
else:
    class SlopeEnricher(osmium.SimpleHandler):
        def __init__(self, writer, dem_reader):
            super().__init__()
            self.writer = writer
            self.dem_reader = dem_reader
            self.updated_count = 0

        def way(self, w):
            highway = w.tags.get('highway')
            if not highway:
                self.writer.add_way(w)
                return

            # Never replace existing OSM incline or use bare terrain for a
            # structure above/below ground.
            if (w.tags.get('incline') is not None
                    or w.tags.get('bridge') not in (None, 'no')
                    or w.tags.get('tunnel') not in (None, 'no')
                    or w.tags.get('layer') not in (None, '0')):
                self.writer.add_way(w)
                return

            # Only calculate slopes for pedestrian/walk/steps/cycleway ways
            is_walkway = highway in ('footway', 'pedestrian', 'steps', 'path', 'cycleway', 'service')
            if not is_walkway:
                self.writer.add_way(w)
                return

            nodes = list(w.nodes)
            if len(nodes) < 2:
                self.writer.add_way(w)
                return

            # Read elevation for each node
            elevations = []
            for nd in nodes:
                try:
                    # nd.lon and nd.lat are populated when locations=True is set on apply()
                    h = self.dem_reader.get_elevation(nd.lon, nd.lat)
                    elevations.append((nd.lon, nd.lat, h))
                except Exception:
                    elevations.append((nd.lon, nd.lat, None))

            # Compute slope grades between consecutive nodes
            slopes = []
            for i in range(len(elevations) - 1):
                lon1, lat1, h1 = elevations[i]
                lon2, lat2, h2 = elevations[i + 1]
                if h1 is not None and h2 is not None:
                    dist = haversine(lon1, lat1, lon2, lat2)
                    min_span = self.dem_reader.minimum_slope_span_m(lon1, lat1)
                    if min_span is not None and dist >= min_span:
                        slope = (abs(h2 - h1) / dist) * 100
                        slopes.append(slope)

            if slopes:
                max_slope = max(slopes)
                slope_str = f"{max_slope:.1f}%"

                # Update tags dictionary
                tags = dict(w.tags)
                tags['incline'] = slope_str
                tags['source:incline'] = 'dem'

                # For steps, check if general direction is up or down
                if highway == 'steps':
                    h_start = elevations[0][2]
                    h_end = elevations[-1][2]
                    if h_start is not None and h_end is not None:
                        if h_end > h_start:
                            tags['incline'] = 'up'
                        elif h_end < h_start:
                            tags['incline'] = 'down'

                self.writer.add_way(w.replace(tags=tags))
                self.updated_count += 1
            else:
                self.writer.add_way(w)

        def node(self, n):
            self.writer.add_node(n)

        def relation(self, r):
            self.writer.add_relation(r)

    def main():
        if len(sys.argv) < 4:
            sys.exit(f"Usage: {sys.argv[0]} <input.osm.pbf> <output.osm.pbf> <dem-dir>")

        input_pbf = sys.argv[1]
        output_pbf = sys.argv[2]
        dem_dir = sys.argv[3]

        if not os.path.exists(input_pbf):
            sys.exit(f"Error: Input PBF not found: {input_pbf}")

        reader = MultiDemReader(dem_dir)
        if not reader.readers:
            log("WARN: No DEM GeoTIFF (.tif) files found in the specified directory.")
            log("Skipping slope injection. Copying input PBF directly to output...")
            # If no DEM files, just copy input to output (fail-soft)
            if input_pbf != output_pbf:
                import shutil
                shutil.copy2(input_pbf, output_pbf)
            sys.exit(0)

        log(f"Beginning DEM slope injection from '{input_pbf}' to '{output_pbf}'...")
        try:
            writer = osmium.SimpleWriter(osmium.io.File(output_pbf, "pbf"))
            enricher = SlopeEnricher(writer, reader)
            
            # locations=True enables the node cache so Way nodes have coordinates
            enricher.apply_file(input_pbf, locations=True)
            writer.close()
            log(f"Successfully injected slope tags into {enricher.updated_count} Ways.")
        except Exception as e:
            log(f"ERROR during slope injection: {e}")
            sys.exit(1)
        finally:
            reader.close()


if __name__ == "__main__":
    main()
