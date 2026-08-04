import importlib.util
import os
import tempfile
import types
import unittest


SCRIPT = os.path.join(os.path.dirname(__file__), "deny-foot-on-expressways.py")
SPEC = importlib.util.spec_from_file_location("deny_foot_on_expressways", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

try:
    import osmium
except ImportError:
    osmium = None


class RewriteTagsTests(unittest.TestCase):
    def test_denies_untagged_foot_on_bridge_expressway(self):
        tags, applied = MODULE.rewritten_tags(
            {"highway": "trunk", "bridge": "yes", "name": "X"}
        )
        self.assertEqual(tags["foot"], "no")
        self.assertEqual(applied, ["expressway"])

    def test_denies_untagged_foot_when_sidewalk_is_no(self):
        tags, applied = MODULE.rewritten_tags(
            {"highway": "trunk_link", "sidewalk": "no"}
        )
        self.assertEqual(tags["foot"], "no")
        self.assertEqual(applied, ["expressway"])

    def test_preserves_explicit_foot_tag(self):
        tags, applied = MODULE.rewritten_tags(
            {"highway": "trunk", "bridge": "yes", "foot": "yes"}
        )
        self.assertEqual(tags["foot"], "yes")
        self.assertEqual(applied, [])

    def test_preserves_city_trunk_without_bridge_or_sidewalk_no(self):
        tags, applied = MODULE.rewritten_tags({"highway": "trunk"})
        self.assertNotIn("foot", tags)
        self.assertEqual(applied, [])

    def test_denies_wheelchair_on_steps_without_ramp_exception(self):
        tags, applied = MODULE.rewritten_tags(
            {"highway": "steps", "incline": "up"}
        )
        self.assertEqual(tags["wheelchair"], "no")
        self.assertEqual(applied, ["steps"])

    def test_preserves_wheelchair_accessible_steps(self):
        for source in (
            {"highway": "steps", "wheelchair": "yes"},
            {"highway": "steps", "ramp:wheelchair": "yes"},
        ):
            with self.subTest(source=source):
                tags, applied = MODULE.rewritten_tags(source)
                self.assertNotEqual(tags.get("wheelchair"), "no")
                self.assertEqual(applied, [])


class WriterCompatibilityTests(unittest.TestCase):
    def test_open_writer_falls_back_to_legacy_string_overload(self):
        file_value = object()
        sentinel = object()
        calls = []

        def simple_writer(value):
            calls.append(value)
            if not isinstance(value, str):
                raise TypeError("legacy overload only accepts paths")
            return sentinel

        osmium_stub = types.SimpleNamespace(
            io=types.SimpleNamespace(File=lambda path, format: file_value),
            SimpleWriter=simple_writer,
        )

        self.assertIs(
            MODULE.open_writer(osmium_stub, "/tmp/x.osm.pbf"), sentinel
        )
        self.assertEqual(calls, [file_value, "/tmp/x.osm.pbf"])

    def test_open_writer_prefers_modern_file_overload(self):
        file_value = object()
        sentinel = object()
        calls = []

        def simple_writer(value):
            calls.append(value)
            return sentinel

        osmium_stub = types.SimpleNamespace(
            io=types.SimpleNamespace(File=lambda path, format: file_value),
            SimpleWriter=simple_writer,
        )

        self.assertIs(
            MODULE.open_writer(osmium_stub, "/tmp/x.osm.pbf"), sentinel
        )
        self.assertEqual(calls, [file_value])

    def test_open_writer_rejects_legacy_output_without_pbf_suffix(self):
        file_value = object()
        calls = []

        def simple_writer(value):
            calls.append(value)
            if not isinstance(value, str):
                raise TypeError("legacy overload only accepts paths")
            return object()

        osmium_stub = types.SimpleNamespace(
            io=types.SimpleNamespace(File=lambda path, format: file_value),
            SimpleWriter=simple_writer,
        )

        with self.assertRaisesRegex(SystemExit, r"\.osm\.pbf"):
            MODULE.open_writer(osmium_stub, "/tmp/x.walk-safe")
        self.assertEqual(calls, [file_value])

    def test_with_tags_falls_back_to_legacy_mutable_way(self):
        way = object()
        tags = {"foot": "no"}
        sentinel = object()
        calls = []

        def mutable_way(source, *, tags):
            calls.append((source, tags))
            return sentinel

        osmium_stub = types.SimpleNamespace(
            osm=types.SimpleNamespace(
                mutable=types.SimpleNamespace(Way=mutable_way)
            )
        )

        self.assertIs(MODULE.with_tags(osmium_stub, way, tags), sentinel)
        self.assertEqual(calls, [(way, tags)])

    def test_with_tags_uses_replace_when_available(self):
        tags = {"wheelchair": "no"}
        sentinel = object()

        class ModernWay:
            def __init__(self):
                self.calls = []

            def replace(self, *, tags):
                self.calls.append(tags)
                return sentinel

        way = ModernWay()

        self.assertIs(MODULE.with_tags(None, way, tags), sentinel)
        self.assertEqual(way.calls, [tags])


@unittest.skipIf(osmium is None, "pyosmium is not installed")
class PbfRewriteIntegrationTests(unittest.TestCase):
    def test_main_writes_pbf_for_production_shaped_output_name(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            input_pbf = os.path.join(temp_dir, "input.osm.pbf")
            output_pbf = os.path.join(temp_dir, "input.walk-safe.osm.pbf")
            writer = MODULE.open_writer(osmium, input_pbf)
            writer.close()

            MODULE.main([input_pbf, output_pbf])

            self.assertTrue(os.path.isfile(output_pbf))

            class PbfProbeHandler(osmium.SimpleHandler):
                def node(self, node):
                    pass

            PbfProbeHandler().apply_file(output_pbf)


if __name__ == "__main__":
    unittest.main()
