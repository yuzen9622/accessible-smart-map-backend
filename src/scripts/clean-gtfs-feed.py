#!/usr/bin/env python3
"""Clean a TDX national GTFS zip in place for OTP2 consumption (Phase 16).

Every fix below corresponds to dirty data actually observed in the
2026-06-09 TDX feed; each class either aborts the OTP build outright or —
worse — builds a graph that crashes on load (self-loop pathways):

  1. trips.txt        duplicate trip_id rows (keep first)
  2. trips.txt        route_id references to nonexistent routes (drop, ferry strays)
  3. stop_times.txt   rows of trips dropped in (2); "HH:MM" times -> "HH:MM:SS";
                      rows whose stop_id is blank/absent from stops.txt (these
                      resolve to a null stop and NPE OTP's StopTimeMapper), then
                      trips left with < 2 valid stops (OTP rejects 0/1-stop trips)
  3b.frequencies.txt  rows whose trip_id was dropped in (2)/(3) — an orphan
                      frequency reference aborts OTP's entire GTFS load
  4. levels.txt       duplicate level_id rows (keep first)
  5. stops.txt        level_id references to nonexistent levels (blank out)
  6. pathways.txt     endpoints referencing nonexistent stops (drop),
                      endpoints with location_type=1 stations (drop),
                      self-loop pathways from_stop == to_stop (drop — these
                      serialize into duplicate vertex labels that NPE on load),
                      duplicate (from, to, mode) tuples (keep first)
  7. calendar.txt     duplicate service_id rows (keep the widest date range;
                      OTP aborts the whole build with
                      MultipleCalendarsForServiceIdException — seen 2026-10-02
                      on a TDX AirLine service listed twice)
  8. fare_*.txt       removed entirely — the TDX feed carries 3.8M fare rows
                      and OTP's per-itinerary fare scan costs ~20s per query;
                      this backend never consumes OTP fares

Usage: clean-gtfs-feed.py <feed.zip>   (rewrites the zip in place)
"""
from collections import Counter
import csv
import io
import re
import sys
import tempfile
import zipfile

HMS = re.compile(r"^\d{1,2}:\d{2}:\d{2}$")
HM = re.compile(r"^\d{1,2}:\d{2}$")


