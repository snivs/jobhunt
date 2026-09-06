import { assertTransition, isApplicationState, SUBMITTED_LIKE_STATES, type ApplicationState } from "../../core/state-machine.js";
import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";
import { getJob } from "./jobs.js";
import { getLatestMatch } from "./matches.js";
import { getSourceById } from "./sources.js";

export type ApplicationMethod = "api" | "form" | "email" | "manual";

export interface ApplicationRow {
  id: number;
  job_id: number;
  source_id: number;
  run_id: number | null;
  match_id: number | null;
  status: ApplicationState;
  method: ApplicationMethod | null;
  resume_variant: string | null;
  cover_letter_path: string | null;
  answers_json: string | null;
  requires_user_input_json: string | null;
  submitted_at: string | null;
  external_reference: string | null;
  idempotency_key: string | null;
  failure_reason: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplicationEventRow {
  id: number;
  application_id: number;
  from_status: string | null;
  to_status: string;
  event_type: string;
  details_json: string | null;
  run_id: number | null;
  occurred_at: string;
}

export interface ApplicationView extends ApplicationRow {
  source_key: string;
  automation_policy: string;
  /** short job identifier (VAC-<run>.<job>) for human communication */
  job_code: string;
  job_title: string;
  company_name: string | null;
  job_url: string;
  job_status: string;
  events: ApplicationEventRow[];
}

function view(db: DB, id: number): ApplicationView | null {
  const row = db
    .prepare(
      `SELECT a.*, s.key AS source_key, s.automation_policy, j.code AS job_code, j.title AS job_title, j.company_name, j.url AS job_url, j.status AS job_status
       FROM applications a JOIN sources s ON s.id = a.source_id JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    )
    .get(id) as Omit<ApplicationView, "events"> | undefined;
  if (!row) return null;
  const events = db.prepare("SELECT * FROM application_events WHERE application_id = ? ORDER BY occurred_at, id").all(id) as ApplicationEventRow[];
  return { ...row, events };
}

export function getApplication(db: DB, id: number): ApplicationView | null {
  return view(db, id);
}

export function getApplicationByJob(db: DB, jobId: number): ApplicationView | null {
  const row = db.prepare("SELECT id FROM applications WHERE job_id = ?").get(jobId) as { id: number } | undefined;
  return row ? view(db, row.id) : null;
}

function appendEvent(db: DB, input: { applicationId: number; from: string | null; to: string; eventType: string; details?: Record<string, unknown> | null; runId?: number | null }): void {
  db.prepare("INSERT INTO application_events (application_id, from_status, to_status, event_type, details_json, run_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    input.applicationId,
    input.from,
    input.to,
    input.eventType,
    input.details ? toJson(input.details) : null,
    input.runId ?? null,
    nowIso(),
  );
}

/**
 * One application per job, ever. Returns the existing application when one exists (idempotent),
 * so a retried run can never create a second application for the same posting.
 */
export function getOrCreateApplication(
  db: DB,
  input: { jobId: number; runId?: number | null; initialStatus?: Extract<ApplicationState, "DISCOVERED" | "MATCHED" | "SELECTED">; details?: Record<string, unknown> | null },
): { application: ApplicationView; created: boolean } {
  const tx = db.transaction(() => {
    const existing = getApplicationByJob(db, input.jobId);
    if (existing) return { application: existing, created: false };
    const job = getJob(db, input.jobId);
    if (!job) throw new Error(`Job ${input.jobId} not found`);
    if (job.duplicate_of_job_id) throw new Error(`Job ${input.jobId} is a duplicate of job ${job.duplicate_of_job_id}; apply to the canonical job`);
    const match = getLatestMatch(db, input.jobId);
    const status = input.initialStatus ?? "DISCOVERED";
    const now = nowIso();
    const res = db
      .prepare(
        `INSERT INTO applications (job_id, source_id, run_id, match_id, status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.jobId, job.source_id, input.runId ?? null, match?.id ?? null, status, `job:${input.jobId}`, now, now);
    const id = Number(res.lastInsertRowid);
    appendEvent(db, { applicationId: id, from: null, to: status, eventType: "created", details: input.details ?? null, runId: input.runId });
    return { application: view(db, id)!, created: true };
  });
  return tx();
}

