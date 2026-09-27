-- The cache identity was (job, posting content, profile version, question set). That covered three
-- of the four things Jev actually sees and missed the fourth: the structured analysis. Changing the
-- rule extractor changes the state sent to the model without changing any of those keys, so a
-- stale answer would be served for input that is no longer the input.
--
-- state_hash is a digest of the exact state passed to Jev, so the cache key is now "the model has
-- already been shown precisely this". It subsumes content and profile version; both columns stay
-- because they are what a person reads when asking why an answer is stale.
ALTER TABLE job_evaluations ADD COLUMN state_hash TEXT;

CREATE INDEX IF NOT EXISTS ix_job_evaluations_state
  ON job_evaluations(job_id, state_hash, question_set, id DESC);
