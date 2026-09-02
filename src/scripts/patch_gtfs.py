#!/usr/bin/env python3
import concurrent.futures
import csv
import datetime
import http.client
import io
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from array import array

# Script to patch a GTFS static feed zip file with Taiwan City + InterCity bus
# GeneralTimetable (定期班表) data and shape geometry. The regular timetable
# carries per-trip ServiceDay week flags, so patched trips are written as weekly
# calendar.txt services valid for CALENDAR_VALID_DAYS. Some cities (Taichung,
# Taoyuan, …) publish origin-departure-only general timetables (a single StopTime
# per trip); for those the city's DailyTimetable is fetched as well and its
# per-stop travel-time profile is grafted onto the general timetable's origin
# time + ServiceDay to synthesise full stop_times. Also, shape geometry is fetched
# from the TDX Bus Shape API to populate shapes.txt for routes missing shapes.
# Preserves non-bus (TRA, THSR, Metro) schedules by matching route_type != 3.

CITIES = [
    "Taipei",
    "NewTaipei",
    "Tainan",
    "KinmenCounty",
    "LienchiangCounty",
    "Taichung",
    "Taoyuan",
    "Keelung",
    "Hsinchu",
    "HsinchuCounty",
    "MiaoliCounty",
    "ChanghuaCounty",
    "NantouCounty",
    "YunlinCounty",
    "ChiayiCounty",
    "Chiayi",
    "PingtungCounty",
    "YilanCounty",
    "HualienCounty",
    "TaitungCounty",
    "Kaohsiung",
    "PenghuCounty",
]

CALENDAR_VALID_DAYS = 180
SHAPE_FIT_TOLERANCE_M = 100

# Valhalla /route accepts a bounded number of locations per request; longer
# subroutes are split into consecutive chunks that share a boundary stop.
VALHALLA_MAX_LOCATIONS = 40

# Bounded worker pool for the per-subroute Valhalla travel-time profile calls.
# This runs across thousands of freq-only subroutes at build time, so it must
# not hammer Valhalla unbounded; 8 concurrent profile requests is the ceiling.
VALHALLA_CONCURRENCY = 8

# Socket timeout (seconds) for every TDX request, so a half-open connection
# cannot hang the batch indefinitely.
REQUEST_TIMEOUT = 60

# TDX ServiceDay keys in GTFS calendar.txt column order (monday..sunday).
WEEKDAY_KEYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
]
GTFS_WEEKDAY_COLS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]

# Transport-layer exceptions that are transient and worth retrying. HTTPException
# covers truncated reads and other HTTP protocol failures outside OSError.
TRANSPORT_ERRORS = (
    urllib.error.URLError,
    http.client.HTTPException,
    TimeoutError,
    ConnectionError,
    OSError,
)


class DailyTimetableUnavailable(Exception):
    """Business signal that a source has no usable per-stop daily timetable —
    either HTTP 400 on both v2 and v3, or a structurally valid response with no
    timetable carrying >=2 stops (empty / origin-only). This is the only signal
    that triggers the StopOfRoute synthesis fallback."""


class TdxFetchError(Exception):
    """Fatal, non-degradable fetch failure: 5xx after retries, transport error
    after retries, JSON parse failure, or v3 wrapper schema drift (missing key,
    wrong type, non-dict element). Propagates so the import exits non-zero
    rather than pretending success."""


class TdxHttpError(TdxFetchError):
    """A 4xx HTTP error (including 400) carrying the response body. e.read()
    consumes the stream and the default HTTPError string omits the body, so we
    capture status/reason/url/body for diagnostics. The version cascade branches
    on .status to detect 400; any TdxHttpError not interpreted by the cascade is
    fatal (subclass of TdxFetchError)."""

    def __init__(self, status, reason, url, body):
        self.status = status
        self.reason = reason
        self.url = url
        self.body = body or ""
        super().__init__(f"HTTP {status} {reason} @ {url} :: {self.body[:200]}")


def daily_records_usable(records):
    """True when at least one route carries a timetable with >=2 valid stops,
    i.e. the batch can graft a real per-stop profile onto an origin-only route.
    This is a batch-level check: a source that yields any usable profile is
    accepted, and routes lacking one are skipped as short_trip downstream."""
    for route in records or []:
        for tt in route.get("Timetables") or route.get("TimeTables") or []:
            if len(valid_stop_entries(tt)) >= 2:
                return True
    return False


def get_tdx_token(client_id, client_secret):
    url = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
    data = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        }
    ).encode("utf-8")

    if not url.startswith(("http://", "https://")):
        raise ValueError(f"invalid TDX auth url scheme: {url}")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    for retry in range(3):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
                res_data = json.loads(res.read().decode("utf-8"))
                return res_data["access_token"]
        except Exception as e:
            print(
                f"Error getting TDX token (attempt {retry + 1}): {e}", file=sys.stderr
            )
            time.sleep(2)
    sys.exit(1)


def _unwrap_page(body, page_key, skip, strict):
    """Extract the record list from a decoded page body. v2 endpoints return a
    bare list; v3 endpoints wrap it as {..., <page_key>: [...]}. In strict mode
    a shape mismatch (schema drift) raises TdxFetchError; in legacy (non-strict)
    mode it degrades to an empty page as the original code did."""
    if page_key is None:
        if isinstance(body, list):
            records = body
        elif strict:
            raise TdxFetchError(
                f"expected top-level list at skip={skip}, got {type(body).__name__}"
            )
        else:
            return []
    else:
        if not isinstance(body, dict):
            if strict:
                raise TdxFetchError(
                    f"expected wrapper object for '{page_key}' at skip={skip}, got {type(body).__name__}"
                )
            return []
        if page_key not in body:
            # TDX v3 empty response convention: when 0 records exist, TDX returns
            # the metadata header (UpdateTime, AuthorityCode, etc.) without the array property.
            if skip == 0 and any(
                k in body for k in ("UpdateTime", "SrcUpdateTime", "AuthorityCode")
            ):
                return []
            if strict:
                raise TdxFetchError(
                    f"v3 wrapper missing key '{page_key}' at skip={skip} (schema drift)"
                )
            return []
        inner = body[page_key]
        if not isinstance(inner, list):
            if strict:
                raise TdxFetchError(
                    f"v3 wrapper '{page_key}' is {type(inner).__name__}, not list, at skip={skip}"
                )
            return []
        records = inner

    if strict:
        for idx, rec in enumerate(records):
            if not isinstance(rec, dict):
                raise TdxFetchError(
                    f"non-dict element in '{page_key or 'list'}' at skip={skip}, index {idx}: {type(rec).__name__}"
                )
    return records


def fetch_paginated_api(token, url_template, page_key=None, strict=False):
    records = []
    top = 1000
    skip = 0

    while True:
        parsed_url = urllib.parse.urlparse(url_template)
        encoded_path = urllib.parse.quote(parsed_url.path)
        query_parts = urllib.parse.parse_qsl(parsed_url.query)
        query_map = dict(query_parts)
        query_map["$top"] = str(top)
        query_map["$skip"] = str(skip)
        encoded_query = urllib.parse.urlencode(query_map, safe="=&?$")

        url = urllib.parse.urlunparse(
            (
                parsed_url.scheme,
                parsed_url.netloc,
                encoded_path,
                parsed_url.params,
                encoded_query,
                parsed_url.fragment,
            )
        )

        if not url.startswith(("http://", "https://")):
            raise ValueError(f"invalid url scheme: {url}")
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {token}", "accept": "application/json"},
        )

        success = False
        page_size = 0
        for retry in range(5):
            try:
                with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
                    raw = res.read().decode("utf-8")
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError as e:
                    if strict:
                        raise TdxFetchError(f"invalid JSON at skip={skip}: {e}") from e
                    body = []
                page_data = _unwrap_page(body, page_key, skip, strict)
                records.extend(page_data)
                page_size = len(page_data)
                success = True
                break
            except TdxFetchError:
                # Deterministic contract errors (parse / schema drift / re-raised
                # TdxHttpError) are never transient — surface immediately.
                raise
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    backoff = 2 * (retry + 1)
                    print(
                        f"  Received 429 Too Many Requests. Backing off for {backoff}s...",
                        file=sys.stderr,
                    )
                    time.sleep(backoff)
                elif 400 <= e.code < 500:
                    try:
                        body = e.read().decode("utf-8", errors="replace")
                    except TRANSPORT_ERRORS:
                        body = ""
                    print(
                        f"  HTTP error {e.code}: {e.reason} :: {body[:200]}",
                        file=sys.stderr,
                    )
                    raise TdxHttpError(e.code, e.reason, url, body) from e
                else:
                    print(f"  HTTP error {e.code}: {e.reason}", file=sys.stderr)
                    time.sleep(1)
            except TRANSPORT_ERRORS as e:
                print(f"  Network error: {e}", file=sys.stderr)
                time.sleep(1)

        if not success:
            if strict:
                raise TdxFetchError(
                    f"failed to fetch page at skip={skip} after {5} retries (5xx/transport)"
                )
            print(
                f"  Failed to fetch page at skip={skip} after multiple retries. Skipping remaining pages.",
                file=sys.stderr,
            )
            break

        if page_size < top:
            break

        skip += top
        time.sleep(0.1)

    return records