export interface ApplicationPatch {
  method?: ApplicationMethod | null;
  resume_variant?: string | null;
  cover_letter_path?: string | null;
  answers?: Record<string, unknown> | null;
  requires_user_input?: Array<{ question: string; reason: string; field?: string }> | null;
  external_reference?: string | null;
  match_id?: number | null;
  failure_reason?: string | null;
  last_error?: string | null;
  run_id?: number | null;
}

/** Patches non-state fields. State changes go through transitionApplication only. */
export function updateApplication(db: DB, id: number, patch: ApplicationPatch): ApplicationView {
  const existing = view(db, id);
  if (!existing) throw new Error(`Application ${id} not found`);
  const merged = {
    id,
    method: patch.method !== undefined ? patch.method : existing.method,
    resume_variant: patch.resume_variant !== undefined ? patch.resume_variant : existing.resume_variant,
    cover_letter_path: patch.cover_letter_path !== undefined ? patch.cover_letter_path : existing.cover_letter_path,
    answers_json: patch.answers !== undefined ? (patch.answers ? toJson(patch.answers) : null) : existing.answers_json,
    requires_user_input_json:
      patch.requires_user_input !== undefined ? (patch.requires_user_input ? toJson(patch.requires_user_input) : null) : existing.requires_user_input_json,
    external_reference: patch.external_reference !== undefined ? patch.external_reference : existing.external_reference,
    match_id: patch.match_id !== undefined ? patch.match_id : existing.match_id,
    failure_reason: patch.failure_reason !== undefined ? patch.failure_reason : existing.failure_reason,
    last_error: patch.last_error !== undefined ? patch.last_error : existing.last_error,
    run_id: patch.run_id !== undefined ? patch.run_id : existing.run_id,
    updated_at: nowIso(),
  };
  db.prepare(
    `UPDATE applications SET method = @method, resume_variant = @resume_variant, cover_letter_path = @cover_letter_path, answers_json = @answers_json,
       requires_user_input_json = @requires_user_input_json, external_reference = @external_reference, match_id = @match_id, failure_reason = @failure_reason,
       last_error = @last_error, run_id = @run_id, updated_at = @updated_at WHERE id = @id`,
  ).run(merged);
  return view(db, id)!;
}

export interface TransitionInput {
  applicationId: number;
  to: ApplicationState;
  eventType: string;
  details?: Record<string, unknown> | null;
  runId?: number | null;
  /** for SUBMITTED: external confirmation id, if any */
  externalReference?: string | null;
  failureReason?: string | null;
}

/** Validated state transition + append-only event. Never overwrites history. */
export function transitionApplication(db: DB, input: TransitionInput): ApplicationView {
  if (!isApplicationState(input.to)) throw new Error(`Unknown application state ${input.to}`);
  const tx = db.transaction(() => {
    const app = view(db, input.applicationId);
    if (!app) throw new Error(`Application ${input.applicationId} not found`);
    if (app.status === input.to && input.to !== "INTERVIEW") {
      // idempotent no-op for repeated identical transitions (e.g. a retried SUBMITTED confirmation)
      appendEvent(db, { applicationId: app.id, from: app.status, to: input.to, eventType: `${input.eventType}:repeat`, details: input.details ?? null, runId: input.runId });
      return view(db, app.id)!;
    }
    assertTransition(app.status, input.to);
    const now = nowIso();
    db.prepare(
      `UPDATE applications SET status = ?, submitted_at = CASE WHEN ? = 'SUBMITTED' THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
         external_reference = COALESCE(?, external_reference), failure_reason = COALESCE(?, failure_reason), run_id = COALESCE(?, run_id), updated_at = ? WHERE id = ?`,
    ).run(input.to, input.to, now, input.externalReference ?? null, input.failureReason ?? null, input.runId ?? null, now, app.id);
    appendEvent(db, { applicationId: app.id, from: app.status, to: input.to, eventType: input.eventType, details: input.details ?? null, runId: input.runId });
    return view(db, app.id)!;
  });
  return tx();
}

