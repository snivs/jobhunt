import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";

export type EvidenceLevel = "verified" | "inferred" | "unknown";

export interface ResearchFinding {
  topic: string; // product | industry | size | funding | reputation | technology | culture | growth | stability | hiring_signals | risks | interview_notes
  claim: string;
  evidence_level: EvidenceLevel;
  source_url?: string | null;
  as_of?: string | null;
  confidence?: number | null;
}

export interface ResearchRow {
  id: number;
  company_id: number;
  run_id: number | null;
  summary: string;
  findings_json: string;
  sources_json: string;
  vault_note: string | null;
  researched_at: string;
  created_at: string;
}

export interface ResearchView extends Omit<ResearchRow, "findings_json" | "sources_json"> {
  findings: ResearchFinding[];
  sources: string[];
}

function toView(r: ResearchRow): ResearchView {
  const { findings_json, sources_json, ...rest } = r;
  return { ...rest, findings: fromJson<ResearchFinding[]>(findings_json, []), sources: fromJson<string[]>(sources_json, []) };
}

const VALID_LEVELS: EvidenceLevel[] = ["verified", "inferred", "unknown"];

export function recordCompanyResearch(db: DB, input: { companyId: number; runId?: number | null; summary: string; findings: ResearchFinding[]; sources?: string[]; vaultNote?: string | null }): ResearchView {
  for (const f of input.findings) {
    if (!VALID_LEVELS.includes(f.evidence_level)) throw new Error(`Finding '${f.topic}' has invalid evidence_level ${f.evidence_level} (verified | inferred | unknown)`);
    if (f.evidence_level === "verified" && !f.source_url) throw new Error(`Finding '${f.topic}' is marked verified but has no source_url`);
  }
  const now = nowIso();
  const res = db
    .prepare("INSERT INTO company_research (company_id, run_id, summary, findings_json, sources_json, vault_note, researched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(input.companyId, input.runId ?? null, input.summary, toJson(input.findings), toJson(input.sources ?? []), input.vaultNote ?? null, now, now);
  if (input.vaultNote) db.prepare("UPDATE companies SET vault_note = COALESCE(vault_note, ?), updated_at = ? WHERE id = ?").run(input.vaultNote, now, input.companyId);
  return toView(db.prepare("SELECT * FROM company_research WHERE id = ?").get(Number(res.lastInsertRowid)) as ResearchRow);
}

export function getLatestCompanyResearch(db: DB, companyId: number): ResearchView | null {
  const row = db.prepare("SELECT * FROM company_research WHERE company_id = ? ORDER BY researched_at DESC LIMIT 1").get(companyId) as ResearchRow | undefined;
  return row ? toView(row) : null;
}

export interface CompanyNeedingResearch {
  company_id: number;
  name: string;
  best_score: number;
  eligible_jobs: number;
  last_researched_at: string | null;
}

/** Companies behind the best eligible matches whose research is missing or older than ttlDays. */
export function getCompaniesNeedingResearch(db: DB, opts: { ttlDays: number; minScore: number; limit: number }): CompanyNeedingResearch[] {
  const cutoff = new Date(Date.now() - opts.ttlDays * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT c.id AS company_id, c.name, MAX(m.overall_score) AS best_score, COUNT(*) AS eligible_jobs,
         (SELECT MAX(r.researched_at) FROM company_research r WHERE r.company_id = c.id) AS last_researched_at
       FROM v_latest_job_matches m
       JOIN jobs j ON j.id = m.job_id AND j.status = 'active' AND j.duplicate_of_job_id IS NULL
       JOIN companies c ON c.id = j.company_id
       WHERE m.eligible = 1 AND m.overall_score >= @minScore
       GROUP BY c.id
       HAVING last_researched_at IS NULL OR last_researched_at < @cutoff
       ORDER BY best_score DESC LIMIT @limit`,
    )
    .all({ minScore: opts.minScore, cutoff, limit: opts.limit }) as CompanyNeedingResearch[];
}
