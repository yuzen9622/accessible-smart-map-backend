"""Sparse data topology, separate from OTP routing and source authorization."""

import importlib.util
import sys
import unittest
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box

SPEC = importlib.util.spec_from_file_location(
    "otp_sidewalk_topology_product_test", Path(__file__).with_name("otp-sidewalk-topology.py")
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load sparse topology compiler")
API = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = API
SPEC.loader.exec_module(API)


class SparseTopologyTests(unittest.TestCase):
    def test_valid_source_is_not_excluded_by_its_tiny_wgs84_buffer(self):
        polygon = Polygon([
            (121.240517632241, 24.948515286223),
            (121.240522220751, 24.948522728143),
            (121.240525455677, 24.948530739231),
            (121.240522822787, 24.948516585155),
        ])
        before = polygon.wkb
        topology = API.build_polygon_topology(polygon)
        self.assertEqual(polygon.wkb, before)
        self.assertEqual(len(topology.edges), 1)
        self.assertTrue(polygon.covers(LineString(topology.edges[0].coordinates)))

    def test_boundary_rounding_preserves_the_original_midpoint_and_tolerance(self):
        polygon = Polygon([
            (121.028546107829, 24.812189222666),
            (121.028541906552, 24.812184069035),
            (121.028525367584, 24.812159336509),
            (121.028484150614, 24.812170415244),
            (121.028485764625, 24.812173229154),
        ])
        before = polygon.wkb
        topology = API.build_polygon_topology(polygon)
        self.assertEqual(polygon.wkb, before)
        self.assertEqual(len(topology.edges), 1)
        line = LineString(topology.edges[0].coordinates)
        self.assertIn((121.0285440071905, 24.8121866458505), line.coords)
        self.assertLessEqual(line.difference(polygon).length, 1e-13)
        for point in line.coords:
            self.assertLessEqual(Point(point).distance(polygon), 1e-13)

    def test_hole_and_outside_ports_are_not_joined(self):
        hole = box(121.0002, 25.0002, 121.0008, 25.0008)
        polygon = Polygon(
            box(121, 25, 121.001, 25.001).exterior.coords,
            [hole.exterior.coords],
        )
        topology = API.build_polygon_topology(polygon)
        for edge in topology.edges:
            self.assertTrue(LineString(edge.coordinates).disjoint(hole))
        for port in [(121.0005, 25.0005), (121.001000000001, 25.0005)]:
            with self.subTest(port=port), self.assertRaises(ValueError):
                API.build_polygon_topology(polygon, [port])

    def test_decision_nodes_exclude_internal_shape_points(self):
        polygon = box(121, 25, 121.001, 25.00002)
        topology = API.build_polygon_topology(polygon)
        self.assertEqual(len(topology.nodes), 2)
        self.assertEqual(len(topology.edges), 1)
        self.assertEqual(len(topology.edges[0].coordinates), 2)
        self.assertTrue(polygon.buffer(1e-13).covers(LineString(topology.edges[0].coordinates)))

    def test_densely_sampled_straight_sidewalk_has_no_triangle_zigzags(self):
        xs = [121 + index * 0.000002 for index in range(401)]
        polygon = Polygon([(x, 25) for x in xs] + [(x, 25.00001) for x in reversed(xs)])
        before = polygon.wkb
        topology = API.build_polygon_topology(polygon)
        self.assertEqual(polygon.wkb, before)
        self.assertEqual(len(topology.edges), 1)
        edge = topology.edges[0]
        self.assertEqual(len(edge.coordinates), 2)
        self.assertTrue(polygon.covers(LineString(edge.coordinates)))

    def test_shortening_preserves_a_concave_corridor_and_port_endpoints(self):
        polygon = Polygon([(0, 0), (4, 0), (4, 1), (1, 1), (1, 4), (0, 4)])
        ports = [(3.9, 0.5), (0.5, 3.9)]
        topology = API.build_polygon_topology(polygon, ports)
        self.assertFalse(polygon.covers(LineString(ports)))
        for port in ports:
            self.assertIn(port, topology.nodes.values())
            self.assertTrue(any(port in (edge.coordinates[0], edge.coordinates[-1]) for edge in topology.edges))
        for edge in topology.edges:
            self.assertTrue(polygon.covers(LineString(edge.coordinates)))

    def test_shortening_does_not_collapse_a_cycle_around_a_hole(self):
        hole = box(1, 1, 3, 3)
        polygon = Polygon(box(0, 0, 4, 4).exterior.coords, [hole.exterior.coords])
        topology = API.build_polygon_topology(polygon)
        self.assertEqual(len(topology.edges), 1)
        edge = topology.edges[0]
        self.assertEqual(edge.start, edge.end)
        self.assertEqual(edge.coordinates[0], edge.coordinates[-1])
        self.assertGreaterEqual(len(edge.coordinates), 4)
        line = LineString(edge.coordinates)
        self.assertTrue(line.disjoint(hole))
        self.assertTrue(polygon.covers(line))

    def test_an_interior_port_is_retained_after_chain_contraction(self):
        polygon = box(121, 25, 121.001, 25.00002)
        port = (121.0005, 25.00001)
        topology = API.build_polygon_topology(polygon, [port])
        self.assertIn(port, topology.nodes.values())
        self.assertTrue(any(port in [edge.coordinates[0], edge.coordinates[-1]] for edge in topology.edges))

    def test_duplicate_authorized_ports_do_not_duplicate_a_street_edge(self):
        polygon = box(121, 25, 121.001, 25.00002)
        port = (121, 25.00001)
        self.assertEqual(
            API.build_polygon_topology(polygon, [port]),
            API.build_polygon_topology(polygon, [port, port]),
        )


if __name__ == "__main__":
    unittest.main()
