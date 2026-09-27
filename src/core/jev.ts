import { experimental_evaluate, type Experimental_EvaluationQuestion } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { CandidateProfile, JobAnalysis } from "./scoring.js";

/**
 * Jev, TypeSafe AI's System One evaluation model, used here to CLASSIFY job postings.
 *
 * Jev does not decide anything. The deterministic scorer in `scoring.ts` owns eligibility, and the
 * hard constraints own rejection. Jev answers typed questions about a posting so the hand-off can
 * carry a second opinion next to the score, and so the two constraints the scorer provably cannot
 * evaluate stop being blind manual checks:
 *
 *   - `no_six_day_week`: no job field carries working days, but the posting prose often says so.
 *   - contractual reach into Mexico: "remote, scope not stated" is exactly the judgement call the
 *     scorer refuses to make and a reader makes easily.
 *
 * A posting is untrusted data. Its text is passed as STATE, never as instructions, and Jev returns
 * typed answers only (booleans with probabilities, bounded scores, closed choices), so a posting
 * cannot talk the evaluator into an arbitrary output. That property is the reason this is Jev and
 * not a general-purpose generative model.
 */

const CLOUDFLARE_MODEL = "typesafe/jev";

/** Bump when the questions change, so old rows stay interpretable. */
export const QUESTION_SET = "jobhunt-relevance-v1";

type CloudflareError = { code?: number; message?: string };

/** Cloudflare's /ai/run envelope around a third-party model run. */
type CloudflarePayload = {
  success?: boolean;
  errors?: CloudflareError[];
  result?: { state?: string; result?: { answers?: unknown } } & { answers?: unknown };
};

/**
 * Jev is served by Cloudflare as a third-party model. The TypeSafe provider already speaks Jev's
 * wire format; this adapts the request into Cloudflare's /ai/run envelope and unwraps the run
 * record it answers with. Lifted from the Jevinik reference implementation.
 */
