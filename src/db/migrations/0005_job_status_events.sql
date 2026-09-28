-- Why a posting changed status, and who said so.
--
-- update_job used to accept a `notes` argument and drop it: there was no column for it, and the
-- MCP layer discarded unknown arguments without an error. On 2026-09-27 six postings were closed
-- with careful reasons that were never stored; the status changed and the why was lost. The
-- reasons survived only because they were also written to the vault by hand.
--
-- Append-only, like application_events: a closure that is later reversed is a second row, not an
-- edit of the first. jobs.status stays the current value; this table is how it got there.
CREATE TABLE IF NOT EXISTS job_status_events (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_job_status_events_job ON job_status_events(job_id, id);