_TDX_BASE = "https://tdx.transportdata.tw/api/basic"


def V2_SCHED(city):
    return f"{_TDX_BASE}/v2/Bus/Schedule/City/{city}?%24format=JSON"


def V3_SCHED(city):
    return f"{_TDX_BASE}/v3/Bus/Schedule/City/{city}?%24format=JSON"


def V2_DAILY(city):
    return f"{_TDX_BASE}/v2/Bus/DailyTimeTable/City/{city}?%24format=JSON"


def V3_DAILY(city):
    return f"{_TDX_BASE}/v3/Bus/DailyTimeTable/City/{city}?%24format=JSON"


def V2_SHAPE(city):
    return f"{_TDX_BASE}/v2/Bus/Shape/City/{city}?%24format=JSON"


def V2_STOP_OF_ROUTE(city):
    return f"{_TDX_BASE}/v2/Bus/StopOfRoute/City/{city}?%24format=JSON"


V2_SCHED_INTERCITY = f"{_TDX_BASE}/v2/Bus/Schedule/InterCity?%24format=JSON"
V2_DAILY_INTERCITY = f"{_TDX_BASE}/v2/Bus/DailyTimeTable/InterCity?%24format=JSON"
V2_SHAPE_INTERCITY = f"{_TDX_BASE}/v2/Bus/Shape/InterCity?%24format=JSON"
V2_STOP_OF_ROUTE_INTERCITY = f"{_TDX_BASE}/v2/Bus/StopOfRoute/InterCity?%24format=JSON"


def fetch_with_version(token, v2_url, v3_url, page_key):
    """Fetch a source, falling back v2 -> v3 on HTTP 400 only. Returns
    (records, source) where source is "v2" or "v3". A 400 from both versions
    re-raises the v3 TdxHttpError (carrying the v3 body); any non-400 HTTP
    error and every other TdxFetchError propagate as fatal. Suitable for
    sources with no usability concept (e.g. Schedule)."""
    try:
        return fetch_paginated_api(token, v2_url, strict=True), "v2"
    except TdxHttpError as e:
        if e.status != 400:
            raise
    return fetch_paginated_api(token, v3_url, page_key=page_key, strict=True), "v3"


def fetch_city_schedule(token, city):
    """Schedule for a city, v2 -> v3. Both versions 400 means the city has
    vanished from TDX entirely (the original incident), so it is fatal rather
    than a silent skip. When Schedule returns 200 with 0 records (e.g. Kaohsiung),
    falls back to DailyTimeTable with default daily ServiceDay."""
    try:
        recs, src = fetch_with_version(token, V2_SCHED(city), V3_SCHED(city), "Schedules")
        if recs:
            return recs, src
    except TdxHttpError as e:
        if e.status == 400:
            raise TdxFetchError(
                f"{city}: Schedule returned 400 on both v2 and v3 — the city may have been "
                f"removed from TDX; aborting so patch_gtfs_zip does not overwrite the feed "
                f"without it. TDX body: {e.body[:200]}"
            ) from e
        raise

    # When Schedule returns HTTP 200 empty list (e.g. Kaohsiung publishes DailyTimeTable only),
    # fall back to DailyTimeTable as the schedule source.
    try:
        daily_recs = fetch_paginated_api(token, V2_DAILY(city), strict=True)
        if daily_recs:
            default_service_day = dict.fromkeys(WEEKDAY_KEYS, 1)
            for r in daily_recs:
                for tt in (r.get("Timetables") or r.get("TimeTables") or []):
                    tt.setdefault("ServiceDay", default_service_day)
            return daily_recs, "daily_as_sched"
    except (TdxHttpError, TdxFetchError):
        pass
    return [], "none"


def fetch_daily_timetable(token, city):
    """Daily timetable for a city with a usability-aware cascade: v2 -> v3 when
    v2 is 400 OR returns a structurally-valid but unusable batch (empty /
    origin-only). Returns (records, source). Raises DailyTimetableUnavailable
    (the only signal that triggers StopOfRoute synthesis) when neither version
    yields a usable batch; non-400 HTTP and schema-drift errors stay fatal."""
    try:
        recs = fetch_paginated_api(token, V2_DAILY(city), strict=True)
        if daily_records_usable(recs):
            return recs, "v2"
    except TdxHttpError as e:
        if e.status != 400:
            raise
    try:
        recs = fetch_paginated_api(
            token, V3_DAILY(city), page_key="DailyTimeTables", strict=True
        )
    except TdxHttpError as e:
        if e.status == 400:
            raise DailyTimetableUnavailable(
                f"{city}: DailyTimeTable unavailable (400 on v2 and v3)"
            ) from e
        raise
    if not daily_records_usable(recs):
        raise DailyTimetableUnavailable(
            f"{city}: DailyTimeTable structurally valid on v2/v3 but has no usable per-stop timetable (empty/origin-only)"
        )
    return recs, "v3"


def fetch_intercity_daily(token):
    """InterCity daily timetable (v2 only), symmetric with the City cascade: a
    400 or a valid-but-unusable batch degrades to StopOfRoute synthesis; other
    errors stay fatal."""
    try:
        recs = fetch_paginated_api(token, V2_DAILY_INTERCITY, strict=True)
    except TdxHttpError as e:
        if e.status == 400:
            raise DailyTimetableUnavailable(
                "InterCity: DailyTimeTable unavailable (400)"
            ) from e
        raise
    if not daily_records_usable(recs):
        raise DailyTimetableUnavailable(
            "InterCity: DailyTimeTable has no usable per-stop timetable"
        )
    return recs, "v2"


def fetch_stop_of_route(token, url):
    """StopOfRoute for the DailyTimeTable degradation path. Tolerates a 400
    (source also unsupported) by returning []; every other error is fatal."""
    try:
        return fetch_paginated_api(token, url, strict=True)
    except TdxHttpError as e:
        if e.status == 400:
            print(
                "  StopOfRoute unsupported (400) — skipping daily for this source",
                file=sys.stderr,
            )
            return []
        raise


def fetch_shape(token, url):
    """Shape geometry (v2). Tolerates a 400 (missing geometry is non-fatal) by
    returning []; 5xx/transport/parse errors are fatal via strict mode."""
    try:
        return fetch_paginated_api(token, url, strict=True)
    except TdxHttpError as e:
        if e.status == 400:
            print("  Shape unsupported (400) — skipping geometry", file=sys.stderr)
            return []
        raise


