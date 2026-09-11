---
name: review-applications
description: Review the state of all applications - pending user input, submitted without response, interviews, offers, failures - update states from the user's news, answer pending questions, and surface next actions. Use when the user reports a response or asks "how are my applications".
---

# review-applications

Always name applications by their job short code (`job_code`, e.g. `VAC-2.119`) followed by company
and role; never by bare URL. When presenting hand-offs or candidates for a decision, use the mandatory
table: `| Vacante (code + company + role, linked to the posting) | Compensacion | Ubicacion/remoto/hibrido | Por que si | Por que no |`.

## Status review
1. `get_application_statistics` (funnel + by status + by source).
2. `list_applications` for `REQUIRES_USER_INPUT`, `BLOCKED`, `FAILED`, `READY`
   (hand-offs), `SUBMITTED`, `RESPONSE_RECEIVED`, `INTERVIEW`, `OFFER`.
3. Present in Spanish, grouped: **Necesitan tu respuesta** (with the exact questions from
   `requires_user_input_json`), **Hand-off manual** (READY on discover_only sources),
   **Enviadas sin respuesta** (days since `submitted_at`), **En proceso** (interviews/offers),
   **Fallidas / bloqueadas** (reason + whether a retry makes sense).

## Recording user news
When the user says "me respondieron de X", "tengo entrevista", "me rechazaron", "acepte":
- Find the application (`get_application` by job id, or `search_jobs` by company/title).
- `record_application_event` with the right state: `RESPONSE_RECEIVED`, `INTERVIEW` (may be
  repeated for each round), `OFFER`, `REJECTED`, `ACCEPTED`, `DECLINED`, `WITHDRAWN`; put the
  details (date, interviewer, stage, feedback) in `details`.
- Save qualitative context to the vault: company note (`Market Intelligence/Companies/<Company>.md`
  interview notes section) and `Job Search/Job Matches.md`; daily log line.

## Answering pending questions
When the user answers a `REQUIRES_USER_INPUT` item:
1. `update_application {answers: merged, requires_user_input: remaining or null}`.
2. If the answer is reusable, offer to store it in `preferences.standard_answers`
   (`set_candidate_preference`) and in `Job Search/Application Strategy.md`.
3. Transition back to `READY` (`event_type: user_input_received`). Submission happens in the
   next cycle (or now, if the user asks and the source allows automation).

## Learning
Every 20 submitted applications (or when asked), compare features of applications that got
responses vs not (source, score band, seniority, work mode, explicit salary, company size) using
`list_applications` + `get_job_match`. Present observations as suggestions
("Observacion: ... Sugerencia: ..."). Never change the user's fundamental criteria yourself;
ask for confirmation before adjusting preferences or weights.
