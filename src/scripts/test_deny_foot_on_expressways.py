import importlib.util
import os
import tempfile
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


@unittest.skipIf(osmium is None, "pyosmium is not installed")
class PbfRewriteIntegrationTests(unittest.TestCase):
    def test_main_writes_pbf_when_stage_suffix_follows_osm_pbf(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            input_pbf = os.path.join(temp_dir, "input.osm.pbf")
            output_pbf = os.path.join(temp_dir, "input.osm.pbf.walk-safe")
            writer = osmium.SimpleWriter(osmium.io.File(input_pbf, "pbf"))
            writer.close()

            MODULE.main([input_pbf, output_pbf])

            self.assertTrue(os.path.isfile(output_pbf))

            class PbfProbeHandler(osmium.SimpleHandler):
                def node(self, node):
                    pass

            PbfProbeHandler().apply_file(osmium.io.File(output_pbf, "pbf"))


if __name__ == "__main__":
    unittest.main()