def _synthesize_from_stop_of_route(sor_records):
    """Build v2-compatible daily records from StopOfRoute stop sequences, giving
    each stop a synthetic 2-min-per-stop travel-time profile. Only routes with
    >=2 usable stops are emitted (a 1-stop profile is never consumed by
    build_daily_profiles and would misreport as synthesized)."""
    synthetic = []
    for r in sor_records:
        ruid = r.get("RouteUID")
        sub_route_uid = r.get("SubRouteUID") or ruid
        direction = r.get("Direction", 0)
        stops = r.get("Stops", [])
        if not (ruid and stops):
            continue

        def seq_key(s):
            try:
                return int(s.get("StopSequence", 0))
            except (TypeError, ValueError):
                return 0

        sorted_stops = sorted(stops, key=seq_key)
        stop_times = []
        for i, s in enumerate(sorted_stops):
            stop_id = s.get("StopUID") or s.get("StopID")
            seq = s.get("StopSequence", i + 1)
            if stop_id:
                offset_min = i * 2
                time_str = f"{offset_min // 60:02d}:{offset_min % 60:02d}"
                stop_times.append(
                    {
                        "StopUID": stop_id,
                        "StopSequence": seq,
                        "ArrivalTime": time_str,
                        "DepartureTime": time_str,
                    }
                )
        if len(stop_times) >= 2:
            synthetic.append(
                {
                    "RouteUID": ruid,
                    "SubRouteUID": sub_route_uid,
                    "Direction": direction,
                    "TimeTables": [{"StopTimes": stop_times}],
                }
            )
    return synthetic


def fetch_source(
    token,
    label,
    schedule_records,
    daily_records,
    shape_records,
    sor_records,
    schedule_fetcher,
    daily_fetcher,
    stop_of_route_fetcher,
    shape_fetcher,
):
    """Fetch one source (a city or InterCity) and extend the shared record
    lists. StopOfRoute is fetched once per source and reused both for the
    frequency-based subroute stop index and for the DailyTimetableUnavailable
    synthesis path (no double fetch). Only DailyTimetableUnavailable triggers
    the StopOfRoute degradation; every other exception (TdxFetchError,
    TdxHttpError, transport) propagates so the import fails rather than silently
    producing a feed missing a source. Returns a per-source fetch summary."""
    records, sched_source = schedule_fetcher()
    if not records:
        raise TdxFetchError(
            f"{label}: Schedule returned 0 records (HTTP 200 empty / upstream anomaly). "
            f"Aborting so patch_gtfs_zip does not delete every bus trip and atomically "
            f"overwrite the feed without {label} (the same whole-city disappearance as the incident)."
        )
    schedule_records.extend(records)

    sor_recs = stop_of_route_fetcher()
    sor_records.extend(sor_recs)

    daily_source, synth_profiles = "none", 0
    if needs_daily_fallback(records):
        try:
            d_recs, daily_source = daily_fetcher()
            daily_records.extend(d_recs)
        except DailyTimetableUnavailable:
            print(
                f"  {label}: DailyTimeTable unavailable — synthesizing profiles from StopOfRoute",
                file=sys.stderr,
            )
            synth = _synthesize_from_stop_of_route(sor_recs)
            daily_records.extend(synth)
            daily_source, synth_profiles = "stoproute", len(synth)
        time.sleep(0.5)

    shape_records.extend(shape_fetcher())
    time.sleep(0.5)

    summary = {
        "city": label,
        "schedule": len(records),
        "schedule_source": sched_source,
        "daily_source": daily_source,
        "synth_profiles": synth_profiles,
        "stop_of_route": len(sor_recs),
    }
    print(
        f"  {label}: schedule={summary['schedule']}({sched_source}), "
        f"daily_source={daily_source}, synth_profiles={synth_profiles}, "
        f"stop_of_route={len(sor_recs)}"
    )
    return summary


def service_id_for_pattern(pattern):
    return "patched_" + "".join(str(d) for d in pattern)


def parse_hhmm(value):
    if not value:
        return None
    parts = value.split(":")
    if len(parts) < 2:
        return None
    try:
        return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        return None


def fmt_gtfs_time(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}:00"


def valid_stop_entries(timetable):
    entries = []
    for st in timetable.get("StopTimes") or []:
        arr = st.get("ArrivalTime") or st.get("DepartureTime")
        dep = st.get("DepartureTime") or st.get("ArrivalTime")
        stop_id = st.get("StopUID") or st.get("StopID")
        if arr and dep and stop_id:
            entries.append((arr, dep, stop_id, st.get("StopSequence")))
    return entries


def needs_daily_fallback(records):
    for route in records:
        for tt in route.get("Timetables") or route.get("TimeTables") or []:
            if len(valid_stop_entries(tt)) == 1:
                return True
    return False


def normalize_stop_entries(entries):
    """Sorts by stop_sequence (GTFS ordering; TDX occasionally ships the array
    out of order), unrolls midnight wraps and clamps minute-level time jitter
    so times are monotonic. Returns [(stop_id, seq, arr_min, dep_min)] in
    absolute minutes, or None when any time is unparsable."""

    def seq_key(entry):
        try:
            return int(entry[3])
        except (TypeError, ValueError):
            return 0

    entries = sorted(entries, key=seq_key)
    prev = parse_hhmm(entries[0][0])
    if prev is None:
        return None
    out = []
    for arr_raw, dep_raw, stop_id, seq in entries:
        arr = parse_hhmm(arr_raw)
        dep = parse_hhmm(dep_raw)
        if arr is None or dep is None:
            return None
        # A large backwards jump is a midnight wrap; a small one is data
        # jitter and gets clamped.
        if arr < prev - 720:
            arr += 1440
        if dep < arr - 720:
            dep += 1440
        arr = max(arr, prev)
        dep = max(dep, arr)
        prev = dep
        out.append((stop_id, seq, arr, dep))
    return out


def build_daily_profiles(daily_records):
    profiles = {}
    for route in daily_records:
        key_uid = route.get("SubRouteUID") or route.get("RouteUID")
        direction = route.get("Direction", 0)
        if not key_uid:
            continue
        for tt in route.get("Timetables") or route.get("TimeTables") or []:
            entries = valid_stop_entries(tt)
            if len(entries) < 2:
                continue
            norm = normalize_stop_entries(entries)
            if not norm:
                continue
            origin = norm[0][3]
            stops = [
                (stop_id, seq, arr - origin, dep - origin)
                for stop_id, seq, arr, dep in norm
            ]
            profiles.setdefault((key_uid, direction), []).append(
                {"origin": origin, "stops": stops}
            )
    return profiles


def parse_linestring(geom):
    """Parse LINESTRING (lon lat, lon lat, ...) into a list of (lat, lon) coordinates."""
    if not geom or not geom.startswith("LINESTRING"):
        return []
    try:
        start_idx = geom.find("(")
        end_idx = geom.rfind(")")
        if start_idx == -1 or end_idx == -1:
            return []
        content = geom[start_idx + 1 : end_idx]
        pts = []
        for pair in content.split(","):
            pair = pair.strip()
            if not pair:
                continue
            parts = pair.split()
            if len(parts) >= 2:
                # TDX coordinates are [longitude, latitude]
                lon = float(parts[0])
                lat = float(parts[1])
                pts.append((lat, lon))
        return pts
    except Exception:
        return []


def build_shape_index(shape_records):
    """Index TDX shapes primarily by subroute and secondarily by RouteUID.

    The RouteUID entry is a first-seen coarse fallback and can represent any
    subroute when multiple subroutes share a RouteUID. ShapeAssigner therefore
    validates every indexed geometry against the trip stops before using it.
    """
    index = {}
    for r in shape_records:
        suid = r.get("SubRouteUID")
        ruid = r.get("RouteUID")
        direction = r.get("Direction", 0)
        pts = parse_linestring(r.get("Geometry"))
        if not pts:
            continue
        if suid:
            index[(suid, direction)] = pts
        if ruid:
            index.setdefault((ruid, direction), pts)
    return index


