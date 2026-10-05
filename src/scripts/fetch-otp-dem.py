#!/usr/bin/env python3
"""Fetch the MOI national 20 m DTM and stage it as an EPSG:4326 GeoTIFF for OTP.

OTP reads every *.tif in its build directory as an elevation model and derives
per-edge slopes from it; OSM ``incline`` tags are ignored by its street model.
The source is the single whole-island product of data.gov.tw dataset 178729
(「不分幅_全台20MDEM」), located through the dataset's official resource CSV so
a yearly re-release (new file name / GUID) is picked up without code changes.
The download is skipped while the upstream ETag matches the staged copy.
HTTP goes through curl: the MOI/TGOS certificates lack a Subject Key
Identifier, which Python 3.13+'s strict X.509 verification rejects.

Usage:
  python3 fetch-otp-dem.py <dem-dir>
"""

import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile

RESOURCE_CSV_URL = (
    "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/"
    "B6219841-E247-4743-958D-77FB61067092/resource/"
    "D788C60B-33CB-4A84-A438-EC6E8B7060F1/download"
)
WHOLE_ISLAND_PREFIX = "不分幅"
OUTPUT_NAME = "taiwan-dtm-20m.tif"
SOURCE_NAME = "taiwan-dtm-20m.source.json"
TIMEOUT_S = 120
DOWNLOAD_TIMEOUT_S = 1800

log = lambda *a: print("[fetch-otp-dem]", *a, flush=True)


def whole_island_url(csv_bytes):
    """Pick the whole-island DTM download link from the official resource CSV.

    @param csv_bytes raw CSV body (UTF-8, optionally with BOM)
    @returns the percent-encoded zip URL
    """
    rows = list(csv.reader(io.StringIO(csv_bytes.decode("utf-8-sig"))))
    header = rows[0]
    name_col, url_col = header.index("圖資名稱"), header.index("連結網址")
    for row in rows[1:]:
        if row[name_col].startswith(WHOLE_ISLAND_PREFIX):
            parts = urllib.parse.urlsplit(row[url_col].strip())
            return parts._replace(path=urllib.parse.quote(parts.path)).geturl()
    raise SystemExit("resource CSV lists no whole-island (不分幅) DTM product")


def curl(*args):
    """Run curl with TLS verification and fail on HTTP errors.

    @param args extra curl arguments (URL included)
    @returns stdout bytes
    """
    return subprocess.run(
        ["curl", "-fsSL", "--retry", "3", "--max-time", str(TIMEOUT_S), *args],
        check=True,
        capture_output=True,
    ).stdout


def upstream_etag(url):
    """Return the ETag/Last-Modified fingerprint of the remote zip.

    @param url download URL
    @returns a string that changes whenever the upstream file changes, or None
        when the final response carries neither header (cache must not be trusted)
    """
    headers = {}
    for line in curl("-I", url).decode("latin-1").splitlines():
        if line.startswith("HTTP/"):
            headers = {}
        key, _, value = line.partition(":")
        headers[key.strip().lower()] = value.strip()
    etag, modified = headers.get("etag"), headers.get("last-modified")
    if not etag and not modified:
        return None
    return f"{etag}|{modified}"


def reproject_to_wgs84(src_path, dst_path):
    """Warp the TM2 (121) DTM to EPSG:4326, keeping its nodata and 20 m detail.

    Tiles are 128 px: OTP samples edges in graph order, which jumps across the
    whole island, so every lookup misses the raster tile cache; small tiles keep
    each miss cheap (512 px tiles made the national elevation pass ~14x slower).

    @param src_path GeoTIFF in the source projected CRS
    @param dst_path compressed EPSG:4326 GeoTIFF to write
    """
    import rasterio
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    with rasterio.open(src_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, "EPSG:4326", src.width, src.height, *src.bounds
        )
        profile = src.profile.copy()
        profile.update(
            driver="GTiff",
            crs="EPSG:4326",
            transform=transform,
            width=width,
            height=height,
            compress="deflate",
            predictor=3,
            tiled=True,
            blockxsize=128,
            blockysize=128,
            BIGTIFF="IF_SAFER",
        )
        with rasterio.open(dst_path, "w", **profile) as dst:
            reproject(
                source=rasterio.band(src, 1),
                destination=rasterio.band(dst, 1),
                src_nodata=src.nodata,
                dst_nodata=src.nodata,
                resampling=Resampling.bilinear,
            )


def main():
    """Refresh <dem-dir>/taiwan-dtm-20m.tif unless the upstream file is unchanged."""
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    dem_dir = sys.argv[1]
    os.makedirs(dem_dir, exist_ok=True)
    output = os.path.join(dem_dir, OUTPUT_NAME)
    source_file = os.path.join(dem_dir, SOURCE_NAME)

    url = whole_island_url(curl(RESOURCE_CSV_URL))
    etag = upstream_etag(url)
    if etag and os.path.exists(output) and os.path.exists(source_file):
        with open(source_file, encoding="utf-8") as f:
            if json.load(f).get("etag") == etag:
                log(f"{OUTPUT_NAME} is current ({etag}), skipping download")
                return

    with tempfile.TemporaryDirectory(dir=dem_dir) as tmp:
        zip_path = os.path.join(tmp, "dtm.zip")
        log(f"downloading {url}")
        subprocess.run(
            ["curl", "-fsSL", "--retry", "3", "--max-time", str(DOWNLOAD_TIMEOUT_S),
             "-o", zip_path, url],
            check=True,
        )
        with zipfile.ZipFile(zip_path) as zf:
            tifs = [n for n in zf.namelist() if n.lower().endswith((".tif", ".tiff"))]
            if len(tifs) != 1:
                raise SystemExit(f"expected exactly one GeoTIFF in the DTM zip, found {tifs}")
            raw_tif = zf.extract(tifs[0], tmp)
        os.remove(zip_path)
        staged = os.path.join(tmp, OUTPUT_NAME)
        log("reprojecting to EPSG:4326")
        reproject_to_wgs84(raw_tif, staged)
        os.replace(staged, output)

    with open(source_file, "w", encoding="utf-8") as f:
        json.dump({"url": url, "etag": etag}, f, ensure_ascii=False)
    log(f"staged {output} ({os.path.getsize(output) // 2**20} MiB)")


if __name__ == "__main__":
    main()
