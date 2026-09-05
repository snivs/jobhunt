export const APPLICATION_STATES = [
  "DISCOVERED",
  "MATCHED",
  "SELECTED",
  "PREPARING",
  "READY",
  "SUBMITTING",
  "SUBMITTED",
  "REJECTED",
  "SKIPPED",
  "REQUIRES_USER_INPUT",
  "FAILED",
  "BLOCKED",
  "EXPIRED",
  "WITHDRAWN",
  "RESPONSE_RECEIVED",
  "INTERVIEW",
  "OFFER",
  "ACCEPTED",
  "DECLINED",
  "NO_RESPONSE",
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

/** Allowed transitions. Anything not listed is rejected by the repository layer. */
const TRANSITIONS: Record<ApplicationState, readonly ApplicationState[]> = {
  DISCOVERED: ["MATCHED", "REJECTED", "SKIPPED", "EXPIRED", "BLOCKED"],
  MATCHED: ["SELECTED", "REJECTED", "SKIPPED", "EXPIRED", "BLOCKED"],
  SELECTED: ["PREPARING", "SKIPPED", "EXPIRED", "BLOCKED", "REQUIRES_USER_INPUT"],
  PREPARING: ["READY", "REQUIRES_USER_INPUT", "FAILED", "SKIPPED", "EXPIRED", "BLOCKED"],
  READY: ["SUBMITTING", "REQUIRES_USER_INPUT", "SKIPPED", "EXPIRED", "BLOCKED", "SUBMITTED"],
  SUBMITTING: ["SUBMITTED", "FAILED", "BLOCKED", "REQUIRES_USER_INPUT"],
  SUBMITTED: ["RESPONSE_RECEIVED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN", "NO_RESPONSE"],
  REQUIRES_USER_INPUT: ["PREPARING", "READY", "SKIPPED", "EXPIRED", "BLOCKED", "SUBMITTED"],
  FAILED: ["PREPARING", "READY", "SKIPPED", "EXPIRED", "BLOCKED"],
  BLOCKED: ["READY", "SKIPPED", "EXPIRED", "SUBMITTED"],
  REJECTED: [],
  SKIPPED: ["SELECTED"],
  EXPIRED: [],
  WITHDRAWN: [],
  RESPONSE_RECEIVED: ["INTERVIEW", "REJECTED", "WITHDRAWN", "OFFER", "NO_RESPONSE"],
  INTERVIEW: ["OFFER", "REJECTED", "WITHDRAWN", "INTERVIEW"],
  OFFER: ["ACCEPTED", "DECLINED", "WITHDRAWN"],
  ACCEPTED: [],
  DECLINED: [],
  NO_RESPONSE: ["RESPONSE_RECEIVED", "INTERVIEW", "REJECTED"],
};

export const TERMINAL_STATES: ReadonlySet<ApplicationState> = new Set(["REJECTED", "EXPIRED", "WITHDRAWN", "ACCEPTED", "DECLINED"]);

/** States in which the job has been (or is being) sent: a second submission must never happen. */
export const SUBMITTED_LIKE_STATES: ReadonlySet<ApplicationState> = new Set([
  "SUBMITTING",
  "SUBMITTED",
  "RESPONSE_RECEIVED",
  "INTERVIEW",
  "OFFER",
  "ACCEPTED",
  "DECLINED",
  "NO_RESPONSE",
  "WITHDRAWN",
]);

/** States from which a run may still take the application towards submission. */
export const PIPELINE_ACTIVE_STATES: ReadonlySet<ApplicationState> = new Set([
  "DISCOVERED",
  "MATCHED",
  "SELECTED",
  "PREPARING",
  "READY",
  "SUBMITTING",
]);

export function isApplicationState(s: string): s is ApplicationState {
  return (APPLICATION_STATES as readonly string[]).includes(s);
}

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ApplicationState, to: ApplicationState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid application transition ${from} -> ${to}`);
  }
}

export function allowedTransitions(from: ApplicationState): readonly ApplicationState[] {
  return TRANSITIONS[from];
}