def synthesize_stop_rows(trip_id, timetable, key_uids, direction, daily_profiles):
    entries = valid_stop_entries(timetable)
    if len(entries) != 1:
        return None
    origin = parse_hhmm(entries[0][1])
    if origin is None:
        return None
    plist = None
    for key_uid in key_uids:
        if key_uid:
            plist = daily_profiles.get((key_uid, direction))
            if plist:
                break
    if not plist:
        return None
    profile = min(plist, key=lambda p: abs(p["origin"] - origin))
    rows = []
    for stop_id, seq, arr_off, dep_off in profile["stops"]:
        rows.append(
            {
                "trip_id": trip_id,
                "arrival_time": fmt_gtfs_time(origin + arr_off),
                "departure_time": fmt_gtfs_time(origin + dep_off),
                "stop_id": stop_id,
                "stop_sequence": str(seq),
            }
        )
    return rows


def synthesize_stop_rows_from_sor(
    trip_id, timetable, key_uids, direction, sor_index, profile_cache, fail_counter=None
):
    """StopOfRoute fallback for an origin-only timetable that has no >=2-stop daily
    profile: synthesise full stop_times from the subroute's StopOfRoute stop
    sequence and a Valhalla travel-time profile, anchored at the origin departure.
    The per-subroute profile is computed once via build_travel_profile and memoised
    in the shared profile_cache (keyed by the resolved (key_uid, direction)), so
    every origin-only trip of the same subroute reuses one geometry. Returns rows,
    or None when the timetable is not origin-only or the subroute has < 2 indexed
    StopOfRoute stops (genuinely no data)."""
    entries = valid_stop_entries(timetable)
    if len(entries) != 1:
        return None
    origin = parse_hhmm(entries[0][1])
    if origin is None or sor_index is None:
        return None
    stops = None
    resolved_key = None
    for key_uid in key_uids:
        if key_uid and (key_uid, direction) in sor_index:
            resolved_key = (key_uid, direction)
            stops = sor_index[resolved_key]
            break
    if not stops or len(stops) < 2:
        return None
    if profile_cache is not None and resolved_key in profile_cache:
        profile = profile_cache[resolved_key]
    else:
        coords = [(s["lat"], s["lon"]) for s in stops]
        profile = build_travel_profile(coords, fail_counter)
        if profile_cache is not None:
            profile_cache[resolved_key] = profile
    rows = []
    prev_t = None
    for i, s in enumerate(stops):
        t = origin + round(profile[i] / 60)
        if prev_t is not None and t <= prev_t:
            t = prev_t + 1
        prev_t = t
        rows.append(
            {
                "trip_id": trip_id,
                "arrival_time": fmt_gtfs_time(t),
                "departure_time": fmt_gtfs_time(t),
                "stop_id": s["StopUID"],
                "stop_sequence": str(s["seq"]),
            }
        )
    return rows


def build_stop_of_route_index(sor_records):
    """Index StopOfRoute records by (SubRouteUID, Direction) -> ordered list of
    {StopUID, seq, lat, lon}. Stops without a StopUID or coordinates are dropped;
    only subroutes with >=2 resolvable stops (needed to form a stop_times pair)
    are indexed."""
    index = {}
    for r in sor_records:
        key_uid = r.get("SubRouteUID") or r.get("RouteUID")
        direction = r.get("Direction", 0)
        raw_stops = r.get("Stops") or []
        if not key_uid or not raw_stops:
            continue
        stops = []
        for s in raw_stops:
            stop_id = s.get("StopUID") or s.get("StopID")
            pos = s.get("StopPosition") or {}
            lat = pos.get("PositionLat")
            lon = pos.get("PositionLon")
            if stop_id is None or lat is None or lon is None:
                continue
            try:
                seq = int(s.get("StopSequence", 0))
            except (TypeError, ValueError):
                seq = 0
            stops.append({"StopUID": stop_id, "seq": seq, "lat": lat, "lon": lon})
        stops.sort(key=lambda x: x["seq"])
        if len(stops) >= 2:
            index[(key_uid, direction)] = stops
    return index


