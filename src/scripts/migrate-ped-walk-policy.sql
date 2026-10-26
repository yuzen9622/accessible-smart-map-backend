CREATE TABLE IF NOT EXISTS ped_walk_surface_cell (
  version_id BIGINT NOT NULL REFERENCES ped_graph_version(id) ON DELETE CASCADE,
  cell_id BIGINT NOT NULL CHECK (cell_id > 0),
  sidewalk_source_version_id BIGINT NOT NULL,
  source_id TEXT NOT NULL,
  geom GEOMETRY(Polygon, 4326) NOT NULL,
  grade JSONB NOT NULL,
  witness JSONB NOT NULL,
  PRIMARY KEY (version_id, cell_id),
  CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom))
);
CREATE INDEX IF NOT EXISTS ped_walk_surface_cell_geom_idx
  ON ped_walk_surface_cell USING GIST (geom);
CREATE INDEX IF NOT EXISTS ped_walk_surface_cell_source_idx
  ON ped_walk_surface_cell (version_id, sidewalk_source_version_id, source_id);
