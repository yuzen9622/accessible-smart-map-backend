-- Apply through `pnpm migrate:ped-graph-lifecycle`, which wraps this script in one transaction.
-- Legacy versions are normalized only when no lifecycle state is already active. The
-- chosen legacy baseline follows the prior loader order: newest built_at, then id.
DO $$
DECLARE
  active_count INTEGER;
  candidate_complete BOOLEAN;
  candidate_count INTEGER;
  candidate_id BIGINT;
  legacy_id BIGINT;
  lifecycle_status_column_existed BOOLEAN;
BEGIN
  IF to_regclass('ped_graph_version') IS NULL THEN
    RAISE EXCEPTION 'ped_graph_version must exist before lifecycle migration';
  END IF;
  IF to_regclass('ped_node') IS NULL OR to_regclass('ped_edge') IS NULL THEN
    RAISE EXCEPTION 'ped_node and ped_edge must exist before lifecycle migration';
  END IF;

  -- Record whether status existed before adding lifecycle columns. Only rows from
  -- that pre-lifecycle shape, or rows whose preexisting status was NULL, can use
  -- generated rows to recover completion; an explicit CANDIDATE remains unknown.
  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('ped_graph_version')
      AND attname = 'lifecycle_status'
      AND NOT attisdropped
  )
  INTO lifecycle_status_column_existed;

  -- Add nullable columns first so existing/default-less partial deployments can be
  -- normalized before defaults and NOT NULL constraints are applied.
  ALTER TABLE ped_graph_version
    ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;
  ALTER TABLE ped_graph_version
    ADD COLUMN IF NOT EXISTS indoor_injection_complete BOOLEAN;

  -- Preserve the old latest-loader behavior only for demonstrably legacy rows.
  -- An explicit CANDIDATE with NULL completion is made incomplete below even if
  -- it has generated rows, so it cannot be silently promoted by this migration.
  UPDATE ped_graph_version AS graph_version
  SET indoor_injection_complete = (
    EXISTS (
      SELECT 1
      FROM ped_node
      WHERE version_id = graph_version.id
        AND starts_with(source_ref, 'gtfs_pathways:')
    )
    AND EXISTS (
      SELECT 1
      FROM ped_edge
      WHERE version_id = graph_version.id
        AND starts_with(source_ref, 'gtfs_pathways:')
    )
  )
  WHERE graph_version.indoor_injection_complete IS NULL
    AND (
      NOT lifecycle_status_column_existed
      OR graph_version.lifecycle_status IS NULL
    );

  UPDATE ped_graph_version
  SET indoor_injection_complete = FALSE
  WHERE indoor_injection_complete IS NULL;

  UPDATE ped_graph_version
  SET lifecycle_status = NULL
  WHERE lifecycle_status IS NOT NULL
    AND btrim(lifecycle_status) = '';

  IF EXISTS (
    SELECT 1
    FROM ped_graph_version
    WHERE lifecycle_status IS NOT NULL
      AND lifecycle_status NOT IN ('CANDIDATE', 'ACTIVE', 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'ped_graph lifecycle status contains an unsupported value';
  END IF;

  SELECT count(*)
  INTO active_count
  FROM ped_graph_version
  WHERE lifecycle_status = 'ACTIVE';
  IF active_count > 1 THEN
    RAISE EXCEPTION 'ped_graph lifecycle requires at most one existing active version';
  END IF;

  IF active_count = 0 AND EXISTS (SELECT 1 FROM ped_graph_version) THEN
    SELECT id
    INTO legacy_id
    FROM ped_graph_version
    WHERE lifecycle_status IS NULL
    ORDER BY built_at DESC NULLS LAST, id DESC
    LIMIT 1;

    IF legacy_id IS NOT NULL THEN
      UPDATE ped_graph_version
      SET lifecycle_status = CASE WHEN id = legacy_id THEN 'ACTIVE' ELSE 'RETIRED' END
      WHERE lifecycle_status IS NULL;
    ELSE
      SELECT count(*), min(id)
      INTO candidate_count, candidate_id
      FROM ped_graph_version
      WHERE lifecycle_status = 'CANDIDATE';

      IF candidate_count <> 1 THEN
        RAISE EXCEPTION
          'ped_graph lifecycle has no active legacy baseline and cannot choose a candidate';
      END IF;

      SELECT indoor_injection_complete
      INTO candidate_complete
      FROM ped_graph_version
      WHERE id = candidate_id;
      IF candidate_complete IS NOT TRUE THEN
        RAISE EXCEPTION
          'ped_graph lifecycle will not auto-promote an incomplete candidate';
      END IF;

      UPDATE ped_graph_version
      SET lifecycle_status = 'ACTIVE'
      WHERE id = candidate_id;
    END IF;
  END IF;

  -- Remaining NULL statuses are legacy rows superseded by an existing or selected
  -- active baseline. They must not become candidates after this normalization.
  UPDATE ped_graph_version
  SET lifecycle_status = 'RETIRED'
  WHERE lifecycle_status IS NULL;

  IF EXISTS (SELECT 1 FROM ped_graph_version)
    AND (SELECT count(*) FROM ped_graph_version WHERE lifecycle_status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'ped_graph lifecycle requires exactly one active version';
  END IF;

  ALTER TABLE ped_graph_version
    ALTER COLUMN lifecycle_status SET DEFAULT 'CANDIDATE';
  ALTER TABLE ped_graph_version
    ALTER COLUMN indoor_injection_complete SET DEFAULT FALSE;
  ALTER TABLE ped_graph_version
    ALTER COLUMN lifecycle_status SET NOT NULL;
  ALTER TABLE ped_graph_version
    ALTER COLUMN indoor_injection_complete SET NOT NULL;
END;
$$;

-- This is a controlled lifecycle migration: replace definitions on the target
-- table instead of treating a same-named object as evidence of correctness.
ALTER TABLE ped_graph_version
  DROP CONSTRAINT IF EXISTS ped_graph_version_lifecycle_status_check;
ALTER TABLE ped_graph_version
  ADD CONSTRAINT ped_graph_version_lifecycle_status_check
  CHECK (lifecycle_status IN ('CANDIDATE', 'ACTIVE', 'RETIRED'));

DROP INDEX IF EXISTS ped_graph_version_one_active_idx;
CREATE UNIQUE INDEX ped_graph_version_one_active_idx
  ON ped_graph_version ((1))
  WHERE lifecycle_status = 'ACTIVE';
