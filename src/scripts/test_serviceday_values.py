#!/usr/bin/env python3
"""Offline tests and an opt-in live diagnostic for TDX ``ServiceDay`` data.

The live diagnostic is retained for manual investigation and is available with
``--live``. The default command is deterministic so it can run in CI without
TDX credentials or network access.
"""

import contextlib
import io
import json
import os
import sys
import unittest
import urllib.parse
import urllib.request
from unittest import mock


def get_tdx_token(client_id, client_secret):
    url = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))["access_token"]


def main():
    client_id = os.environ.get("TDX_CLIENT_ID")
    client_secret = os.environ.get("TDX_CLIENT_SECRET")
    token = get_tdx_token(client_id, client_secret)

    url = "https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/City/Taipei?%24top=10&%24format=JSON"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        data = json.loads(res.read().decode("utf-8"))

    print(f"=== 檢查 Taipei Schedule API ServiceDay 原始形態與型別 (共 {len(data)} 筆) ===\n")
    for r in data[:5]:
        route_name = r.get("RouteName", {}).get("Zh_tw")
        timetables = r.get("Timetables") or r.get("TimeTables") or []
        print(f"📍 路線: {route_name} | Timetables: {len(timetables)} 筆")
        if timetables:
            sample_tt = timetables[0]
            sd = sample_tt.get("ServiceDay", {})
            print("   - ServiceDay 原始 JSON 內容:", json.dumps(sd, ensure_ascii=False))
            print("   - 型別細節:")
            for k, v in sd.items():
                print(f"      {k}: {repr(v)} (type: {type(v).__name__})")
        print()


def _json_response(payload):
    response = mock.MagicMock()
    response.__enter__.return_value = response
    response.__exit__.return_value = False
    response.read.return_value = json.dumps(payload).encode("utf-8")
    return response


class ServiceDayValueTests(unittest.TestCase):
    def test_get_tdx_token_decodes_access_token(self):
        with mock.patch(
            "urllib.request.urlopen",
            return_value=_json_response({"access_token": "test-token"}),
        ) as urlopen:
            self.assertEqual(get_tdx_token("client", "secret"), "test-token")
        self.assertEqual(urlopen.call_count, 1)

    def test_main_reports_service_day_values_without_network(self):
        schedule = [{
            "RouteName": {"Zh_tw": "測試路線"},
            "Timetables": [{"ServiceDay": {"Monday": 1, "Sunday": False}}],
        }]
        responses = [
            _json_response({"access_token": "test-token"}),
            _json_response(schedule),
        ]
        output = io.StringIO()
        with mock.patch.dict(
            os.environ,
            {"TDX_CLIENT_ID": "client", "TDX_CLIENT_SECRET": "secret"},
            clear=False,
        ), mock.patch("urllib.request.urlopen", side_effect=responses), contextlib.redirect_stdout(output):
            main()

        rendered = output.getvalue()
        self.assertIn("測試路線", rendered)
        self.assertIn("Monday: 1 (type: int)", rendered)
        self.assertIn("Sunday: False (type: bool)", rendered)


if __name__ == "__main__":
    if "--live" in sys.argv:
        sys.argv.remove("--live")
        main()
    else:
        unittest.main(verbosity=2)