def read_rows(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        reader = csv.DictReader(text)
        return reader.fieldnames, list(reader)


def col_ids(rows, col):
    return {r[col] for r in rows if r.get(col)}


def main(zip_path: str) -> None:
    log = lambda *a: print("[clean-gtfs-feed]", *a)
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        tables = {}
        for name in ("trips.txt", "stop_times.txt", "levels.txt", "stops.txt",
                     "pathways.txt", "routes.txt", "frequencies.txt",
                     "calendar.txt"):
            if name in names:
                tables[name] = read_rows(zf, name)

        routes = col_ids(tables["routes.txt"][1], "route_id")
        stops_fields, stops = tables["stops.txt"]

        # 1+2. trips: dedupe + drop orphan route refs
        trips_fields, trips = tables["trips.txt"]
        seen, orphan_trips, clean_trips = set(), set(), []
        for r in trips:
            if r["trip_id"] in seen:
                continue
            seen.add(r["trip_id"])
            if r["route_id"] not in routes:
                orphan_trips.add(r["trip_id"])
                continue
            clean_trips.append(r)
        log(f"trips: kept={len(clean_trips)} dropped={len(trips) - len(clean_trips)}")

        # 3. stop_times: drop orphans + dangling stop refs, normalize HH:MM.
        #    A stop_time whose stop_id is blank or absent from stops.txt
        #    resolves to a null StopLocation and NPEs OTP's StopTimeMapper
        #    ("contains stop_time with no stop, location or group"); the TDX
        #    feed ships these on some city-bus trips (e.g. TNN_16303_*).
        stop_ids = col_ids(stops, "stop_id")
        st_fields, stop_times = tables["stop_times.txt"]
        clean_st, fixed_times, dangling = [], 0, 0
        for r in stop_times:
            if r["trip_id"] in orphan_trips:
                continue
            if r.get("stop_id", "") not in stop_ids:
                dangling += 1
                continue
            for col in ("arrival_time", "departure_time"):
                v = r.get(col, "")
                if v and not HMS.match(v) and HM.match(v):
                    r[col] = v + ":00"
                    fixed_times += 1
            clean_st.append(r)
        log(f"stop_times: kept={len(clean_st)} time_fixed={fixed_times} dangling_stop={dangling}")

        # 3b. drop trips left with < 2 valid stops — OTP rejects 0/1-stop trips
        st_counts = Counter(r["trip_id"] for r in clean_st)
        short_trips = {t["trip_id"] for t in clean_trips if st_counts[t["trip_id"]] < 2}
        if short_trips:
            clean_trips = [t for t in clean_trips if t["trip_id"] not in short_trips]
            clean_st = [r for r in clean_st if r["trip_id"] not in short_trips]
            log(f"trips: dropped {len(short_trips)} trips left with < 2 valid stops")

        # 3c. frequencies: drop rows for trips dropped in (2)/(3b). A frequency
        #     row whose trip_id no longer exists raises onebusaway's
        #     EntityReferenceNotFoundException and aborts OTP's whole GTFS load.
        #     The TDX feed ships single-stop "_F_" frequency trips (e.g.
        #     THB180202_45_1_F_*) that 3b drops, orphaning their frequency rows.
        clean_freq, freq_fields = [], None
        if "frequencies.txt" in tables:
            freq_fields, freqs = tables["frequencies.txt"]
            kept_trips = {t["trip_id"] for t in clean_trips}
            clean_freq = [r for r in freqs if r.get("trip_id", "") in kept_trips]
            log(f"frequencies: kept={len(clean_freq)} dropped={len(freqs) - len(clean_freq)}")

        # 4. levels: dedupe
        clean_levels, levels_fields = [], None
        if "levels.txt" in tables:
            levels_fields, levels = tables["levels.txt"]
            seen = set()
            for r in levels:
                if r["level_id"] in seen:
                    continue
                seen.add(r["level_id"])
                clean_levels.append(r)
            log(f"levels: kept={len(clean_levels)} dropped={len(levels) - len(clean_levels)}")
        level_ids = {r["level_id"] for r in clean_levels}

        # 5. stops: blank missing level refs
        blanked = 0
        for r in stops:
            if r.get("level_id") and r["level_id"] not in level_ids:
                r["level_id"] = ""
                blanked += 1
        log(f"stops: level refs blanked={blanked}")
        stop_loctype = {r["stop_id"]: (r.get("location_type") or "0") for r in stops}

        # 6. pathways
        clean_pathways, pathways_fields = [], None
        if "pathways.txt" in tables:
            pathways_fields, pathways = tables["pathways.txt"]
            seen = set()
            for r in pathways:
                f, t = r["from_stop_id"], r["to_stop_id"]
                if f not in stop_loctype or t not in stop_loctype:
                    continue
                if "1" in (stop_loctype[f], stop_loctype[t]):
                    continue
                if f == t:
                    continue
                key = (f, t, r.get("pathway_mode", ""))
                if key in seen:
                    continue
                seen.add(key)
                clean_pathways.append(r)
            log(f"pathways: kept={len(clean_pathways)} dropped={len(pathways) - len(clean_pathways)}")

        # 7. calendar: one row per service_id. When TDX lists a service twice
        #    the rows usually nest (a one-day row inside a multi-week one), so
        #    the widest range keeps every date the operator published.
        clean_calendar, calendar_fields = [], None
        if "calendar.txt" in tables:
            calendar_fields, calendar = tables["calendar.txt"]
            by_service = {}
            for r in calendar:
                sid = r["service_id"]
                best = by_service.get(sid)
                span = (r.get("end_date", ""), "-" + r.get("start_date", ""))
                if best is None or span > (best.get("end_date", ""), "-" + best.get("start_date", "")):
                    by_service[sid] = r
            clean_calendar = list(by_service.values())
            log(f"calendar: kept={len(clean_calendar)} dropped_duplicates={len(calendar) - len(clean_calendar)}")

        # Rewrite the zip: copy untouched entries, replace cleaned ones.
        cleaned = {
            "trips.txt": (trips_fields, clean_trips),
            "stop_times.txt": (st_fields, clean_st),
            "stops.txt": (stops_fields, stops),
        }
        if levels_fields:
            cleaned["levels.txt"] = (levels_fields, clean_levels)
        if pathways_fields:
            cleaned["pathways.txt"] = (pathways_fields, clean_pathways)
        if freq_fields:
            cleaned["frequencies.txt"] = (freq_fields, clean_freq)
        if calendar_fields:
            cleaned["calendar.txt"] = (calendar_fields, clean_calendar)

        dropped_files = [n for n in zf.namelist() if n.startswith("fare_")]
        if dropped_files:
            log(f"dropping fare files: {', '.join(sorted(dropped_files))}")

        with tempfile.NamedTemporaryFile(dir=".", suffix=".zip", delete=False) as tmp:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
                for name in zf.namelist():
                    if name in dropped_files:
                        continue
                    if name in cleaned:
                        fields, rows = cleaned[name]
                        buf = io.StringIO()
                        w = csv.DictWriter(buf, fieldnames=fields)
                        w.writeheader()
                        w.writerows(rows)
                        out.writestr(name, buf.getvalue())
                    else:
                        out.writestr(name, zf.read(name))
            tmp_path = tmp.name

    import os
    os.replace(tmp_path, zip_path)
    log(f"rewrote {zip_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
