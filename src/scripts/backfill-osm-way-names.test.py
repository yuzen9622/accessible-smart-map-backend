#!/usr/bin/env python3
"""Pure-function tests for the OSM way name backfill script."""

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("backfill-osm-way-names.py")
SPEC = importlib.util.spec_from_file_location("backfill_osm_way_names", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class NameForTagsTests(unittest.TestCase):
    def test_prefers_name_over_localized_variants(self):
        tags = {"name": "Roosevelt Rd", "name:zh": "羅斯福路", "name:zh-Hant": "羅斯福路"}
        self.assertEqual(MODULE.name_for_tags(tags), "Roosevelt Rd")

    def test_falls_back_to_name_zh_when_name_is_absent(self):
        tags = {"name:zh": "羅斯福路", "name:zh-Hant": "罗斯福路"}
        self.assertEqual(MODULE.name_for_tags(tags), "羅斯福路")

    def test_falls_back_to_name_zh_hant_when_only_it_is_present(self):
        tags = {"highway": "footway", "name:zh-Hant": "羅斯福路"}
        self.assertEqual(MODULE.name_for_tags(tags), "羅斯福路")

    def test_returns_none_when_no_name_tag_is_present(self):
        self.assertIsNone(MODULE.name_for_tags({"highway": "footway"}))

    def test_falls_through_a_blank_name_tag_to_the_next_preference(self):
        # A blank `name` is treated like an absent tag (matching the
        # codebase's existing `normalized_tag` convention) rather than
        # stopping the lookup and reporting the way as unnamed.
        self.assertEqual(
            MODULE.name_for_tags({"name": "   ", "name:zh": "羅斯福路"}),
            "羅斯福路",
        )


if __name__ == "__main__":
    unittest.main()
