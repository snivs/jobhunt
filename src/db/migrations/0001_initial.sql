-- Autonomous Job Hunter - initial schema
-- Conventions: timestamps are ISO-8601 UTC strings; *_json columns hold JSON text.
-- History is never destroyed: rows are soft-updated, and versions/events tables are append-only.

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT,
  automation_policy TEXT NOT NULL DEFAULT 'discover_only'
    CHECK (automation_policy IN ('discover_only', 'apply_allowed', 'blocked')),
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  website TEXT,
  domain TEXT,
  industry TEXT,
  size TEXT,
  headquarters TEXT,
  description TEXT,
  vault_note TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  external_id TEXT,
  url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id),
  company_name TEXT,
  location TEXT,
  country TEXT,
  work_mode TEXT NOT NULL DEFAULT 'unknown'
    CHECK (work_mode IN ('remote', 'hybrid', 'onsite', 'unknown')),
  remote_scope TEXT,
  description TEXT,
  description_hash TEXT,
  content_hash TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  posted_at TEXT,
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'closed', 'filled', 'unknown')),
  seniority TEXT NOT NULL DEFAULT 'unknown'
    CHECK (seniority IN ('intern', 'junior', 'mid', 'senior', 'staff', 'lead', 'principal', 'manager', 'director', 'executive', 'unknown')),
  employment_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'freelance', 'internship', 'unknown')),
  language TEXT,
  raw_metadata_json TEXT,
  duplicate_of_job_id INTEGER REFERENCES jobs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_source_external ON jobs(source_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_jobs_dedup_key ON jobs(dedup_key);
CREATE INDEX IF NOT EXISTS ix_jobs_canonical_url ON jobs(canonical_url);
CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS ix_jobs_company ON jobs(company_id);
CREATE INDEX IF NOT EXISTS ix_jobs_discovered ON jobs(discovered_at);

-- Append-only history of job content changes (change detection via content_hash)
CREATE TABLE IF NOT EXISTS job_versions (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  content_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_job_versions_job ON job_versions(job_id);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('language', 'framework', 'library', 'database', 'cloud', 'devops', 'infrastructure', 'architecture', 'practice', 'ai', 'tool', 'domain', 'soft', 'security', 'data', 'mobile', 'other')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_aliases (
  id INTEGER PRIMARY KEY,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS job_skills (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  mention_type TEXT NOT NULL
    CHECK (mention_type IN ('explicit_required', 'explicit_preferred', 'mentioned', 'expected')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence TEXT,
  raw_form TEXT,
  years_required REAL,
  extracted_by TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, skill_id, mention_type)
);
CREATE INDEX IF NOT EXISTS ix_job_skills_skill ON job_skills(skill_id);

CREATE TABLE IF NOT EXISTS compensation_observations (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id),
  company_id INTEGER REFERENCES companies(id),
  observation_type TEXT NOT NULL CHECK (observation_type IN ('explicit', 'expected')),
  min_amount REAL,
  max_amount REAL,
  currency TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('hour', 'day', 'week', 'month', 'year')),
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  methodology TEXT,
  evidence TEXT,
  equity TEXT,
  bonus TEXT,
  role TEXT,
  seniority TEXT,
  location TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_comp_job ON compensation_observations(job_id);
CREATE INDEX IF NOT EXISTS ix_comp_type ON compensation_observations(observation_type, observed_at);

CREATE TABLE IF NOT EXISTS candidate_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  full_name TEXT,
  headline TEXT,
  current_title TEXT,
  seniority TEXT,
  years_experience REAL,
  years_leadership REAL,
  location TEXT,
  country TEXT,
  timezone TEXT,
  languages_json TEXT NOT NULL DEFAULT '[]',
  work_authorization_json TEXT NOT NULL DEFAULT '[]',
  vault_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  interview_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_skills (
  id INTEGER PRIMARY KEY,
  skill_id INTEGER NOT NULL UNIQUE REFERENCES skills(id),
  level TEXT NOT NULL CHECK (level IN ('expert', 'advanced', 'intermediate', 'basic', 'learning')),
  years REAL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  willing_to_learn INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Flexible preference store. is_hard_constraint marks preferences that reject a job outright.
CREATE TABLE IF NOT EXISTS candidate_preferences (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL,
  is_hard_constraint INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'interview',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_matches (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  profile_version INTEGER NOT NULL,
  scoring_version TEXT NOT NULL,
  overall_score REAL NOT NULL,
  eligible INTEGER NOT NULL,
  factors_json TEXT NOT NULL,
  strengths_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  hard_constraint_failures_json TEXT NOT NULL DEFAULT '[]',
  missing_information_json TEXT NOT NULL DEFAULT '[]',
  analysis_json TEXT,
  run_id INTEGER,
  scored_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, profile_version, scoring_version)
);
CREATE INDEX IF NOT EXISTS ix_job_matches_score ON job_matches(overall_score DESC);

CREATE TABLE IF NOT EXISTS search_runs (
  id INTEGER PRIMARY KEY,
  run_key TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'loop', 'recovery')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'skipped', 'interrupted')),
  current_stage TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}',
  errors_json TEXT NOT NULL DEFAULT '[]',
  report_path TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_source_results (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES search_runs(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'blocked', 'skipped', 'partial')),
  jobs_found INTEGER NOT NULL DEFAULT 0,
  jobs_new INTEGER NOT NULL DEFAULT 0,
  jobs_updated INTEGER NOT NULL DEFAULT 0,
  jobs_deduplicated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, source_id)
);

