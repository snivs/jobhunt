-- Jev evaluations: typed, probabilistic answers about one job posting, judged against the
-- candidate's profile and preferences. Jev is a classifier, NOT a decision maker: nothing here
-- rejects a job on its own, and nothing here overrides the deterministic scorer or the hard
-- constraints in src/core/scoring.ts. These answers travel with the hand-off so the candidate sees
-- a second opinion next to the score, and so the two questions the scorer provably cannot evaluate
-- (six-day weeks, contractual reach into Mexico) stop being blind manual checks.
--
-- Append-only by convention, like job_versions and application_events: a re-evaluation inserts a
-- new row rather than overwriting, so a change of answer after a profile change stays visible.
CREATE TABLE IF NOT EXISTS job_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES search_runs(id),
  -- Candidate profile version the questions were asked against; a stale evaluation is detectable.
  profile_version INTEGER NOT NULL,
  -- Which evaluator answered, and which question set. Bump question_set when the questions change.
  engine TEXT NOT NULL DEFAULT 'jev',
  question_set TEXT NOT NULL,
  -- Full typed answer payload: { key: { type, probability | score | choice, probabilities } }.
  answers_json TEXT NOT NULL,
  -- The posting content the answers were given about (jobs.content_hash at evaluation time).
  -- Together with job_id, profile_version and question_set this is the cache identity: the same
  -- questions, about the same posting text, judged against the same candidate. Any of the four
  -- changing makes a stored answer stale and worth asking again; none changing makes a second call
  -- pure waste, since the model would be shown identical input.
  content_hash TEXT,
  -- Denormalized for querying without parsing JSON. Probabilities are 0..1, NULL when unanswered.
  should_work_here REAL,
  work_arrangement TEXT,            -- onsite | remote | hybrid | unclear
  relocation_required REAL,
  skills_fit REAL,
  hiring_requirements_met REAL,
  technical_requirements_met REAL,
  workable_from_mexico REAL,
  six_day_week REAL,
  support_only REAL,
  primary_responsibility TEXT,      -- architecture | technical_leadership | ai_development | other
  -- Populated when the call failed, so a failure is recorded rather than silently skipped.
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_job_evaluations_job ON job_evaluations(job_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_job_evaluations_run ON job_evaluations(run_id);

-- The cache lookup: newest successful answer for this posting content, candidate and question set.
CREATE INDEX IF NOT EXISTS ix_job_evaluations_cache
  ON job_evaluations(job_id, content_hash, profile_version, question_set, id DESC);
