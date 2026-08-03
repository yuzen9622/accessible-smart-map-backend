#!/usr/bin/env python3
"""Gate a rebuilt OTP graph on the approved walking quality fixtures."""

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date


BAD_STREET = re.compile(r"高架|匝道|快速道路|高速公路")
CASES = [
    ("松菸→市民大道北側", (25.0418, 121.5654), (25.0455, 121.5620)),
    ("圓山→行天宮", (25.0714, 121.5205), (25.0632, 121.5335)),
    ("圓山→台北車站", (25.0714, 121.5205), (25.0478, 121.5170)),
    ("台北101→市政府", (25.0339, 121.5645), (25.0377, 121.5637)),
    ("台北車站→西門町", (25.0478, 121.5170), (25.0421, 121.5079)),
    ("大安森林→中正紀念堂", (25.0330, 121.5350), (25.0357, 121.5219)),
]
STAIRS_WAY_IDS = (272274658, 381447794)


QUERY = """
query WalkQuality($fromLat: Float!, $fromLon: Float!, $toLat: Float!, $toLon: Float!, $date: String!, $wheelchair: Boolean!) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: "10:00"
    wheelchair: $wheelchair
    numItineraries: 1
    transportModes: [{ mode: WALK }]
    locale: "zh-TW"
  ) {
    itineraries {
      duration
      walkDistance
      legs { steps { streetName } }
    }
  }
}
"""


def post_json(url, body, timeout=60):
    """POST JSON and decode the response."""
    request = urllib.request.Request(
        url,
        json.dumps(body).encode(),
        {"Content-Type": "application/json", "User-Agent": "taipei-a11y-walk-audit/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def otp_walk(endpoint, origin, destination, wheelchair):
    """Fetch the first OTP walk itinerary for one coordinate pair."""
    payload = post_json(
        endpoint,
        {
            "query": QUERY,
            "variables": {
                "fromLat": origin[0],
                "fromLon": origin[1],
                "toLat": destination[0],
                "toLon": destination[1],
                "date": date.today().isoformat(),
                "wheelchair": wheelchair,
            },
        },
    )
    if payload.get("errors"):
        raise RuntimeError(payload["errors"][0].get("message", "OTP GraphQL error"))
    return (((payload.get("data") or {}).get("plan") or {}).get("itineraries") or [])


def stairs_endpoints():
    """Resolve the two empirical stairs fixtures from their stable OSM way IDs."""
    query = "[out:json][timeout:90];way(id:" + ",".join(map(str, STAIRS_WAY_IDS)) + ");out geom tags;"
    body = urllib.parse.urlencode({"data": query}).encode()
    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        body,
        {"User-Agent": "taipei-a11y-walk-audit/1.0"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        elements = json.load(response).get("elements", [])
    found = []
    for way in elements:
        geometry = way.get("geometry") or []
        if len(geometry) < 2:
            continue
        found.append(
            (
                f"steps way {way['id']}",
                (geometry[0]["lat"], geometry[0]["lon"]),
                (geometry[-1]["lat"], geometry[-1]["lon"]),
            )
        )
    if len(found) != len(STAIRS_WAY_IDS):
        raise RuntimeError("Overpass did not return both empirical stairs fixtures")
    return found


def bad_streets(itinerary):
    """Return unique unsafe street-name matches from one itinerary."""
    names = []
    for leg in itinerary.get("legs") or []:
        for step in leg.get("steps") or []:
            name = step.get("streetName") or ""
            if BAD_STREET.search(name) and name not in names:
                names.append(name)
    return names


def main(argv=None):
    """Run all normal and wheelchair graph gates and return a shell exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--otp-url",
        default="http://127.0.0.1:18080/otp/routers/default/index/graphql",
    )
    args = parser.parse_args(argv)
    failures = []
    for name, origin, destination in CASES:
        for wheelchair in (False, True):
            itineraries = otp_walk(args.otp_url, origin, destination, wheelchair)
            if not itineraries:
                failures.append(f"{name} wheelchair={wheelchair}: no itinerary")
                continue
            itinerary = itineraries[0]
            hits = bad_streets(itinerary)
            if hits:
                failures.append(
                    f"{name} wheelchair={wheelchair}: unsafe street names {hits}; inspect false positives manually"
                )
            print(
                f"PASS {name} wheelchair={wheelchair} "
                f"distance={round(itinerary['walkDistance'])}m "
                f"duration={round(itinerary['duration'] / 60)}min"
            )
    for name, origin, destination in stairs_endpoints():
        itineraries = otp_walk(args.otp_url, origin, destination, True)
        if not itineraries:
            print(f"PASS {name} wheelchair=True explicitly excluded")
            continue
        steps = [
            step
            for leg in itineraries[0].get("legs") or []
            for step in leg.get("steps") or []
        ]
        if any((step.get("streetName") or "").lower() == "steps" for step in steps):
            failures.append(f"{name} wheelchair=True: route still traverses steps")
        else:
            print(f"PASS {name} wheelchair=True bypasses steps")
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    print("PASS all OTP walking quality gates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