def _valhalla_route_times(locations):
    """POST a list of (lat, lon) locations to ${VALHALLA_BASE_URL}/route with
    costing "auto" and return the per-consecutive-pair travel time in seconds
    (trip.legs[i].summary.time). Length is len(locations) - 1. Raises on missing
    env, transport error, or unexpected response shape."""
    base = os.environ.get("VALHALLA_BASE_URL")
    if not base:
        raise RuntimeError("VALHALLA_BASE_URL is not set")
    url = base.rstrip("/") + "/route"
    payload = {
        "locations": [{"lat": lat, "lon": lon} for (lat, lon) in locations],
        "costing": "auto",
    }
    data = json.dumps(payload).encode("utf-8")
    if not url.startswith(("http://", "https://")):
        raise ValueError(f"invalid valhalla url scheme: {url}")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
        try:
            body = json.loads(res.read().decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as err:
            raise RuntimeError(f"invalid JSON response from Valhalla: {err}") from err
    legs = body.get("trip", {}).get("legs", [])
    return [leg.get("summary", {}).get("time", 0) for leg in legs]


def _valhalla_profile(stops):
    """Build an N-length cumulative-seconds travel profile for N ordered stops
    via Valhalla. Splits into consecutive chunks of at most VALHALLA_MAX_LOCATIONS
    where adjacent chunks share the boundary stop (so no leg time is lost or
    double counted), then stitches the per-chunk cumulative sums together."""
    n = len(stops)
    if n < 2:
        raise ValueError("need >=2 stops for a travel profile")
    profile = [0]
    start = 0
    while True:
        end = min(start + VALHALLA_MAX_LOCATIONS, n)
        chunk = stops[start:end]
        times = _valhalla_route_times(chunk)
        if len(times) != len(chunk) - 1:
            raise ValueError(
                f"Valhalla returned {len(times)} legs for {len(chunk)} locations"
            )
        for t in times:
            profile.append(profile[-1] + t)
        if end >= n:
            break
        start = end - 1
    return profile


def build_travel_profile(stops, fail_counter=None):
    """Return an N-length cumulative-seconds profile for N ordered (lat, lon)
    stops: profile[0] == 0, monotonic non-decreasing. On ANY failure (network,
    bad response, or a violated invariant) fall back to a 2-min-per-stop profile
    so the subroute stays plannable, and increment fail_counter[0] (guarded by a
    lock) when one is provided."""
    n = len(stops)
    try:
        profile = _valhalla_profile(stops)
        assert len(profile) == n
        assert profile[0] == 0
        assert all(profile[i] <= profile[i + 1] for i in range(len(profile) - 1))
        return profile
    except Exception:
        if fail_counter is not None:
            with _VALHALLA_FAIL_LOCK:
                fail_counter[0] += 1
        return [i * 120 for i in range(n)]


_VALHALLA_FAIL_LOCK = threading.Lock()


def _mean_headway_secs(min_h, max_h):
    """Mean of the min/max headway minutes converted to whole seconds, matching
    the metro convention. None when neither value is numeric."""
    vals = [v for v in (min_h, max_h) if isinstance(v, (int, float))]
    if not vals:
        return None
    return round(sum(vals) / len(vals) * 60)


def _merge_frequency_windows(windows):
    """Merge overlapping/duplicate frequency windows WITHIN a single template
    trip so the feed never carries two overlapping windows for the same trip_id
    (which fails the gtfs-validator). Windows are [start, end) in minutes; an
    overlap extends the earlier window's end and keeps its headway."""
    ordered = sorted(windows, key=lambda w: (w["start"], w["end"]))
    merged = []
    for w in ordered:
        if merged and w["start"] < merged[-1]["end"]:
            if w["end"] > merged[-1]["end"]:
                merged[-1]["end"] = w["end"]
        else:
            merged.append(dict(w))
    return merged


class ShapeAssigner:
    """Choose and validate geometry for patched trips before OTP sees the feed.

    @param route_shape_by_route Existing route_id to static shape_id mapping.
    @param tdx_shapes TDX shapes indexed by UID and direction.
    @param static_shape_points Existing static geometry needed by bus routes.
    @param stop_coords GTFS stop_id to latitude/longitude mapping.
    @param stats Mutable patch summary counters.
    """

    def __init__(
        self, route_shape_by_route, tdx_shapes, static_shape_points, stop_coords, stats
    ):
        self.route_shape_by_route = route_shape_by_route
        self.tdx_shapes = tdx_shapes
        self.static_shape_points = static_shape_points
        self.stop_coords = stop_coords
        self.stats = stats
        self.new_shapes = {}
        self._fit_cache = {}
        self._flat_cache = {}

    @staticmethod
    def _flatten(points):
        """Return geometry as flat latitude/longitude doubles.

        @param points Either an array('d') or an iterable of (lat, lon) pairs.
        @returns A flat array ordered as lat0, lon0, lat1, lon1, and so on.
        """
        if isinstance(points, array):
            return points
        flat = array("d")
        for lat, lon in points:
            try:
                flat.extend((float(lat), float(lon)))
            except (ValueError, TypeError):
                continue
        return flat

    def _fits(self, points, stop_ids, shape_cache_key):
        """Return whether every located stop lies within the shape tolerance.

        @param points Shape geometry in flat or pair form.
        @param stop_ids Ordered GTFS stop identifiers for the trip.
        @param shape_cache_key Stable identity for fit-result memoization.
        @returns True when all located stops fit, including no-coordinate feeds.
        """
        located_stops = [
            self.stop_coords[stop_id]
            for stop_id in stop_ids
            if stop_id in self.stop_coords
        ]
        if not located_stops:
            return True

        fit_key = (shape_cache_key, tuple(stop_ids))
        if fit_key in self._fit_cache:
            return self._fit_cache[fit_key]

        flat = self._flat_cache.get(shape_cache_key)
        if flat is None:
            flat = self._flatten(points)
            self._flat_cache[shape_cache_key] = flat
        if len(flat) < 4:
            self._fit_cache[fit_key] = False
            return False

        point_count = len(flat) // 2
        lat0 = sum(flat[i] for i in range(0, len(flat), 2)) / point_count
        kx = 111320 * math.cos(math.radians(lat0))
        ky = 110540
        tolerance = SHAPE_FIT_TOLERANCE_M
        tolerance_sq = tolerance * tolerance

        projected = array("d")
        for i in range(0, len(flat), 2):
            projected.extend((flat[i + 1] * kx, flat[i] * ky))

        fits = True
        for lat, lon in located_stops:
            try:
                px = float(lon) * kx
                py = float(lat) * ky
            except (ValueError, TypeError):
                continue
            stop_fits = False
            for i in range(0, len(projected) - 2, 2):
                ax, ay = projected[i], projected[i + 1]
                bx, by = projected[i + 2], projected[i + 3]
                if (
                    px < min(ax, bx) - tolerance
                    or px > max(ax, bx) + tolerance
                    or py < min(ay, by) - tolerance
                    or py > max(ay, by) + tolerance
                ):
                    continue
                dx = bx - ax
                dy = by - ay
                length_sq = dx * dx + dy * dy
                if length_sq:
                    ratio = ((px - ax) * dx + (py - ay) * dy) / length_sq
                    ratio = max(0.0, min(1.0, ratio))
                    nearest_x = ax + ratio * dx
                    nearest_y = ay + ratio * dy
                else:
                    nearest_x, nearest_y = ax, ay
                dist_x = px - nearest_x
                dist_y = py - nearest_y
                if dist_x * dist_x + dist_y * dist_y <= tolerance_sq:
                    stop_fits = True
                    break
            if not stop_fits:
                fits = False
                break

        self._fit_cache[fit_key] = fits
        return fits

    def select(self, matched_id, sub_route_uid, route_uid, direction, stop_ids):
        """Select the first fitting subroute, route, reversed, or static shape.

        @param matched_id GTFS route_id assigned to the patched trip.
        @param sub_route_uid TDX SubRouteUID for exact geometry lookup.
        @param route_uid TDX RouteUID for coarse geometry fallback.
        @param direction Direction of the patched trip.
        @param stop_ids Ordered stop identifiers used for fit validation.
        @returns The selected shape_id, or an empty string when none is usable.
        """
        direct_candidates = []
        reversed_candidates = []
        seen_keys = set()
        for key_uid in (sub_route_uid, route_uid):
            lookup_key = (key_uid, direction)
            if (
                key_uid
                and lookup_key in self.tdx_shapes
                and lookup_key not in seen_keys
            ):
                source = (
                    "shape_from_subroute"
                    if key_uid == sub_route_uid
                    else "shape_from_route_uid"
                )
                direct_candidates.append(
                    (
                        key_uid,
                        self.tdx_shapes[lookup_key],
                        source,
                        ("tdx", key_uid, direction, False),
                    )
                )
                seen_keys.add(lookup_key)

        opposite_direction = 1 - direction
        for key_uid in (sub_route_uid, route_uid):
            lookup_key = (key_uid, opposite_direction)
            if (
                key_uid
                and lookup_key in self.tdx_shapes
                and lookup_key not in seen_keys
            ):
                reversed_candidates.append(
                    (
                        key_uid,
                        self.tdx_shapes[lookup_key][::-1],
                        "shape_from_reversed",
                        ("tdx", key_uid, opposite_direction, True),
                    )
                )
                seen_keys.add(lookup_key)

        had_candidate = False
        for key_uid, points, counter, cache_key in (
            direct_candidates + reversed_candidates
        ):
            had_candidate = True
            if not self._fits(points, stop_ids, cache_key):
                continue
            reversed_suffix = "r" if counter == "shape_from_reversed" else ""
            shape_id = f"patched_shp_{key_uid}_{direction}{reversed_suffix}"
            self.new_shapes[shape_id] = points
            self.stats[counter] += 1
            return shape_id

        static_shape_id = self.route_shape_by_route.get(matched_id, "")
        static_points = self.static_shape_points.get(static_shape_id)
        if static_points is not None:
            had_candidate = True
            if self._fits(static_points, stop_ids, ("static", static_shape_id)):
                self.stats["shape_from_static"] += 1
                return static_shape_id

        if had_candidate:
            self.stats["shape_rejected_unfit"] += 1
        else:
            self.stats["missing_shape"] += 1
        return ""


def _resolve_sor_stops(route, sor_index):
    """Return ((key_uid, direction), stops) for the subroute's StopOfRoute entry,
    or (None, None) when neither the SubRouteUID nor RouteUID is indexed. The key
    is returned so callers can share a per-subroute profile_cache."""
    sub_route_uid = route.get("SubRouteUID")
    route_uid = route.get("RouteUID")
    direction = route.get("Direction", 0)
    for key_uid in (sub_route_uid, route_uid):
        if key_uid and (key_uid, direction) in sor_index:
            return (key_uid, direction), sor_index[(key_uid, direction)]
    return None, None


def _emit_frequency_trip(
    route,
    matched_id,
    stops,
    profile,
    new_trips,
    new_stop_times,
    new_frequencies,
    seen_trips,
    service_patterns,
    stats,
    shape_assigner,
):
    """Emit one headway template trip per weekday pattern for a freq-only
    subroute: stop_times from the travel profile, and one frequencies.txt row per
    (merged) window."""
    sub_route_uid = route.get("SubRouteUID")
    route_uid = route.get("RouteUID")
    route_id_tdx = route.get("RouteID")
    direction = route.get("Direction", 0)
    record_key = sub_route_uid or route_uid or route_id_tdx or "unknown"

    by_pattern = {}
    for fr in route.get("Frequencys") or []:
        service_day = fr.get("ServiceDay") or {}
        pattern = tuple(1 if service_day.get(k) else 0 for k in WEEKDAY_KEYS)
        if not any(pattern):
            stats["no_service_day"] += 1
            continue
        start_min = parse_hhmm(fr.get("StartTime"))
        end_min = parse_hhmm(fr.get("EndTime"))
        headway = _mean_headway_secs(fr.get("MinHeadwayMins"), fr.get("MaxHeadwayMins"))
        if start_min is None or end_min is None or headway is None or headway <= 0:
            continue
        if end_min <= start_min:
            end_min += 1440
        by_pattern.setdefault(pattern, []).append(
            {"start": start_min, "end": end_min, "headway": headway}
        )

    for pattern, windows in by_pattern.items():
        pattern_digits = "".join(str(d) for d in pattern)
        trip_id = f"freqpatched_{matched_id}_{record_key}_{pattern_digits}"
        if trip_id in seen_trips:
            stats["dup_trip"] += 1
            continue
        windows = _merge_frequency_windows(windows)
        if not windows:
            continue
        base_min = min(w["start"] for w in windows)

        stop_rows = []
        prev_t = None
        for i, s in enumerate(stops):
            t = base_min + round(profile[i] / 60)
            if prev_t is not None and t <= prev_t:
                t = prev_t + 1
            prev_t = t
            stop_rows.append(
                {
                    "trip_id": trip_id,
                    "arrival_time": fmt_gtfs_time(t),
                    "departure_time": fmt_gtfs_time(t),
                    "stop_id": s["StopUID"],
                    "stop_sequence": str(s["seq"]),
                }
            )

        shape_id = shape_assigner.select(
            matched_id,
            sub_route_uid,
            route_uid,
            direction,
            [row["stop_id"] for row in stop_rows],
        )

        seen_trips.add(trip_id)
        service_patterns.add(pattern)
        new_trips.append(
            {
                "route_id": matched_id,
                "service_id": service_id_for_pattern(pattern),
                "trip_id": trip_id,
                "shape_id": shape_id,
                "direction_id": str(direction),
            }
        )
        new_stop_times.extend(stop_rows)
        stats["freq_trips"] += 1
        for w in windows:
            new_frequencies.append(
                {
                    "trip_id": trip_id,
                    "start_time": fmt_gtfs_time(w["start"]),
                    "end_time": fmt_gtfs_time(w["end"]),
                    "headway_secs": w["headway"],
                    "exact_times": "0",
                }
            )
            stats["freq_windows"] += 1


def _generate_frequency_trips(
    freq_pending,
    sor_index,
    new_trips,
    new_stop_times,
    new_frequencies,
    seen_trips,
    service_patterns,
    stats,
    shape_assigner,
    profile_cache,
    fail_counter,
):
    """Second pass over the freq-only subroutes collected during the schedule
    loop: resolve StopOfRoute stops, compute Valhalla travel profiles with a
    bounded worker pool, then emit template trips + frequencies rows. Profiles are
    memoised in the shared profile_cache (keyed by (key_uid, direction)) so a
    subroute already profiled by the origin-only timetable fallback — or by an
    earlier freq subroute — is never recomputed. fail_counter is the shared
    Valhalla-fallback counter, folded into stats by the caller."""
    resolved = []
    for route, matched_id in freq_pending:
        key, stops = _resolve_sor_stops(route, sor_index)
        if not stops or len(stops) < 2:
            stats["freq_no_stops"] += 1
            continue
        resolved.append((route, matched_id, key, stops))

    if not resolved:
        return

    to_compute = {}
    for _, _, key, stops in resolved:
        if key not in profile_cache and key not in to_compute:
            to_compute[key] = [(s["lat"], s["lon"]) for s in stops]
    if to_compute:
        keys = list(to_compute)
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=VALHALLA_CONCURRENCY
        ) as ex:
            future_to_key = {
                ex.submit(build_travel_profile, to_compute[k], fail_counter): k
                for k in keys
            }
            for fut in concurrent.futures.as_completed(future_to_key):
                profile_cache[future_to_key[fut]] = fut.result()

    for route, matched_id, key, stops in resolved:
        _emit_frequency_trip(
            route,
            matched_id,
            stops,
            profile_cache[key],
            new_trips,
            new_stop_times,
            new_frequencies,
            seen_trips,
            service_patterns,
            stats,
            shape_assigner,
        )


