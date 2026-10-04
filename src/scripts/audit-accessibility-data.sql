-- Read-only audit of the ACTIVE pedestrian graph. Requires the ramp import tables.
-- Run with psql -X -At -f; output is one JSON object per check.
-- Counts are directed edges, NOT physical sidewalks or real-world coverage.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT json_build_object(
  'check', 'active_graph', 'observed_at', now(),
  'version_id', id, 'built_at', built_at, 'nodes', node_count,
  'directed_edges', directed_edge_count, 'indoor_complete', indoor_injection_complete,
  'sidewalk_overlay', notes::json->'sidewalk_overlay',
  'entrance_distance', notes::json->'entrance_matching'->'distance_distribution_m',
  'entrance_matching', notes::json->'entrance_matching'->'primary_taipei_50m'
) FROM ped_graph_version WHERE lifecycle_status = 'ACTIVE';

WITH active AS (SELECT id FROM ped_graph_version WHERE lifecycle_status = 'ACTIVE')
SELECT json_build_object(
  'check', 'outdoor_attributes', 'directed_edges', count(*),
  'total_width_known', count(width_m), 'net_width_known', count(effective_width_m),
  'net_width_exceeds_total', count(*) FILTER (WHERE effective_width_m > width_m),
  'government_matched', count(*) FILTER (WHERE attr_meta ? 'gov_sidewalk_source_id'),
  'government_zero_overlap', count(*) FILTER (
    WHERE (attr_meta->'gov_sidewalk_source_id'->>'overlap_m')::numeric = 0),
  'slope_known', count(slope_longitudinal),
  'dem_shorter_than_40m', count(*) FILTER (
    WHERE attr_meta->'slope_longitudinal'->>'source' = 'dem'
      AND length_m < 40 AND slope_longitudinal IS NOT NULL),
  'dem_shorter_than_40m_over_12pct', count(*) FILTER (
    WHERE attr_meta->'slope_longitudinal'->>'source' = 'dem'
      AND length_m < 40 AND abs(slope_longitudinal) > 0.12)
) FROM ped_edge WHERE version_id IN (SELECT id FROM active) AND source_ref LIKE 'osm:%';

WITH active AS (SELECT id FROM ped_graph_version WHERE lifecycle_status = 'ACTIVE'),
ramps AS (SELECT DISTINCT node_id FROM ped_ramp_node WHERE version_id IN (SELECT id FROM active))
SELECT json_build_object(
  'check', 'crossing_ramps', 'directed_crossings', count(*),
  'both_ends_observed', count(*) FILTER (WHERE a.node_id IS NOT NULL AND b.node_id IS NOT NULL),
  'one_end_observed', count(*) FILTER (WHERE (a.node_id IS NOT NULL) <> (b.node_id IS NOT NULL)),
  'neither_end_observed', count(*) FILTER (WHERE a.node_id IS NULL AND b.node_id IS NULL)
) FROM ped_edge e
LEFT JOIN ramps a ON a.node_id = e.from_node
LEFT JOIN ramps b ON b.node_id = e.to_node
WHERE e.version_id IN (SELECT id FROM active) AND e.edge_type = 3;

SELECT json_build_object('check', 'ramp_source', 'points', count(*),
  'source_versions', array_agg(DISTINCT source_version)) FROM ped_ramp_point;

WITH active AS (SELECT id FROM ped_graph_version WHERE lifecycle_status = 'ACTIVE')
SELECT json_build_object('check', 'reverse_ramp_mapping', 'missing_reverse_rows', count(*))
FROM ped_ramp_edge m
JOIN ped_edge e ON m.edge_id = e.edge_id AND m.version_id = e.version_id
JOIN ped_edge r ON r.version_id = e.version_id
  AND r.from_node = e.to_node AND r.to_node = e.from_node
  AND r.source_ref = e.source_ref AND r.edge_type = e.edge_type
  AND ST_Equals(r.geom, e.geom)
WHERE m.version_id IN (SELECT id FROM active)
  AND NOT EXISTS (SELECT 1 FROM ped_ramp_edge mr
    WHERE mr.version_id = m.version_id AND mr.edge_id = r.edge_id AND mr.objectid = m.objectid);

WITH active AS (SELECT id FROM ped_graph_version WHERE lifecycle_status = 'ACTIVE')
SELECT json_build_object('check', 'indoor_attributes', 'edge_type', edge_type,
  'directed_edges', count(*), 'real_geometry', count(geom),
  'length_known', count(length_m), 'traversal_time_known', count(traversal_time_s))
FROM ped_edge WHERE version_id IN (SELECT id FROM active) AND source_ref LIKE 'gtfs_pathways:%'
GROUP BY edge_type ORDER BY edge_type;

COMMIT;
