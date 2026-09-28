import type { JobCompensation } from "./scoring.js";

/**
 * Facts that live in the BODY of a posting and that aggregators routinely get wrong in their own
 * metadata: where the employer can actually hire, whether the role is really remote, which time
 * zone it demands, and the salary it prints in prose.
 *
 * Why this exists: on 2026-09-27 a manual sweep of 21 eligible postings found that six had their
 * geography mislabelled by the aggregator ("Anywhere in the World" over "remote for candidates
 * located in Ontario, Canada"), one demanded "CET +/- 3 hours, we are unable to consider other time
 * zones", and five printed a salary range that the scorer then reported as "Salary not disclosed".
 * Every one of those facts was sitting in the description.
 *
 * Precision over recall. Each pattern here is a phrase employers use to RESTRICT, and a match must
 * also name a real place. When a phrase is suggestive but not decisive (an in-office clause in
 * company boilerplate, "any country where we have a legal entity"), it becomes a manual check, not a
 * rejection. The posting is untrusted data: this only matches text, it never follows it.
 */

export interface ScopeSignal {
  /** The geography the employer restricts the role to, as written. */
  text: string;
  /** The sentence it came from, for the reader of the stored analysis. */
  evidence: string;
}

export interface TimezoneWindow {
  zone: string;
  /** Standard-time UTC offset of the zone, in hours. */
  baseOffset: number;
  plusMinus: number;
  /** The posting says candidates outside the window will not be considered. */
  hard: boolean;
  evidence: string;
}

export interface BodyCompensation extends JobCompensation {
  evidence: string;
  /** Words just before the range, e.g. "Canada Base Pay Range" or "US base salary range". */
  label: string | null;
}

export interface BodySignals {
  scope: ScopeSignal | null;
  /** "We can hire in any country where we have a legal entity": true but unverifiable from here. */
  legalEntityClause: string | null;
  officeDays: string | null;
  timezone: TimezoneWindow | null;
  salary: BodyCompensation | null;
  /** The published pay range is stated for one country, which says nothing about the rate elsewhere. */
  countryPay: string | null;
}

/** Places a restriction must name before it is believed. Lower case, matched on word boundaries. */
const GEOGRAPHY = [
  "united states", "usa", "u.s.", "us", "canada", "ontario", "quebec", "british columbia", "alberta",
  "mexico", "méxico", "ireland", "united kingdom", "uk", "england", "scotland", "germany", "france",
  "spain", "portugal", "netherlands", "poland", "czechia", "czech republic", "romania", "italy",
  "sweden", "switzerland", "austria", "belgium", "denmark", "finland", "norway", "estonia", "croatia",
  "india", "brazil", "argentina", "colombia", "chile", "peru", "australia", "new zealand", "japan",
  "singapore", "philippines", "israel", "south africa", "europe", "eu", "european union", "emea",
  "apac", "latam", "latin america", "north america", "americas",
  // US states that postings name on their own
  "california", "new york", "texas", "washington", "massachusetts", "new jersey", "colorado",
  "east coast", "west coast",
];

const GLOBAL = /\b(worldwide|anywhere|global(?:ly)?|any country|all countries)\b/i;

function namesPlace(text: string): boolean {
  const t = ` ${text.toLowerCase()} `;
  return GEOGRAPHY.some((g) => new RegExp(`[^a-z]${g.replace(/\./g, "\\.")}[^a-z]`).test(t));
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf(".", index - 1), text.lastIndexOf("\n", index - 1)) + 1;
  const stops = [".", "\n"].map((c) => text.indexOf(c, index)).filter((i) => i >= 0);
  const end = stops.length ? Math.min(...stops) : text.length;
  return text.slice(start, end + 1).replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Trim a captured place list at the first word that is clearly no longer geography. */
function tidyPlace(raw: string): string {
  return raw
    .split(/\b(?:and we|we |who |with |to |for |if |so |but |please)\b/i)[0]!
    .replace(/[\s,;:()-]+$/u, "")
    .trim();
}