def process_schedule_records_to_gtfs(
    records,
    new_trips,
    new_stop_times,
    new_frequencies,
    seen_trips,
    route_list,
    route_ids_set,
    service_patterns,
    stats,
    daily_profiles,
    shape_assigner,
    sor_index,
):
    # Shared across the origin-only timetable fallback and the frequency pass so a
    # subroute's Valhalla travel-time profile is computed at most once per build.
    profile_cache = {}
    valhalla_fail_counter = [0]
    freq_pending = []
    sorted_route_ids = sorted(route_ids_set)
    for route in records:
        route_uid = route.get("RouteUID")
        sub_route_uid = route.get("SubRouteUID")
        route_id_tdx = route.get("RouteID")
        name = route.get("RouteName", {}).get("Zh_tw")
        direction = route.get("Direction", 0)

        suffix = f"_{direction}"
        matched_id = None

        if sub_route_uid:
            exact = f"{sub_route_uid}{suffix}"
            if exact in route_ids_set:
                matched_id = exact
                stats["route_match_subroute_exact"] += 1

        if not matched_id and route_uid:
            exact = f"{route_uid}{suffix}"
            if exact in route_ids_set:
                matched_id = exact
                stats["route_match_route_exact"] += 1

        if not matched_id and sub_route_uid:
            candidates = [
                route_id
                for route_id in sorted_route_ids
                if route_id.startswith(sub_route_uid) and route_id.endswith(suffix)
            ]
            if candidates:
                matched_id = candidates[0]
                stats["route_match_prefix"] += 1
                if len(candidates) > 1:
                    stats["route_match_prefix_ambiguous"] += 1

        if not matched_id and route_uid:
            candidates = [
                route_id
                for route_id in sorted_route_ids
                if route_id.startswith(route_uid) and route_id.endswith(suffix)
            ]
            if candidates:
                matched_id = candidates[0]
                stats["route_match_prefix"] += 1
                if len(candidates) > 1:
                    stats["route_match_prefix_ambiguous"] += 1

        if not matched_id:
            for r in route_list:
                r_id = r["route_id"]
                r_short = r.get("route_short_name")
                if r_short in (name, route_id_tdx) and r_id.endswith(suffix):
                    matched_id = r_id
                    stats["route_match_name"] += 1
                    break

        if not matched_id:
            stats["route_unmatched"] += 1
            continue

        if route.get("Frequencys"):
            freq_pending.append((route, matched_id))

        timetables = route.get("Timetables") or route.get("TimeTables") or []
        if not timetables:
            # Headway-only subroutes carry no StopTimes; they become boardable via
            # the frequency template-trip pass (frequencies.txt) below.
            if route.get("Frequencys"):
                stats["freq_only"] += 1
            continue

        record_key = sub_route_uid or route_uid or route_id_tdx or "unknown"
        operator_no = route.get("OperatorNo") or ""

        for tt in timetables:
            service_day = tt.get("ServiceDay") or {}
            pattern = tuple(1 if service_day.get(k) else 0 for k in WEEKDAY_KEYS)
            if not any(pattern):
                stats["no_service_day"] += 1
                continue

            trip_id_raw = tt.get("TripID", "unknown")
            trip_id = f"patched_{matched_id}_{record_key}_{operator_no}_{trip_id_raw}"

            if trip_id in seen_trips:
                stats["dup_trip"] += 1
                continue

            entries = valid_stop_entries(tt)
            norm = normalize_stop_entries(entries) if len(entries) >= 2 else None
            if norm:
                stop_rows = [
                    {
                        "trip_id": trip_id,
                        "arrival_time": fmt_gtfs_time(arr),
                        "departure_time": fmt_gtfs_time(dep),
                        "stop_id": stop_id,
                        "stop_sequence": str(seq),
                    }
                    for stop_id, seq, arr, dep in norm
                ]
            else:
                # OTP rejects 0/1-stop trips; origin-only timetables are grafted
                # onto the daily travel-time profile when one exists, else onto a
                # StopOfRoute + Valhalla profile anchored at the origin departure.
                synth = synthesize_stop_rows(
                    trip_id, tt, (sub_route_uid, route_uid), direction, daily_profiles
                )
                if synth:
                    stop_rows = synth
                    stats["synthesized"] += 1
                else:
                    sor_synth = synthesize_stop_rows_from_sor(
                        trip_id,
                        tt,
                        (sub_route_uid, route_uid),
                        direction,
                        sor_index,
                        profile_cache,
                        valhalla_fail_counter,
                    )
                    if sor_synth:
                        stop_rows = sor_synth
                        stats["sor_synth"] += 1
                    else:
                        stats["short_trip"] += 1
                        continue

            seen_trips.add(trip_id)
            service_patterns.add(pattern)

            shape_id = shape_assigner.select(
                matched_id,
                sub_route_uid,
                route_uid,
                direction,
                [row["stop_id"] for row in stop_rows],
            )

            new_trips.append(
                {
                    "route_id": matched_id,
                    "service_id": service_id_for_pattern(pattern),
                    "trip_id": trip_id,
                    "shape_id": shape_id,
                    "direction_id": str(direction),
                }
            )
            new_stop_times.extend(stop_rows)

    _generate_frequency_trips(
        freq_pending,
        sor_index,
        new_trips,
        new_stop_times,
        new_frequencies,
        seen_trips,
        service_patterns,
        stats,
        shape_assigner,
        profile_cache,
        valhalla_fail_counter,
    )
    stats["freq_valhalla_fail"] += valhalla_fail_counter[0]


