CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE ped_graph_version (
  id                  BIGSERIAL PRIMARY KEY,
  source_hash         TEXT        NOT NULL,
  built_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  bbox                GEOMETRY(Polygon, 4326),
  node_count          INTEGER     NOT NULL,
  directed_edge_count INTEGER     NOT NULL,
  notes               TEXT
);

CREATE TABLE ped_node (
  node_id          BIGINT  PRIMARY KEY,
  version_id       BIGINT  NOT NULL REFERENCES ped_graph_version(id) ON DELETE CASCADE,
  geom             GEOMETRY(Point, 4326),
  proxy_geom       GEOMETRY(Point, 4326) NOT NULL,
  station_id       TEXT,
  station_radius_m REAL,
  node_type        SMALLINT NOT NULL,
  kerb             SMALLINT,
  tactile_paving   BOOLEAN,
  traffic_signal   BOOLEAN,
  audible_signal   BOOLEAN,
  source_ref       TEXT,
  attr_meta        JSONB
);

CREATE TABLE ped_edge (
  edge_id           BIGINT  PRIMARY KEY,
  version_id        BIGINT  NOT NULL REFERENCES ped_graph_version(id) ON DELETE CASCADE,
  from_node         BIGINT  NOT NULL,
  to_node           BIGINT  NOT NULL,
  geom              GEOMETRY(LineString, 4326),
  length_m          REAL,
  edge_type         SMALLINT NOT NULL,
  slope_longitudinal REAL,
  slope_cross       REAL,
  surface           SMALLINT,
  smoothness        SMALLINT,
  width_m           REAL,
  effective_width_m REAL,
  wheelchair        SMALLINT,
  stair_count       SMALLINT,
  traversal_time_s  REAL,
  has_ramp          BOOLEAN NOT NULL DEFAULT FALSE,
  is_bidirectional  BOOLEAN NOT NULL DEFAULT TRUE,
  source_ref        TEXT,
  attr_meta         JSONB
);

CREATE INDEX ped_edge_geom_gix ON ped_edge USING GIST (geom);
CREATE INDEX ped_edge_from_idx ON ped_edge (version_id, from_node);
CREATE INDEX ped_edge_to_idx ON ped_edge (version_id, to_node);
CREATE INDEX ped_node_proxy_gix ON ped_node USING GIST (proxy_geom);
CREATE INDEX ped_node_station_idx ON ped_node (version_id, station_id);

COMMENT ON COLUMN ped_edge.edge_type IS '0=unknown; 1=sidewalk (highway=footway with footway=sidewalk); 2=footway (highway=footway excluding sidewalk and crossing); 3=crossing (highway=footway with footway=crossing, or highway=crossing); 4=path (highway=path and WP-2 fallback for an unmapped included highway); 5=pedestrian (highway=pedestrian); 6=steps (highway=steps); 7=living_street (highway=living_street); 8=track (highway=track); 9=road (highway=road); 10=residential (highway=residential); 11=service (highway=service); 12=unclassified (highway=unclassified); 13=tertiary (highway=tertiary); 14=tertiary_link (highway=tertiary_link); 15=secondary (highway=secondary); 16=secondary_link (highway=secondary_link); 17=primary (highway=primary); 18=primary_link (highway=primary_link); 19=osm_elevator (highway=elevator); 20=indoor_walkway (GTFS pathway_mode=1); 21=indoor_stairs (GTFS pathway_mode=2); 22=indoor_moving_walkway (GTFS pathway_mode=3); 23=indoor_escalator (GTFS pathway_mode=4); 24=indoor_elevator (GTFS pathway_mode=5); 25=indoor_fare_gate (GTFS pathway_mode=6); 26=indoor_exit_gate (GTFS pathway_mode=7); 255=other concrete unlisted value, whose exact raw value must be retained in attr_meta. Code 0 is only unknown and never an actual classified edge.';

COMMENT ON COLUMN ped_node.node_type IS '0=unknown; 1=osm_waypoint (ordinary retained OSM graph vertex); 2=intersection (eligible-way degree at least 2); 3=crossing (highway=crossing or crossing=*); 4=entrance (OSM entrance=*); 5=elevator (OSM highway=elevator); 6=stairs_end (endpoint of highway=steps); 7=indoor_generic (GTFS location_type=3); 8=indoor_station (GTFS location_type=1); 9=indoor_platform (GTFS location_type=0); 10=indoor_boarding_area (GTFS location_type=4); 11=indoor_entrance_exit (GTFS location_type=2); 12=indoor_outdoor_connector (generated graph join between an indoor entrance/exit and an outdoor edge); 255=other concrete unlisted role, whose exact raw role must be retained in attr_meta. When several roles apply, choose the first matching role in this precedence: 12,11,10,9,8,7,5,4,3,6,2,1. Code 0 is only unknown and never an actual classified node.';

COMMENT ON COLUMN ped_edge.surface IS '0=unknown; 1=asphalt; 2=concrete; 3=concrete_lanes (surface=concrete:lanes); 4=concrete_plates (surface=concrete:plates); 5=paving_stones; 6=sett; 7=unhewn_cobblestone; 8=cobblestone; 9=bricks; 10=tiles; 11=metal; 12=wood; 13=rubber; 14=plastic; 15=grass_paver; 16=compacted; 17=fine_gravel; 18=gravel; 19=pebblestone; 20=rock; 21=dirt; 22=earth; 23=ground; 24=mud; 25=sand; 26=grass; 27=clay; 28=unpaved; 29=paved; 30=soil; 31=chippings; 32=shells; 33=artificial_turf; 34=tartan; 35=ice; 36=snow; 37=woodchips; 38=mulch; 39=leaves; 255=other concrete unlisted surface value, whose exact raw value must be retained in attr_meta. Code 0 is only unknown.';

COMMENT ON COLUMN ped_edge.smoothness IS '0=unknown; 1=excellent; 2=good; 3=intermediate; 4=bad; 5=very_bad; 6=horrible; 7=very_horrible; 8=impassable; 255=other concrete unlisted smoothness value, whose exact raw value must be retained in attr_meta. Code 0 is only unknown.';

COMMENT ON COLUMN ped_edge.wheelchair IS '0=unknown; 1=yes; 2=designated; 3=limited; 4=no; 255=other concrete unlisted wheelchair value, whose exact raw value must be retained in attr_meta. Code 0 is only unknown.';

COMMENT ON COLUMN ped_node.kerb IS '0=unknown; 1=flush; 2=lowered; 3=raised; 4=rolled; 5=sloped; 6=yes (kerb present but type unspecified); 7=no (no kerb); 8=at_grade; 9=dropped; 10=regular; 11=normal; 12=low; 13=none; 14=flush_and_lowered; 15=lowered_and_sloped; 255=other concrete unlisted kerb value, whose exact raw value must be retained in attr_meta. Code 0 is only unknown.';
