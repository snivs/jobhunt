import { createHash } from "node:crypto";

export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";
export type Seniority =
  | "intern"
  | "junior"
  | "mid"
  | "senior"
  | "staff"
  | "lead"
  | "principal"
  | "manager"
  | "director"
  | "executive"
  | "unknown";
export type EmploymentType = "full_time" | "part_time" | "contract" | "freelance" | "internship" | "unknown";

export interface RawSalary {
  min?: number | null;
  max?: number | null;
  currency?: string | null;
  period?: string | null;
  text?: string | null;
}

/** A job as delivered by a source adapter, before normalization. */
export interface RawJob {
  sourceKey: string;
  externalId?: string | null;
  url: string;
  title: string;
  companyName?: string | null;
  location?: string | null;
  country?: string | null;
  workMode?: WorkMode | null;
  remoteScope?: string | null;
  description?: string | null;
  postedAt?: string | null;
  seniority?: Seniority | null;
  employmentType?: EmploymentType | null;
  language?: string | null;
  salary?: RawSalary | null;
  rawMetadata?: Record<string, unknown> | null;
}

export interface NormalizedJob {
  sourceKey: string;
  externalId: string | null;
  url: string;
  canonicalUrl: string;
  title: string;
  normalizedTitle: string;
  companyName: string | null;
  normalizedCompanyName: string | null;
  location: string | null;
  country: string | null;
  workMode: WorkMode;
  remoteScope: string | null;
  description: string | null;
  descriptionHash: string | null;
  contentHash: string;
  dedupKey: string;
  postedAt: string | null;
  seniority: Seniority;
  employmentType: EmploymentType;
  language: string | null;
  salary: RawSalary | null;
  rawMetadata: Record<string, unknown> | null;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Lowercase, strip accents/punctuation, collapse whitespace. Used for dedup keys and matching. */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return "";
  return collapseWhitespace(
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9+#.\s]/g, " "),
  );
}

const COMPANY_SUFFIX = /\s+(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|bv|srl|s a de c v|sa de cv|s de rl de cv|s a|sa|s l|sl|s r l|pty|oy|ab|as|nv|kk|llp|lp)$/;

export function normalizeCompanyName(name: string | null | undefined): string | null {
  if (!name) return null;
  let n = collapseWhitespace(normalizeText(name).replace(/[.,]/g, " "));
  for (let i = 0; i < 3; i++) {
    const next = n.replace(COMPANY_SUFFIX, "");
    if (next === n) break;
    n = next;
  }
  return n || null;
}

const TITLE_NOISE = /\b(remote|hybrid|on-?site|full[- ]time|part[- ]time|contract|urgent|hiring|now hiring)\b/g;

const GENDER_MARKERS = /\b([mfwdh](\s*\/\s*[mfwdhx*]){1,3})\b/gi;

export function normalizeTitle(title: string): string {
  const stripped = title.replace(/\(.*?\)|\[.*?\]/g, " ").replace(GENDER_MARKERS, " ");
  let t = normalizeText(stripped);
  t = t.replace(TITLE_NOISE, " ");
  return collapseWhitespace(t);
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gh_src",
  "lever-source",
  "ref",
  "source",
  "src",
  "fbclid",
  "gclid",
  "trk",
  "trackingid",
  "refid",
]);

/** Removes tracking params, fragments and trailing slashes; lowercases host. */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
    return s;
  } catch {
    return url.trim();
  }
}

export function inferWorkMode(text: string | null | undefined, location?: string | null): WorkMode {
  const t = normalizeText(`${location ?? ""} ${text ?? ""}`);
  if (!t) return "unknown";
  if (/\bhybrid\b|\bhibrido\b/.test(t)) return "hybrid";
  if (/\bremote\b|\bremoto\b|\bwork from home\b|\bwfh\b|\bdistributed\b/.test(t)) {
    if (/\bon[- ]?site\b|\bin[- ]?office\b/.test(t) && !/\bremote first\b|\bfully remote\b|\b100% remote\b/.test(t)) return "hybrid";
    return "remote";
  }
  if (/\bon[- ]?site\b|\bin[- ]?office\b|\bpresencial\b/.test(t)) return "onsite";
  return "unknown";
}