const SCOPE_PATTERNS: RegExp[] = [
  // Faire: "This role can also be performed remotely for candidates located in Ontario, Canada."
  /\bremotely? (?:only )?for (?:candidates|applicants|people|those) (?:located|based|residing|living) in (?:the )?([^.;\n]{2,70})/i,
  // "Candidates must be located in the United States", "must reside within Canada"
  /\b(?:must|need to|required to) (?:be )?(?:located|based|reside|residing|live|living) (?:in|within) (?:the )?([^.;\n]{2,60})/i,
  // Huntress: "Location: Remote Ireland", "Location: Remote - US"
  // Same line only: "Location: Remote" followed by a new paragraph must not swallow the paragraph.
  /\blocation:[ \t]*remote[ \t]*[-–,(]?[ \t]*([A-Z][A-Za-z .,&-]{1,50})/i,
  // Princeton: "A remote work arrangement within the US may be considered"
  /\bremote (?:work )?(?:arrangement|position|role|option)?\s*(?:is )?(?:only )?(?:within|in) the (US|U\.S\.|USA|United States|UK|EU)\b/i,
  // "open to candidates in the US and Canada only"
  /\bopen (?:only )?to (?:candidates|applicants) (?:located |based )?in (?:the )?([^.;\n]{2,60}?) only\b/i,
  // "US-based candidates only", "Canada-based applicants only"
  /\b((?:US|U\.S\.|Canada|UK|EU))[- ]based (?:candidates|applicants|employees|residents) only\b/i,
  // HN headers: "Backend Engineer | REMOTE (US) | Full-time"
  /\bremote\s*\(\s*((?:US|USA|U\.S\.|Canada|UK|EU|Europe)(?:\s*(?:\/|&|and|or)\s*(?:US|USA|Canada|UK|EU|Europe))?)(?:\s*only)?\s*\)/i,
  // Fin: "Proof of eligibility to work in the United States is required."
  /\b(?:eligib(?:le|ility)|authori[sz](?:ed|ation)) to work in (?:the )?([^.;\n]{2,40}?) (?:is )?required\b/i,
  // JFrog: "Open to remote within the East Coast only"
  /\bopen to remote (?:work )?(?:with)?in (?:the )?([^.;\n]{2,40}?) only\b/i,
  // WeWorkRemotely prefixes every post with "Headquarters:". When it reads "Remote, <place>" it is
  // the role's region (CircleCI "Remote, Ontario, Canada", Squarespace "Remote, United States");
  // a bare city ("Warsaw, Poland") is the company's head office and says nothing about the role.
  /\bheadquarters:[ \t]*remote(?:,[ \t]*|[ \t]+)([A-Z][A-Za-z .,-]{1,50})/i,
];

/** "compensation for US based candidates", "In the United States, ... pay zones", "US base salary range" */
const COUNTRY_PAY_RE =
  /\b(?:(US|U\.S\.|United States|Canada|Canadian|UK|EU)[- ](?:based )?(?:base )?(?:salary|pay|compensation)|(?:for|in) the (United States|US)\b[^.]{0,60}\b(?:pay|compensation|salary)|compensation for (US|Canada|UK)[- ]based candidates)/i;

export function extractScope(text: string): ScopeSignal | null {
  for (const re of SCOPE_PATTERNS) {
    const m = re.exec(text);
    if (!m || !m[1]) continue;
    const place = tidyPlace(m[1]);
    if (!place || GLOBAL.test(place) || !namesPlace(place)) continue;
    return { text: place, evidence: sentenceAround(text, m.index) };
  }
  return null;
}

const ZONES: Record<string, number> = {
  cet: 1, cest: 1, eet: 2, eest: 2, wet: 0, gmt: 0, utc: 0, bst: 0,
  est: -5, edt: -5, et: -5, eastern: -5, cst: -6, central: -6, mst: -7, mountain: -7,
  pst: -8, pdt: -8, pt: -8, pacific: -8,
};

const TZ_RE =
  /\b(?:located|based|working|work|live|living|reside) (?:with)?in (?:the )?(CET|CEST|EET|EEST|WET|GMT|UTC|BST|EST|EDT|ET|Eastern|CST|Central|MST|Mountain|PST|PDT|PT|Pacific)(?: (?:standard )?time)?(?: ?zone)?\s*\(?\s*(?:\+\/-|\+-|±|plus or minus)\s*(\d{1,2})\s*h(?:ours?|rs?)?\)?/i;

const TZ_HARD = /\b(unable to consider|cannot consider|can't consider|will not consider|won't consider|not able to consider|only consider|only accept|must be)\b/i;

export function extractTimezone(text: string): TimezoneWindow | null {
  const m = TZ_RE.exec(text);
  if (!m) return null;
  const zone = m[1]!;
  const base = ZONES[zone.toLowerCase()];
  if (base === undefined) return null;
  const evidence = sentenceAround(text, m.index);
  // The refusal often follows in the same bullet after a comma, so look a little past the sentence.
  const tail = text.slice(m.index, m.index + 220);
  return { zone: zone.toUpperCase(), baseOffset: base, plusMinus: Number(m[2]), hard: TZ_HARD.test(tail), evidence };
}

const LEGAL_ENTITY_RE = /\b(?:any|every) country where we (?:have|operate|maintain) a (?:legal )?entity\b/i;

const OFFICE_DAYS_RE =
  /\b(?:(?:into|in|at) (?:the|our) office[^.;\n]{0,30}?\b(\d|one|two|three|four|five) days?\b|\b(\d|one|two|three|four|five) days? (?:a|per|each) week (?:in|at) (?:the|our) office)/i;

const CURRENCY_CODES = "USD|CAD|EUR|GBP|AUD|PLN|MXN|CHF|SEK|NOK|DKK|CZK|INR|BRL|JPY|NZD|SGD";
const SYMBOL_CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

const AMOUNT = String.raw`(\d{1,3}(?:[.,  ]\d{3})+|\d+(?:\.\d+)?)\s*([kK])?`;
const SALARY_RE = new RegExp(
  String.raw`(?:\b(${CURRENCY_CODES})\s*)?([$€£])?\s?${AMOUNT}\s*(?:${CURRENCY_CODES})?\s*(?:-|–|—|to)\s*(?:\b(${CURRENCY_CODES})\s*)?([$€£])?\s?${AMOUNT}(?:\s*(${CURRENCY_CODES})\b)?`,
  "g",
);

function parseAmount(raw: string, k: string | undefined): number {
  const grouped = /^\d{1,3}(?:[.,  ]\d{3})+$/.test(raw);
  const n = grouped ? Number(raw.replace(/[.,  ]/g, "")) : Number(raw);
  return k ? n * 1000 : n;
}

function periodNear(window: string): JobCompensation["period"] {
  if (/\b(per hour|an hour|hourly|\/ ?h(?:ou)?r)\b/i.test(window) || /\/hour/i.test(window)) return "hour";
  if (/\b(per month|a month|monthly|\/ ?mo(?:nth)?)\b/i.test(window)) return "month";
  if (/\b(per year|a year|annual(?:ly)?|per annum|\/ ?y(?:ea)?r)\b/i.test(window)) return "year";
  return null;
}

export function extractSalary(text: string): BodyCompensation | null {
  SALARY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SALARY_RE.exec(text))) {
    const [, code1, sym1, a1, k1, code2, sym2, a2, k2, code3] = m;
    const code = (code1 ?? code2 ?? code3 ?? "").toUpperCase();
    const symbol = sym1 ?? sym2;
    // A range with no currency at all is years, percentages or dates, never pay.
    if (!code && !symbol) continue;
    // "$5-10 million in funding" and the like
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (/^\s*(million|billion|m\b|bn\b|in funding|users|customers)/i.test(after)) continue;
    // "$150 - 210K": the multiplier written once applies to both ends.
    let min = parseAmount(a1!, k1 ?? (k2 && Number(a1) < 1000 ? k2 : undefined));
    let max = parseAmount(a2!, k2 ?? (k1 && Number(a2) < 1000 ? k1 : undefined));
    if (!(min > 0 && max > 0)) continue;
    if (min > max) [min, max] = [max, min];
    const currency = code || SYMBOL_CURRENCY[symbol!] || "USD";
    const window = text.slice(Math.max(0, m.index - 70), m.index + m[0].length + 60);
    let period = periodNear(window);
    if (!period) period = max < 500 ? "hour" : max < 20000 ? "month" : "year";
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const label = /([A-Za-z][A-Za-z .]{0,40}(?:range|pay|salary|compensation|remuneration)[A-Za-z ]{0,20})[:\s]*$/i.exec(before)?.[1]?.trim() ?? null;
    return { min, max, currency, period, explicit: true, evidence: sentenceAround(text, m.index), label };
  }
  return null;
}

export function extractBodySignals(text: string): BodySignals {
  const entity = LEGAL_ENTITY_RE.exec(text);
  const office = OFFICE_DAYS_RE.exec(text);
  const countryPay = COUNTRY_PAY_RE.exec(text);
  return {
    scope: extractScope(text),
    legalEntityClause: entity ? sentenceAround(text, entity.index) : null,
    officeDays: office ? sentenceAround(text, office.index) : null,
    timezone: extractTimezone(text),
    salary: extractSalary(text),
    countryPay: countryPay ? sentenceAround(text, countryPay.index) : null,
  };
}

/** Current UTC offset of an IANA zone, in hours. Null when the zone is unknown. */
export function utcOffsetHours(timeZone: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = /GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/.exec(name);
    if (!m) return null;
    if (!m[1]) return 0;
    const h = Number(m[2]) + Number(m[3] ?? 0) / 60;
    return m[1] === "-" ? -h : h;
  } catch {
    return null;
  }
}
