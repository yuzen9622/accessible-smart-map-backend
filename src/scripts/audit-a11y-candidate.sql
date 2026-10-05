-- Read-only spatial checks for the isolated candidate database (version 1).
-- Requires the full graph, indoor injection, curb ramps and Wheelroute references.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout='120s';
SELECT json_build_object('check','attributes','outdoor_edges',count(*),
  'net_width_known',count(effective_width_m),'slope_known',count(slope_longitudinal),
  'weak_sidewalk_candidates',count(*) FILTER (WHERE attr_meta->'gov_sidewalk_source_id'->>'attributes_applied'='false'),
  'weak_with_government_width',count(*) FILTER (WHERE attr_meta->'gov_sidewalk_source_id'->>'attributes_applied'='false'
     AND attr_meta->'effective_width_m'->>'source'='gov_sidewalk'),
  'dem_shorter_than_40m',count(*) FILTER (WHERE attr_meta->'slope_longitudinal'->>'source'='dem' AND length_m<40))
FROM ped_edge WHERE version_id=1 AND source_ref LIKE 'osm:%';

SELECT json_build_object('check','wheelroute_reference','kind',kind,'features',count(*))
FROM wheelroute_reference GROUP BY kind ORDER BY kind;

WITH entrance_matches AS (
 SELECT n.node_id, n.station_id, min(ST_Distance(n.geom::geography,w.geom::geography)) AS distance_m
 FROM ped_node n LEFT JOIN wheelroute_reference w
   ON w.kind IN (3,7) AND ST_DWithin(n.geom,w.geom,0.0005)
 WHERE n.version_id=1 AND n.node_type=11 GROUP BY n.node_id,n.station_id
)
SELECT json_build_object('check','independent_entrance_geometry','entrances',count(*),
  'within_5m',count(*) FILTER(WHERE distance_m<=5),
  'within_15m',count(*) FILTER(WHERE distance_m<=15),
  'no_reference_within_50m',count(*) FILTER(WHERE distance_m IS NULL OR distance_m>50),
  'limitation','Distance corroboration is not a verified device identity or wall-free connection')
FROM entrance_matches;

WITH endpoint_evidence AS (
 SELECT e.edge_id,e.from_node,e.to_node,
   EXISTS(SELECT 1 FROM ped_ramp_node a JOIN ped_ramp_node b
      ON b.version_id=a.version_id AND b.objectid<>a.objectid
      WHERE a.version_id=e.version_id AND a.node_id=e.from_node AND b.node_id=e.to_node) distinct_ramps,
   EXISTS(SELECT 1 FROM ped_ramp_node a JOIN ped_ramp_node b
      ON b.version_id=a.version_id AND b.objectid=a.objectid
      WHERE a.version_id=e.version_id AND a.node_id=e.from_node AND b.node_id=e.to_node) shared_ramp
 FROM ped_edge e WHERE e.version_id=1 AND e.edge_type=3
)
SELECT json_build_object('check','crossing_endpoint_identity','crossing_edges',count(*),
 'distinct_ramp_points_available',count(*) FILTER(WHERE distinct_ramps),
 'same_point_only',count(*) FILTER(WHERE shared_ramp AND NOT distinct_ramps),
 'limitation','Distinct points still do not establish curb orientation; split crossing segments require review')
FROM endpoint_evidence;

WITH samples AS (
 SELECT e.edge_id::text,e.source_ref, e.length_m, e.slope_longitudinal,
  e.attr_meta->'gov_sidewalk_source_id' AS sidewalk_match,ST_AsGeoJSON(e.geom)::json AS geometry
 FROM ped_edge e WHERE version_id=1 AND source_ref LIKE 'osm:%'
 AND attr_meta->'gov_sidewalk_source_id'->>'attributes_applied'='false'
 ORDER BY e.edge_id LIMIT 40
)
SELECT json_build_object('check','review_samples','sampling','first 40 by edge ID; diagnostic, not random accuracy estimate',
 'features',json_agg(samples)) FROM samples;
COMMIT;
