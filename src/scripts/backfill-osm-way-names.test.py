#!/usr/bin/env python3
"""Pure-function tests for the OSM way name backfill script."""

import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

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


class BilingualWayNamesTests(unittest.TestCase):
    def test_preserves_canonical_and_records_explicit_english_only(self):
        tags = {"name": "羅斯福路", "name:en": " Roosevelt Road ", "name:zh": "別名"}
        self.assertEqual(MODULE.names_for_tags(tags), MODULE.WayName("羅斯福路", "Roosevelt Road"))
        self.assertEqual(tags["name:en"], " Roosevelt Road ")

    def test_no_inferred_english_or_new_canonical_from_english_only(self):
        self.assertEqual(MODULE.names_for_tags({"name": "Road"}), MODULE.WayName("Road", None))
        self.assertEqual(MODULE.names_for_tags({"name": "原名", "name:en": "  "}), MODULE.WayName("原名", None))
        self.assertIsNone(MODULE.names_for_tags({"name:en": "English only"}))

    def test_collector_only_reads_requested_ids_and_keeps_independent_translations(self):
        ways = [
            SimpleNamespace(id=1, tags={"name": "中正路", "name:en": "Zhongzheng Road"}),
            SimpleNamespace(id=2, tags={"name": "中正路", "name:en": "Jhongjheng Road"}),
            SimpleNamespace(id=3, tags={"name": "不在圖中", "name:en": "Not in graph"}),
        ]

        class Handler:
            def way(self, _way):
                raise NotImplementedError("The collector must implement the pyosmium callback")

            def apply_file(self, _path):
                for way in ways:
                    self.way(way)

        with patch.object(MODULE, "import_osmium", return_value=SimpleNamespace(SimpleHandler=Handler)):
            names = MODULE.collect_way_names(Path("fixture.pbf"), {1, 2})
        self.assertEqual(names, {
            1: MODULE.WayName("中正路", "Zhongzheng Road"),
            2: MODULE.WayName("中正路", "Jhongjheng Road"),
        })

    def test_idempotent_ddl_targets_only_lookup_table(self):
        cursor = Mock()
        MODULE.ensure_way_name_table(cursor)
        MODULE.ensure_way_name_table(cursor)
        self.assertEqual(cursor.execute.call_count, 4)
        sql = " ".join(call.args[0] for call in cursor.execute.call_args_list)
        self.assertIn("ADD COLUMN IF NOT EXISTS name_en TEXT", sql)
        self.assertNotIn("ped_edge", sql)
        self.assertNotIn("ped_graph_version", sql)

    def test_upsert_parameterizes_names_and_clears_obsolete_english(self):
        execute_values = Mock()
        extras = SimpleNamespace(execute_values=execute_values)
        with patch.dict(sys.modules, {"psycopg2": SimpleNamespace(extras=extras), "psycopg2.extras": extras}):
            cursor = Mock()
            MODULE.write_way_names(cursor, {17: MODULE.WayName("來源 ' 路", "Source ' Road")}, "2026-10-12")
            MODULE.write_way_names(cursor, {17: MODULE.WayName("來源 ' 路", None)}, "2026-10-13")
        first, second = execute_values.call_args_list
        self.assertEqual(first.args[2], [(17, "來源 ' 路", "Source ' Road", "2026-10-12")])
        self.assertEqual(second.args[2], [(17, "來源 ' 路", None, "2026-10-13")])
        self.assertIn("name_en = EXCLUDED.name_en", first.args[1])
        self.assertNotIn("Source ' Road", first.args[1])


if __name__ == "__main__":
    unittest.main()