function cloudflareFetch(accountId: string): typeof fetch {
  return async (_url, init) => {
    const { state, questions } = JSON.parse(String(init?.body));
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`, {
      ...init,
      body: JSON.stringify({ model: CLOUDFLARE_MODEL, input: { state, questions } }),
    });
    const payload = (await res.json().catch(() => null)) as CloudflarePayload | null;
    if (!res.ok || payload?.success === false) {
      const errors: CloudflareError[] = payload?.errors ?? [];
      const detail = errors.map((e) => `${e.message} (code ${e.code})`).join("; ") || `HTTP ${res.status}`;
      return Response.json({ message: `Cloudflare: ${detail}` }, { status: res.ok ? 502 : res.status });
    }
    const run = payload?.result;
    const output = run?.state === undefined ? run : run.state === "Completed" ? run.result : undefined;
    if (!output?.answers) {
      return Response.json({ message: `Cloudflare: unexpected response (run state: ${run?.state ?? "none"})` }, { status: 502 });
    }
    return Response.json(output);
  };
}

export function jevModel(env: NodeJS.ProcessEnv = process.env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env to use the Jev evaluator");
  }
  return createTypeSafeAi({ apiKey: apiToken, fetch: cloudflareFetch(accountId) }).evaluationModel("jev-latest");
}

export const WORK_ARRANGEMENTS = {
  onsite: "On-site: the work is performed at the employer's premises",
  remote: "Remote: the work is performed from wherever the candidate lives",
  hybrid: "Hybrid: some days at the employer's premises, some days remote",
  unclear: "The posting does not say",
} as const;

export const RESPONSIBILITIES = {
  architecture: "Mainly system design and architecture",
  technical_leadership: "Mainly leading engineers, setting technical direction, or reviewing work",
  ai_development: "Mainly building with or for AI: agents, LLM integration, MCP, RAG",
  other: "Mainly something else: feature delivery, support, data, infrastructure, management of non-engineers",
} as const;

/** The ten relevance questions asked of every posting before it is proposed to the candidate. */
export function buildQuestions(): Record<string, Experimental_EvaluationQuestion> {
  return {
    // --- The six the candidate asked for ---
    shouldWorkHere: {
      type: "boolean",
      instructions:
        "Given the candidate's profile and stated preferences, and everything the posting says, is this a job the candidate should take? Weigh fit, constraints and compensation together. Answer for this candidate specifically, not for a generic engineer.",
    },
    workArrangement: {
      type: "choice",
      instructions: "How is the work performed, according to the posting?",
      criteria: WORK_ARRANGEMENTS,
    },
    relocationRequired: {
      type: "boolean",
      instructions:
        "Would taking this job require the candidate to move away from where they currently live? Answer true only if the posting requires presence somewhere they do not live. A remote role that merely prefers a region does not require relocation.",
    },
    skillsFit: {
      type: "boolean",
      instructions:
        "Do the candidate's recorded skills match what this posting asks for? Judge against the skills listed in the candidate profile, including the levels and years recorded there. Do not credit skills the candidate has not reported.",
    },
    hiringRequirementsMet: {
      type: "boolean",
      instructions:
        "Does the candidate meet the posting's non-technical hiring requirements: years of experience, seniority, leadership experience, education, certifications, languages, work authorisation and location eligibility?",
    },
    technicalRequirementsMet: {
      type: "boolean",
      instructions:
        "Does the candidate meet the posting's stated technical requirements, meaning the specific technologies, platforms and engineering practices it names as required rather than preferred?",
    },

    // --- Four more, chosen to cover what the deterministic scorer cannot decide ---
    workableFromMexico: {
      type: "boolean",
      instructions:
        "Could this employer actually engage someone living in Mexico for this role, whether through a local entity, an Employer of Record, or as a contractor invoicing from Mexico? Consider the stated location scope, any residency or work-authorisation requirements, and how the company describes hiring. If the posting is silent on scope, judge from the rest of the posting rather than assuming.",
    },
    sixDayWeek: {
      type: "boolean",
      instructions:
        "Does this role require a mandatory six-day working week, or otherwise state a schedule beyond five days? Answer false when the posting says nothing about working days.",
    },
    supportOnly: {
      type: "boolean",
      instructions:
        "Is this role entirely or almost entirely customer support, helpdesk, or ticket handling, rather than building software? A role that includes some support alongside engineering is not support-only.",
    },
    primaryResponsibility: {
      type: "choice",
      instructions: "What would the person in this role spend most of their time doing?",
      criteria: RESPONSIBILITIES,
    },
  };
}

export type JevAnswers = {
  shouldWorkHere: number;
  workArrangement: keyof typeof WORK_ARRANGEMENTS;
  relocationRequired: number;
  skillsFit: number;
  hiringRequirementsMet: number;
  technicalRequirementsMet: number;
  workableFromMexico: number;
  sixDayWeek: number;
  supportOnly: number;
  primaryResponsibility: keyof typeof RESPONSIBILITIES;
  raw: Record<string, unknown>;
};

/**
 * The state Jev reasons over. Deliberately compact: Jev is a System One model, and a posting's full
 * boilerplate (benefits, EEO statements, interview logistics) adds tokens without adding signal.
 * The description is truncated for the same reason.
 */
export function buildState(profile: CandidateProfile, job: JobAnalysis, description: string | null) {
  return {
    candidate: {
      seniority: profile.seniority,
      yearsExperience: profile.yearsExperience,
      yearsLeadership: profile.yearsLeadership,
      skills: profile.skills.map((s) => ({ name: s.name, level: s.level, years: s.years ?? null })),
      languages: profile.languages.map((l) => ({ code: l.code, level: l.level })),
      livesIn: `${profile.location.city ?? ""}, ${profile.location.country}`.replace(/^, /, ""),
      timezone: profile.location.timezone ?? null,
      workAuthorization: profile.acceptableCountries,
      willRelocate: profile.relocation,
      acceptedWorkModes: profile.workModes,
      wantsResponsibilities: profile.responsibilitiesWanted,
      refusesResponsibilities: profile.responsibilitiesUnwanted,
      employmentTypes: profile.employmentTypes,
      compensationFloor: profile.compensation
        ? { minimum: profile.compensation.minimum, target: profile.compensation.target, currency: profile.compensation.currency, period: profile.compensation.period }
        : null,
      industriesPreferred: profile.industriesPreferred,
      industriesAvoided: profile.industriesAvoided,
    },
    posting: {
      title: job.title,
      seniority: job.seniority,
      workMode: job.workMode,
      country: job.country,
      remoteScope: job.remoteScope,
      employmentType: job.employmentType,
      requiredSkills: job.skills.filter((s) => s.mentionType === "explicit_required").map((s) => s.name),
      preferredSkills: job.skills.filter((s) => s.mentionType === "explicit_preferred").map((s) => s.name),
      yearsExperienceRequired: job.yearsExperienceRequired,
      leadershipRequired: job.leadershipRequired,
      languages: job.languages.map((l) => ({ code: l.code, minLevel: l.minLevel, required: l.required })),
      compensation: job.compensation,
      industry: job.industry,
      companyType: job.companyType,
      responsibilities: job.responsibilities,
      workAuthorizationRequired: job.workAuthorizationRequired,
      // Untrusted text. Passed as data to be judged, never as instructions to be followed.
      descriptionExcerpt: (description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000),
    },
  };
}

/** Asks Jev the ten relevance questions about one posting. Throws on transport or auth failure. */
export async function evaluateJob(
  profile: CandidateProfile,
  job: JobAnalysis,
  description: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JevAnswers> {
  const state = buildState(profile, job, description);
  const result = await experimental_evaluate({
    model: jevModel(env),
    // A JSON round-trip drops undefined fields, which Jev rejects as non-JSON state.
    state: JSON.parse(JSON.stringify(state)),
    questions: buildQuestions(),
  });

  const a = result.answers as Record<string, { probability?: number; choice?: string; score?: number }>;
  const bool = (k: string) => a[k]?.probability ?? 0;

  return {
    shouldWorkHere: bool("shouldWorkHere"),
    workArrangement: (a.workArrangement?.choice ?? "unclear") as keyof typeof WORK_ARRANGEMENTS,
    relocationRequired: bool("relocationRequired"),
    skillsFit: bool("skillsFit"),
    hiringRequirementsMet: bool("hiringRequirementsMet"),
    technicalRequirementsMet: bool("technicalRequirementsMet"),
    workableFromMexico: bool("workableFromMexico"),
    sixDayWeek: bool("sixDayWeek"),
    supportOnly: bool("supportOnly"),
    primaryResponsibility: (a.primaryResponsibility?.choice ?? "other") as keyof typeof RESPONSIBILITIES,
    raw: result.answers as Record<string, unknown>,
  };
}
