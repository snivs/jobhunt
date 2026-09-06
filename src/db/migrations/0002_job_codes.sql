-- Short human identifiers for jobs: VAC-<discovery run>.<job id>, e.g. VAC-2.119.
-- discovered_run_id is the search run whose discovery stage first stored the job (0 when unknown).
ALTER TABLE jobs ADD COLUMN discovered_run_id INTEGER REFERENCES search_runs(id);
ALTER TABLE jobs ADD COLUMN code TEXT;

-- Backfill: the run whose window contains discovered_at (latest started run that had begun by then).
UPDATE jobs SET discovered_run_id = (
  SELECT r.id FROM search_runs r
  WHERE r.started_at <= jobs.discovered_at AND (r.completed_at IS NULL OR r.completed_at >= jobs.discovered_at)
  ORDER BY r.started_at DESC LIMIT 1
) WHERE discovered_run_id IS NULL;

UPDATE jobs SET code = 'VAC-' || COALESCE(discovered_run_id, 0) || '.' || id WHERE code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_code ON jobs(code);
