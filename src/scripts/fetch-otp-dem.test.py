#!/usr/bin/env python3
"""Tests for picking and staging the national DTM used by the OTP build."""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).with_name("fetch-otp-dem.py")
SPEC = importlib.util.spec_from_file_location("fetch_otp_dem", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

RESOURCE_CSV = (
    "﻿圖資名稱,製作說明,圖資類型,圖資坐標系統,年度,連結網址\n"
    "分幅_臺北市20MDEM(2026),航空攝影測量,數值高程模型資料,TWD97(N、E、H),2026年,"
    "https://www.tgos.tw:443/MDE/VirtualDir_TC/Product/aaa/分幅_臺北市20MDEM(2026).zip\n"
    "不分幅_台灣20MDEM(2026),航空攝影測量,數值高程模型資料,TWD97(N、E、H),2026年,"
    "https://www.tgos.tw:443/MDE/VirtualDir_TC/Product/bbb/不分幅_全台20MDEM(2026).zip\n"
).encode("utf-8")


class WholeIslandUrlTests(unittest.TestCase):
    def test_picks_the_unsplit_product_and_percent_encodes_its_path(self):
        url = MODULE.whole_island_url(RESOURCE_CSV)
        self.assertEqual(
            url,
            "https://www.tgos.tw:443/MDE/VirtualDir_TC/Product/bbb/"
            "%E4%B8%8D%E5%88%86%E5%B9%85_%E5%85%A8%E5%8F%B020MDEM%282026%29.zip",
        )

    def test_rejects_a_csv_without_the_whole_island_product(self):
        only_tiles = b"\n".join(RESOURCE_CSV.split(b"\n")[:2])
        with self.assertRaises(SystemExit):
            MODULE.whole_island_url(only_tiles)


class CacheTests(unittest.TestCase):
    def test_skips_the_download_while_the_upstream_etag_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, MODULE.OUTPUT_NAME).write_bytes(b"tif")
            Path(tmp, MODULE.SOURCE_NAME).write_text(json.dumps({"etag": "e1"}))
            with mock.patch.object(MODULE, "curl", return_value=RESOURCE_CSV), \
                 mock.patch.object(MODULE, "upstream_etag", return_value="e1"), \
                 mock.patch.object(MODULE.subprocess, "run") as run, \
                 mock.patch.object(sys, "argv", ["fetch-otp-dem.py", tmp]):
                MODULE.main()
            run.assert_not_called()
            self.assertEqual(Path(tmp, MODULE.OUTPUT_NAME).read_bytes(), b"tif")

    def test_downloads_again_when_the_upstream_etag_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, MODULE.OUTPUT_NAME).write_bytes(b"tif")
            Path(tmp, MODULE.SOURCE_NAME).write_text(json.dumps({"etag": "old"}))
            with mock.patch.object(MODULE, "curl", return_value=RESOURCE_CSV), \
                 mock.patch.object(MODULE, "upstream_etag", return_value="new"), \
                 mock.patch.object(MODULE.subprocess, "run", side_effect=RuntimeError("download")) as run, \
                 mock.patch.object(sys, "argv", ["fetch-otp-dem.py", tmp]):
                with self.assertRaises(RuntimeError):
                    MODULE.main()
                run.assert_called_once()
            self.assertEqual(sorted(os.listdir(tmp)), sorted([MODULE.OUTPUT_NAME, MODULE.SOURCE_NAME]))

    def test_downloads_when_upstream_sends_no_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, MODULE.OUTPUT_NAME).write_bytes(b"tif")
            Path(tmp, MODULE.SOURCE_NAME).write_text(json.dumps({"etag": None}))
            with mock.patch.object(MODULE, "curl", return_value=RESOURCE_CSV), \
                 mock.patch.object(MODULE, "upstream_etag", return_value=None), \
                 mock.patch.object(MODULE.subprocess, "run", side_effect=RuntimeError("download")) as run, \
                 mock.patch.object(sys, "argv", ["fetch-otp-dem.py", tmp]):
                with self.assertRaises(RuntimeError):
                    MODULE.main()
                run.assert_called_once()


class UpstreamEtagTests(unittest.TestCase):
    def test_uses_only_the_final_response_after_redirects(self):
        heads = (b"HTTP/1.1 302 Found\r\nETag: hop\r\nLocation: x\r\n\r\n"
                 b"HTTP/2 200\r\nlast-modified: Wed, 30 Sep 2026\r\n\r\n")
        with mock.patch.object(MODULE, "curl", return_value=heads):
            self.assertEqual(MODULE.upstream_etag("u"), "None|Wed, 30 Sep 2026")

    def test_returns_none_without_any_fingerprint_header(self):
        with mock.patch.object(MODULE, "curl", return_value=b"HTTP/2 200\r\ncontent-length: 1\r\n\r\n"):
            self.assertIsNone(MODULE.upstream_etag("u"))


if __name__ == "__main__":
    unittest.main()