CREATE TABLE IF NOT EXISTS run_errors (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES search_runs(id),
  source TEXT,
  operation TEXT NOT NULL,
  error TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  recoverable INTEGER NOT NULL DEFAULT 1,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  run_id INTEGER REFERENCES search_runs(id),
  match_id INTEGER REFERENCES job_matches(id),
  status TEXT NOT NULL
    CHECK (status IN ('DISCOVERED', 'MATCHED', 'SELECTED', 'PREPARING', 'READY', 'SUBMITTING', 'SUBMITTED',
                      'REJECTED', 'SKIPPED', 'REQUIRES_USER_INPUT', 'FAILED', 'BLOCKED', 'EXPIRED', 'WITHDRAWN',
                      'RESPONSE_RECEIVED', 'INTERVIEW', 'OFFER', 'ACCEPTED', 'DECLINED', 'NO_RESPONSE')),
  method TEXT CHECK (method IS NULL OR method IN ('api', 'form', 'email', 'manual')),
  resume_variant TEXT,
  cover_letter_path TEXT,
  answers_json TEXT,
  requires_user_input_json TEXT,
  submitted_at TEXT,
  external_reference TEXT,
  idempotency_key TEXT UNIQUE,
  failure_reason TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS ix_applications_source_run ON applications(source_id, run_id);

-- Append-only transition log. Never updated or deleted.
CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details_json TEXT,
  run_id INTEGER,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_application_events_app ON application_events(application_id);

CREATE TABLE IF NOT EXISTS company_research (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  run_id INTEGER REFERENCES search_runs(id),
  summary TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  vault_note TEXT,
  researched_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_company_research_company ON company_research(company_id, researched_at);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY,
  snapshot_date TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skills', 'compensation', 'sources', 'funnel', 'summary')),
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  data_json TEXT NOT NULL,
  run_id INTEGER REFERENCES search_runs(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_market_snapshots_kind ON market_snapshots(kind, snapshot_date);

-- Persistent lock/lease so two pipeline cycles never process the same state concurrently.
CREATE TABLE IF NOT EXISTS run_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  run_id INTEGER,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

-- Small key/value store for system state that must survive sessions (last completed slot, etc.)
CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Latest match per job (most recent scored_at)
CREATE VIEW IF NOT EXISTS v_latest_job_matches AS
SELECT m.*
FROM job_matches m
JOIN (
  SELECT job_id, MAX(scored_at) AS max_scored_at
  FROM job_matches GROUP BY job_id
) latest ON latest.job_id = m.job_id AND latest.max_scored_at = m.scored_at;