def patch_gtfs_zip(
    zip_path, schedule_records, daily_records, tdx_shapes, sor_records, start_date
):
    cal_start = start_date.strftime("%Y%m%d")
    cal_end = (start_date + datetime.timedelta(days=CALENDAR_VALID_DAYS)).strftime(
        "%Y%m%d"
    )

    # 1. Read existing routes to know which ones are bus (route_type == 3)
    route_types = {}
    route_list = []
    route_ids_set = set()

    trips_fields = ["route_id", "service_id", "trip_id", "direction_id"]
    st_fields = [
        "trip_id",
        "arrival_time",
        "departure_time",
        "stop_id",
        "stop_sequence",
    ]
    cd_fields = ["service_id", "date", "exception_type"]
    cal_fields = ["service_id"] + GTFS_WEEKDAY_COLS + ["start_date", "end_date"]

    temp_zip_path = zip_path + ".tmp"
    with zipfile.ZipFile(zip_path, "r") as zin:
        if "routes.txt" in zin.namelist():
            with zin.open("routes.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                for row in reader:
                    route_types[row["route_id"]] = row.get("route_type")
                    route_list.append(row)
                    route_ids_set.add(row["route_id"])

        # 2. Extract and preserve all non-bus (TRA, THSR, Metro) trips
        kept_trips = []
        kept_trip_ids = set()
        route_shape_by_route = {}
        if "trips.txt" in zin.namelist():
            with zin.open("trips.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                if reader.fieldnames:
                    trips_fields = reader.fieldnames
                for row in reader:
                    route_id = row["route_id"]
                    if route_types.get(route_id) != "3":
                        kept_trips.append(row)
                        kept_trip_ids.add(row["trip_id"])
                    elif row.get("shape_id") and route_id not in route_shape_by_route:
                        route_shape_by_route[route_id] = row["shape_id"]

        stop_coords = {}
        if "stops.txt" in zin.namelist():
            with zin.open("stops.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                for row in csv.DictReader(text):
                    try:
                        stop_coords[row["stop_id"]] = (
                            float(row["stop_lat"]),
                            float(row["stop_lon"]),
                        )
                    except (KeyError, TypeError, ValueError):
                        continue

        static_shape_points = {}
        required_static_shapes = set(route_shape_by_route.values())
        if required_static_shapes and "shapes.txt" in zin.namelist():
            with zin.open("shapes.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                for row in csv.DictReader(text):
                    shape_id = row.get("shape_id")
                    if shape_id not in required_static_shapes:
                        continue
                    try:
                        lat = float(row["shape_pt_lat"])
                        lon = float(row["shape_pt_lon"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    static_shape_points.setdefault(shape_id, array("d")).extend(
                        (lat, lon)
                    )

        # 3. Extract and preserve all non-bus stop times
        kept_stop_times = []
        if "stop_times.txt" in zin.namelist():
            with zin.open("stop_times.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                if reader.fieldnames:
                    st_fields = reader.fieldnames
                for row in reader:
                    if row["trip_id"] in kept_trip_ids:
                        kept_stop_times.append(row)

        # 4. Extract calendar dates, dropping the legacy single-day patch service
        kept_calendar_dates = []
        if "calendar_dates.txt" in zin.namelist():
            with zin.open("calendar_dates.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                if reader.fieldnames:
                    cd_fields = reader.fieldnames
                for row in reader:
                    if row.get("service_id") == "service_today":
                        continue
                    kept_calendar_dates.append(row)

        # 5. Extract weekly calendar, dropping rows from a previous patch run
        kept_calendar = []
        if "calendar.txt" in zin.namelist():
            with zin.open("calendar.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                if reader.fieldnames:
                    cal_fields = reader.fieldnames
                for row in reader:
                    if (row.get("service_id") or "").startswith("patched_"):
                        continue
                    kept_calendar.append(row)

    print(
        f"Preserved {len(kept_trips)} non-bus trips and {len(kept_stop_times)} non-bus stop times."
    )

    # 6. Parse schedule records into weekly-service trips & map shape geometries
    new_trips = []
    new_stop_times = []
    new_frequencies = []
    seen_trips = set()
    service_patterns = set()
    stats = {
        "freq_only": 0,
        "no_service_day": 0,
        "dup_trip": 0,
        "short_trip": 0,
        "synthesized": 0,
        "sor_synth": 0,
        "missing_shape": 0,
        "freq_trips": 0,
        "freq_windows": 0,
        "freq_valhalla_fail": 0,
        "freq_no_stops": 0,
        "route_match_subroute_exact": 0,
        "route_match_route_exact": 0,
        "route_match_prefix": 0,
        "route_match_prefix_ambiguous": 0,
        "route_match_name": 0,
        "route_unmatched": 0,
        "shape_from_subroute": 0,
        "shape_from_route_uid": 0,
        "shape_from_reversed": 0,
        "shape_from_static": 0,
        "shape_rejected_unfit": 0,
    }
    daily_profiles = build_daily_profiles(daily_records)
    sor_index = build_stop_of_route_index(sor_records)
    shape_assigner = ShapeAssigner(
        route_shape_by_route, tdx_shapes, static_shape_points, stop_coords, stats
    )

    process_schedule_records_to_gtfs(
        schedule_records,
        new_trips,
        new_stop_times,
        new_frequencies,
        seen_trips,
        route_list,
        route_ids_set,
        service_patterns,
        stats,
        daily_profiles,
        shape_assigner,
        sor_index,
    )
    new_shapes = shape_assigner.new_shapes

    print(
        f"Generated {len(new_trips)} new bus trips and {len(new_stop_times)} new stop times "
        f"({len(service_patterns)} weekly service patterns, valid {cal_start}–{cal_end}; "
        f"{stats['synthesized']} trips synthesized from daily travel-time profiles; "
        f"{stats['sor_synth']} origin-only trips synthesized from StopOfRoute travel-time profiles; "
        f"{stats['missing_shape']} trips without original or fetched shape)."
    )
    print(
        f"Frequency-based buses: {stats['freq_trips']} template trips, {stats['freq_windows']} windows "
        f"({stats['freq_valhalla_fail']} Valhalla-fallback profiles, "
        f"{stats['freq_no_stops']} skipped for missing StopOfRoute stops; "
        f"{stats['freq_only']} freq-only subroutes seen)."
    )
    print(
        f"Skipped: {stats['no_service_day']} timetables with no service day, "
        f"{stats['dup_trip']} duplicate trips, {stats['short_trip']} origin-only trips with "
        f"no daily profile and no usable StopOfRoute stops."
    )
    print(
        f"Route matching: {stats['route_match_subroute_exact']} subroute-exact, "
        f"{stats['route_match_route_exact']} route-exact, "
        f"{stats['route_match_prefix']} prefix "
        f"({stats['route_match_prefix_ambiguous']} ambiguous), "
        f"{stats['route_match_name']} by name, {stats['route_unmatched']} unmatched."
    )
    print(
        f"Shape assignment: {stats['shape_from_subroute']} subroute TDX, "
        f"{stats['shape_from_route_uid']} route TDX, "
        f"{stats['shape_from_reversed']} reversed, "
        f"{stats['shape_from_static']} inherited static, "
        f"{stats['shape_rejected_unfit']} rejected as unfit, "
        f"{stats['missing_shape']} with no candidate."
    )

    # 7. Combine kept non-bus + new bus data
    final_trips = kept_trips + new_trips
    final_stop_times = kept_stop_times + new_stop_times

    final_calendar = kept_calendar
    for pattern in sorted(service_patterns):
        row = {
            "service_id": service_id_for_pattern(pattern),
            "start_date": cal_start,
            "end_date": cal_end,
        }
        for col, active in zip(GTFS_WEEKDAY_COLS, pattern, strict=True):
            row[col] = str(active)
        final_calendar.append(row)

    # 8. Rewrite Zip
    with (
        zipfile.ZipFile(zip_path, "r") as zin,
        zipfile.ZipFile(temp_zip_path, "w", zipfile.ZIP_DEFLATED) as zout,
    ):
        # Copy all entries except those we overwrite
        for item in zin.infolist():
            if item.filename in (
                "trips.txt",
                "stop_times.txt",
                "calendar.txt",
                "calendar_dates.txt",
                "shapes.txt",
                "frequencies.txt",
            ):
                continue
            zout.writestr(item, zin.read(item.filename))

        # Write trips.txt
        trips_out = io.StringIO()
        trips_writer = csv.DictWriter(
            trips_out, fieldnames=trips_fields, extrasaction="ignore"
        )
        trips_writer.writeheader()
        trips_writer.writerows(final_trips)
        zout.writestr("trips.txt", trips_out.getvalue())

        # Write stop_times.txt
        st_out = io.StringIO()
        st_writer = csv.DictWriter(
            st_out, fieldnames=st_fields, extrasaction="ignore"
        )
        st_writer.writeheader()
        st_writer.writerows(final_stop_times)
        zout.writestr("stop_times.txt", st_out.getvalue())

        # Write calendar.txt
        cal_out = io.StringIO()
        cal_writer = csv.DictWriter(
            cal_out, fieldnames=cal_fields, extrasaction="ignore"
        )
        cal_writer.writeheader()
        cal_writer.writerows(final_calendar)
        zout.writestr("calendar.txt", cal_out.getvalue())

        # Write calendar_dates.txt
        cd_out = io.StringIO()
        cd_writer = csv.DictWriter(
            cd_out, fieldnames=cd_fields, extrasaction="ignore"
        )
        cd_writer.writeheader()
        cd_writer.writerows(kept_calendar_dates)
        zout.writestr("calendar_dates.txt", cd_out.getvalue())

        # Overwrite shapes.txt with memory-efficient streaming copy + append
        print(
            f"Writing shapes.txt (injecting {len(new_shapes)} new bus route shapes)..."
        )
        with zout.open("shapes.txt", "w") as f:
            wrapper = io.TextIOWrapper(f, encoding="utf-8")
            wrapper.write("shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n")

            # Copy existing shapes
            if "shapes.txt" in zin.namelist():
                with zin.open("shapes.txt") as in_f:
                    in_wrapper = io.TextIOWrapper(in_f, encoding="utf-8-sig")
                    in_wrapper.readline()  # skip original header
                    for line in in_wrapper:
                        wrapper.write(line.strip() + "\n")

            # Append new shapes
            for shape_id, points in sorted(new_shapes.items()):
                for seq, (lat, lon) in enumerate(points, start=1):
                    wrapper.write(f"{shape_id},{lat},{lon},{seq}\n")
            wrapper.flush()

        # Write frequencies.txt unconditionally: canonical header, any
        # upstream rows preserved, then the new bus template windows appended.
        # (inject-metro-gtfs.py later appends metro rows on top of this file.)
        print(
            f"Writing frequencies.txt (injecting {len(new_frequencies)} new bus frequency windows)..."
        )
        freq_fields = [
            "trip_id",
            "start_time",
            "end_time",
            "headway_secs",
            "exact_times",
        ]
        freq_out = io.StringIO()
        freq_writer = csv.DictWriter(
            freq_out, fieldnames=freq_fields, extrasaction="ignore"
        )
        freq_writer.writeheader()
        if "frequencies.txt" in zin.namelist():
            with zin.open("frequencies.txt") as in_f:
                in_text = io.TextIOWrapper(in_f, encoding="utf-8-sig")
                freq_writer.writerows(csv.DictReader(in_text))
        freq_writer.writerows(new_frequencies)
        zout.writestr("frequencies.txt", freq_out.getvalue())

    os.replace(temp_zip_path, zip_path)
    print("GTFS zip successfully patched with general timetables and shape geometry!")


def main():
    client_id = os.environ.get("TDX_CLIENT_ID")
    client_secret = os.environ.get("TDX_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("Missing TDX credentials in env.")
        sys.exit(1)

    if len(sys.argv) < 2:
        print("Usage: patch_gtfs.py <gtfs_feed.zip>")
        sys.exit(1)

    zip_path = sys.argv[1]
    if not os.path.exists(zip_path):
        print(f"GTFS zip file {zip_path} not found.")
        sys.exit(1)

    print("Step 1: Obtaining TDX Access Token...")
    token = get_tdx_token(client_id, client_secret)

    today = datetime.date.today()
    print(f"Calendar validity: {today} + {CALENDAR_VALID_DAYS} days")

    schedule_records = []
    daily_records = []
    shape_records = []
    sor_records = []
    city_summaries = []

    # 1. Fetch InterCity (公路客運) — v2 only; symmetric daily -> StopOfRoute fallback.
    print("\nStep 2: Fetching InterCity (公路客運) Data...")
    city_summaries.append(
        fetch_source(
            token,
            "InterCity",
            schedule_records,
            daily_records,
            shape_records,
            sor_records,
            schedule_fetcher=lambda: (
                fetch_paginated_api(token, V2_SCHED_INTERCITY, strict=True),
                "v2",
            ),
            daily_fetcher=lambda: fetch_intercity_daily(token),
            stop_of_route_fetcher=lambda: fetch_stop_of_route(
                token, V2_STOP_OF_ROUTE_INTERCITY
            ),
            shape_fetcher=lambda: fetch_shape(token, V2_SHAPE_INTERCITY),
        )
    )

    # 2. Fetch City Bus for all cities in CITIES (Schedule/Daily cascade v2 -> v3).
    print("\nStep 3: Fetching City Bus (各縣市市區公車) Data...")
    for city in CITIES:
        print(f"  Fetching {city} Data...")
        city_summaries.append(
            fetch_source(
                token,
                city,
                schedule_records,
                daily_records,
                shape_records,
                sor_records,
                schedule_fetcher=lambda c=city: fetch_city_schedule(token, c),
                daily_fetcher=lambda c=city: fetch_daily_timetable(token, c),
                stop_of_route_fetcher=lambda c=city: fetch_stop_of_route(
                    token, V2_STOP_OF_ROUTE(c)
                ),
                shape_fetcher=lambda c=city: fetch_shape(token, V2_SHAPE(c)),
            )
        )
        time.sleep(0.5)

    print(
        f"\nStep 4: Parsing Shape records (downloaded {len(shape_records)} shapes)..."
    )
    tdx_shapes = build_shape_index(shape_records)
    print(f"Parsed {len(tdx_shapes)} unique Route+Direction shape profiles.")

    print(
        f"\nStep 5: Patching {zip_path} with {len(schedule_records)} schedule records..."
    )
    patch_gtfs_zip(
        zip_path, schedule_records, daily_records, tdx_shapes, sor_records, today
    )


if __name__ == "__main__":
    main()
