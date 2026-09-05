import type { SourceConfig } from "../config/index.js";
import type { RawJob } from "../core/normalize.js";
import type { JobRow } from "../db/repositories/jobs.js";
import type { Logger } from "../logging/index.js";
import type { HttpClient } from "./http.js";

export interface SourceContext {
  config: SourceConfig;
  /** search terms (normalized lowercase); empty = no filtering */
  terms: string[];
  /** maximum postings to return per source */
  limit: number;
  http: HttpClient;
  logger: Logger;
  env: NodeJS.ProcessEnv;
}

export type VerifyResult = "active" | "expired" | "unknown";

export interface SubmitPayload {
  applicationId: number;
  job: JobRow;
  resumePath: string | null;
  coverLetterPath: string | null;
  answers: Record<string, unknown>;
  candidate: { fullName: string | null; email: string | null; phone: string | null; links: Record<string, string> };
}

export interface SubmitResult {
  ok: boolean;
  external_reference?: string | null;
  error?: string | null;
  requires_user_input?: Array<{ question: string; reason: string; field?: string }>;
}

/**
 * A job source adapter. `fetch` must respect ctx.http (rate limits + retries) and never bypass
 * access controls. `submit` exists only for sources whose official API permits third-party
 * application submission; it is consulted only when automation_policy is apply_allowed.
 */
export interface JobSource {
  key: string;
  fetch(ctx: SourceContext): Promise<RawJob[]>;
  verify?(ctx: SourceContext, job: JobRow): Promise<VerifyResult>;
  submit?(ctx: SourceContext, payload: SubmitPayload): Promise<SubmitResult>;
}

/** True when the title (or tags) matches any of the search terms; no terms = match everything. */
export function matchesTerms(terms: string[], ...fields: Array<string | null | undefined>): boolean {
  if (terms.length === 0) return true;
  const hay = fields
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .join(" ")
    .toLowerCase();
  return terms.some((t) => hay.includes(t));
}

export function unixOrIsoToIso(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