export function inferSeniority(title: string, description?: string | null): Seniority {
  const t = normalizeText(title);
  if (/\b(cto|vp|vice president|chief)\b/.test(t)) return "executive";
  if (/\bdirector\b/.test(t)) return "director";
  if (/\b(engineering manager|manager|head of)\b/.test(t)) return "manager";
  if (/\bprincipal\b/.test(t)) return "principal";
  if (/\bstaff\b/.test(t)) return "staff";
  if (/\b(lead|tech lead|team lead)\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?|snr)\b/.test(t)) return "senior";
  if (/\b(junior|jr\.?|entry level|graduate|trainee)\b/.test(t)) return "junior";
  if (/\b(intern|internship|practicante)\b/.test(t)) return "intern";
  if (/\bmid\b|\bmid-level\b|\bintermediate\b/.test(t)) return "mid";
  const d = normalizeText(description ?? "").slice(0, 3000);
  const years = /(\d+)\+?\s*(?:years|yrs|anos)/.exec(d);
  if (years) {
    const y = Number(years[1]);
    if (y >= 8) return "senior";
    if (y >= 4) return "mid";
    if (y >= 1) return "junior";
  }
  return "unknown";
}

export function inferEmploymentType(text: string | null | undefined): EmploymentType {
  const t = normalizeText(text);
  if (!t) return "unknown";
  if (/\binternship\b|\bintern\b/.test(t)) return "internship";
  if (/\bfreelance\b/.test(t)) return "freelance";
  if (/\bcontract(or)?\b|\bb2b\b/.test(t)) return "contract";
  if (/\bpart[- ]time\b/.test(t)) return "part_time";
  if (/\bfull[- ]time\b|\bpermanent\b/.test(t)) return "full_time";
  return "unknown";
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Strips HTML tags and decodes common entities for plain-text descriptions. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");
  return text.trim() || null;
}

/**
 * Cross-source deduplication key: normalized company + normalized title.
 * Two postings with the same key are considered the same job unless proven otherwise.
 * Without a company the canonical URL is the only safe identity.
 */
export function buildDedupKey(normalizedCompany: string | null, normalizedTitle: string, canonicalUrl: string): string {
  if (normalizedCompany && normalizedTitle) return sha256(`${normalizedCompany}|${normalizedTitle}`);
  return sha256(`url|${canonicalUrl}`);
}

export function normalizeJob(raw: RawJob): NormalizedJob {
  const title = collapseWhitespace(raw.title);
  const description = htmlToText(raw.description) ?? null;
  const canonicalUrl = canonicalizeUrl(raw.url);
  const normalizedTitle = normalizeTitle(title);
  const companyName = raw.companyName ? collapseWhitespace(raw.companyName) : null;
  const normalizedCompanyName = normalizeCompanyName(companyName);
  const location = raw.location ? collapseWhitespace(raw.location) : null;
  const head = `${title} ${description ?? ""}`.slice(0, 4000);
  const workMode = raw.workMode && raw.workMode !== "unknown" ? raw.workMode : inferWorkMode(head, location);
  const seniority = raw.seniority && raw.seniority !== "unknown" ? raw.seniority : inferSeniority(title, description);
  const employmentType =
    raw.employmentType && raw.employmentType !== "unknown" ? raw.employmentType : inferEmploymentType(head);
  const descriptionHash = description ? sha256(normalizeText(description)) : null;
  const salary = raw.salary && (raw.salary.min != null || raw.salary.max != null || raw.salary.text) ? raw.salary : null;
  const contentHash = sha256(
    JSON.stringify({
      title: normalizedTitle,
      company: normalizedCompanyName,
      location: normalizeText(location),
      workMode,
      description: descriptionHash,
      salary,
      employmentType,
    }),
  );
  return {
    sourceKey: raw.sourceKey,
    externalId: raw.externalId != null && raw.externalId !== "" ? String(raw.externalId) : null,
    url: raw.url.trim(),
    canonicalUrl,
    title,
    normalizedTitle,
    companyName,
    normalizedCompanyName,
    location,
    country: raw.country ? collapseWhitespace(raw.country) : null,
    workMode,
    remoteScope: raw.remoteScope ?? null,
    description,
    descriptionHash,
    contentHash,
    dedupKey: buildDedupKey(normalizedCompanyName, normalizedTitle, canonicalUrl),
    postedAt: toIsoOrNull(raw.postedAt),
    seniority,
    employmentType,
    language: raw.language ?? null,
    salary,
    rawMetadata: raw.rawMetadata ?? null,
  };
}