export interface ApplicationFilters {
  status?: ApplicationState | ApplicationState[];
  sourceKey?: string;
  runId?: number;
  since?: string;
  limit?: number;
}

export function listApplications(db: DB, f: ApplicationFilters = {}): ApplicationView[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: Math.min(f.limit ?? 100, 1000) };
  if (f.status) {
    const list = Array.isArray(f.status) ? f.status : [f.status];
    where.push(`a.status IN (${list.map((s) => `'${s}'`).join(",")})`);
  }
  if (f.sourceKey) {
    where.push("s.key = @sourceKey");
    params.sourceKey = f.sourceKey;
  }
  if (f.runId) {
    where.push("a.run_id = @runId");
    params.runId = f.runId;
  }
  if (f.since) {
    where.push("a.updated_at >= @since");
    params.since = f.since;
  }
  const ids = db
    .prepare(`SELECT a.id FROM applications a JOIN sources s ON s.id = a.source_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.updated_at DESC LIMIT @limit`)
    .all(params) as Array<{ id: number }>;
  return ids.map((r) => view(db, r.id)!);
}

export function countSubmissionsInRun(db: DB, sourceId: number, runId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(DISTINCT a.id) AS c FROM application_events e JOIN applications a ON a.id = e.application_id
         WHERE a.source_id = ? AND e.run_id = ? AND e.to_status IN ('SUBMITTING','SUBMITTED') AND e.event_type NOT LIKE '%:repeat'`,
      )
      .get(sourceId, runId) as { c: number }
  ).c;
}

export interface SubmitCheck {
  ok: boolean;
  reasons: string[];
  application: ApplicationView | null;
  submissions_in_run: number;
}

/**
 * Pre-flight for automatic submission. Every check must pass:
 * existing application not already submitted, job active, source permits automation,
 * per-source per-run limit not reached, latest match eligible and above threshold.
 */
export function assertCanSubmit(db: DB, input: { applicationId: number; runId: number; maxPerSourcePerRun: number; minimumScore: number; automaticSubmission: boolean }): SubmitCheck {
  const reasons: string[] = [];
  const app = view(db, input.applicationId);
  if (!app) return { ok: false, reasons: [`Application ${input.applicationId} not found`], application: null, submissions_in_run: 0 };
  if (!input.automaticSubmission) reasons.push("automatic_submission is disabled in config");
  if (SUBMITTED_LIKE_STATES.has(app.status)) reasons.push(`Application already ${app.status}`);
  if (!["READY", "BLOCKED", "FAILED", "REQUIRES_USER_INPUT"].includes(app.status)) reasons.push(`Application must be READY (is ${app.status})`);
  if (app.status === "REQUIRES_USER_INPUT") reasons.push("Application still requires user input");
  if (app.job_status !== "active") reasons.push(`Job is ${app.job_status}`);
  const source = getSourceById(db, app.source_id)!;
  if (source.automation_policy !== "apply_allowed") reasons.push(`Source ${source.key} policy is ${source.automation_policy}`);
  if (!source.enabled) reasons.push(`Source ${source.key} is disabled`);
  const submissions = countSubmissionsInRun(db, app.source_id, input.runId);
  if (submissions >= input.maxPerSourcePerRun) reasons.push(`Per-source limit reached for ${source.key} in run ${input.runId} (${submissions}/${input.maxPerSourcePerRun})`);
  const match = getLatestMatch(db, app.job_id);
  if (!match) reasons.push("Job has no match score");
  else {
    if (!match.eligible) reasons.push(`Latest match not eligible (hard constraints: ${match.hard_constraint_failures.join("; ") || "none"})`);
    if (match.overall_score < input.minimumScore) reasons.push(`Score ${match.overall_score} below minimum ${input.minimumScore}`);
  }
  if (!app.resume_variant) reasons.push("No resume variant selected");
  return { ok: reasons.length === 0, reasons, application: app, submissions_in_run: submissions };
}

export interface CandidateRow {
  job_id: number;
  code: string;
  title: string;
  company_name: string | null;
  source_key: string;
  automation_policy: string;
  overall_score: number;
  eligible: number;
  application_id: number | null;
  application_status: string | null;
  explicit_max_annual: number | null;
  seniority: string;
  url: string;
}

/**
 * Jobs eligible for application in this run, ordered by the prioritization rules
 * (score, hard requirements already satisfied by eligibility, compensation, seniority), grouped per source with the quota left.
 */
export function getApplicationCandidates(
  db: DB,
  input: { runId: number; minimumScore: number; maxPerSourcePerRun: number; sourceKey?: string; includeDiscoverOnly?: boolean; limitPerSource?: number },
): Array<{ source_key: string; automation_policy: string; quota_remaining: number; candidates: CandidateRow[] }> {
  const where: string[] = ["j.duplicate_of_job_id IS NULL", "j.status = 'active'", "m.eligible = 1", "m.overall_score >= @minScore", "s.enabled = 1", "s.automation_policy <> 'blocked'"];
  const params: Record<string, unknown> = { minScore: input.minimumScore };
  if (input.sourceKey) {
    where.push("s.key = @sourceKey");
    params.sourceKey = input.sourceKey;
  }
  if (!input.includeDiscoverOnly) where.push("s.automation_policy = 'apply_allowed'");
  where.push("(a.id IS NULL OR a.status IN ('DISCOVERED','MATCHED','SELECTED','PREPARING','READY','FAILED','BLOCKED'))");
  const rows = db
    .prepare(
      `SELECT j.id AS job_id, j.code, j.title, j.company_name, s.key AS source_key, s.automation_policy, s.id AS source_id, m.overall_score, m.eligible,
         a.id AS application_id, a.status AS application_status, j.seniority, j.url,
         (SELECT MAX(CASE c.period WHEN 'year' THEN c.max_amount WHEN 'month' THEN c.max_amount * 12 WHEN 'week' THEN c.max_amount * 52 WHEN 'day' THEN c.max_amount * 260 WHEN 'hour' THEN c.max_amount * 2080 END)
            FROM compensation_observations c WHERE c.job_id = j.id AND c.observation_type = 'explicit') AS explicit_max_annual
       FROM v_latest_job_matches m
       JOIN jobs j ON j.id = m.job_id
       JOIN sources s ON s.id = j.source_id
       LEFT JOIN applications a ON a.job_id = j.id
       WHERE ${where.join(" AND ")}
       ORDER BY s.key, m.overall_score DESC, explicit_max_annual DESC NULLS LAST,
         CASE j.seniority WHEN 'executive' THEN 7 WHEN 'director' THEN 6 WHEN 'principal' THEN 5 WHEN 'staff' THEN 4 WHEN 'lead' THEN 4 WHEN 'manager' THEN 4 WHEN 'senior' THEN 3 WHEN 'mid' THEN 2 ELSE 1 END DESC,
         j.discovered_at DESC`,
    )
    .all(params) as Array<CandidateRow & { source_id: number }>;
  const grouped = new Map<string, { source_key: string; automation_policy: string; quota_remaining: number; candidates: CandidateRow[] }>();
  for (const r of rows) {
    let g = grouped.get(r.source_key);
    if (!g) {
      const used = countSubmissionsInRun(db, r.source_id, input.runId);
      g = { source_key: r.source_key, automation_policy: r.automation_policy, quota_remaining: Math.max(0, input.maxPerSourcePerRun - used), candidates: [] };
      grouped.set(r.source_key, g);
    }
    const limit = input.limitPerSource ?? Math.max(g.quota_remaining, 3);
    if (g.candidates.length < limit) {
      const { source_id, ...rest } = r;
      void source_id;
      g.candidates.push(rest);
    }
  }
  return [...grouped.values()];
}

export function getApplicationStatistics(db: DB, opts: { since?: string } = {}): { by_status: Record<string, number>; by_source: Array<Record<string, unknown>>; funnel: Record<string, number> } {
  const params: Record<string, unknown> = {};
  const since = opts.since ? "WHERE a.created_at >= @since" : "";
  if (opts.since) params.since = opts.since;
  const byStatus: Record<string, number> = {};
  for (const r of db.prepare(`SELECT a.status, COUNT(*) AS c FROM applications a ${since} GROUP BY a.status`).all(params) as Array<{ status: string; c: number }>) byStatus[r.status] = r.c;
  const bySource = db
    .prepare(
      `SELECT s.key AS source_key, COUNT(*) AS applications,
         SUM(CASE WHEN a.status IN ('SUBMITTED','RESPONSE_RECEIVED','INTERVIEW','OFFER','ACCEPTED','DECLINED','NO_RESPONSE') THEN 1 ELSE 0 END) AS submitted,
         SUM(CASE WHEN a.status IN ('RESPONSE_RECEIVED','INTERVIEW','OFFER','ACCEPTED','DECLINED') THEN 1 ELSE 0 END) AS responses,
         SUM(CASE WHEN a.status IN ('INTERVIEW','OFFER','ACCEPTED','DECLINED') THEN 1 ELSE 0 END) AS interviews,
         SUM(CASE WHEN a.status IN ('OFFER','ACCEPTED','DECLINED') THEN 1 ELSE 0 END) AS offers,
         SUM(CASE WHEN a.status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN a.status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
         SUM(CASE WHEN a.status = 'REQUIRES_USER_INPUT' THEN 1 ELSE 0 END) AS requires_user_input
       FROM applications a JOIN sources s ON s.id = a.source_id ${since} GROUP BY s.key ORDER BY s.key`,
    )
    .all(params) as Array<Record<string, unknown>>;
  const funnel = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM jobs j WHERE j.duplicate_of_job_id IS NULL ${opts.since ? "AND j.discovered_at >= @since" : ""}) AS discovered,
         (SELECT COUNT(*) FROM v_latest_job_matches m JOIN jobs j ON j.id = m.job_id WHERE m.eligible = 1 AND j.duplicate_of_job_id IS NULL ${opts.since ? "AND j.discovered_at >= @since" : ""}) AS relevant,
         (SELECT COUNT(*) FROM applications a WHERE a.status NOT IN ('DISCOVERED','MATCHED') ${opts.since ? "AND a.created_at >= @since" : ""}) AS selected,
         (SELECT COUNT(*) FROM applications a WHERE a.status IN ('SUBMITTED','RESPONSE_RECEIVED','INTERVIEW','OFFER','ACCEPTED','DECLINED','NO_RESPONSE') ${opts.since ? "AND a.created_at >= @since" : ""}) AS applied,
         (SELECT COUNT(*) FROM applications a WHERE a.status IN ('RESPONSE_RECEIVED','INTERVIEW','OFFER','ACCEPTED','DECLINED') ${opts.since ? "AND a.created_at >= @since" : ""}) AS response,
         (SELECT COUNT(*) FROM applications a WHERE a.status IN ('INTERVIEW','OFFER','ACCEPTED','DECLINED') ${opts.since ? "AND a.created_at >= @since" : ""}) AS interview,
         (SELECT COUNT(*) FROM applications a WHERE a.status IN ('OFFER','ACCEPTED','DECLINED') ${opts.since ? "AND a.created_at >= @since" : ""}) AS offer,
         (SELECT COUNT(*) FROM applications a WHERE a.status = 'ACCEPTED' ${opts.since ? "AND a.created_at >= @since" : ""}) AS accepted`,
    )
    .get(params) as Record<string, number>;
  return { by_status: byStatus, by_source: bySource, funnel };
}

/** Marks SUBMITTED applications older than N days without any response as NO_RESPONSE (for funnel stats). */
export function markNoResponse(db: DB, olderThanDays: number, runId?: number | null): number {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const rows = db.prepare("SELECT id FROM applications WHERE status = 'SUBMITTED' AND submitted_at < ?").all(cutoff) as Array<{ id: number }>;
  for (const r of rows) transitionApplication(db, { applicationId: r.id, to: "NO_RESPONSE", eventType: "no_response_timeout", details: { older_than_days: olderThanDays }, runId });
  return rows.length;
}

export function requiresUserInput(db: DB): ApplicationView[] {
  return listApplications(db, { status: "REQUIRES_USER_INPUT", limit: 100 }).map((a) => ({ ...a, requires_user_input: fromJson(a.requires_user_input_json, []) })) as ApplicationView[];
}
