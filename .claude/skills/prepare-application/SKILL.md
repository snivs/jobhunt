---
name: prepare-application
description: Prepare one application - select the CV variant, pick relevant profile facts, tailor allowed answers, draft a cover letter when needed, answer known screening questions deterministically, verify consistency with the second brain, and move the application to READY or REQUIRES_USER_INPUT. Never invents experience, certifications, employers or technologies.
---

# prepare-application

Input: `application_id` in state `SELECTED` (or `FAILED` / `REQUIRES_USER_INPUT` being retried).
Refer to the job by its short code (`job_code`, e.g. `VAC-2.119`) in every message, note and file name.
Application package note: `<vault>/Job Search/Applications/<job_code> - <Company> - <Role>.md` (type
`application-package`), holding the CV variant, drafted answers in the posting's language, the open
questions for the user and the submission checklist. Link it from `Job Matches.md`.

## Steps
1. `get_application` + `get_job` + `get_job_match` + `get_candidate_profile`. Read the vault
   notes `Career/Candidate Profile.md`, `Career/Experience.md`, `Job Search/Application Strategy.md`.
2. `record_application_event` -> `PREPARING` (`event_type: prepare_start`, `run_id`).
3. **CV variant**: choose from `preferences.resume_variants[]` by `use_for` (role family,
   seniority, stack). Store with `update_application {resume_variant, method}`. If no variant
   fits or the file path does not exist on disk -> `REQUIRES_USER_INPUT`.
4. **Relevant facts**: list the 5-8 profile facts most relevant to the match strengths
   (projects, metrics, technologies) - only facts present in the vault/SQLite.
5. **Cover letter** (only when the posting asks for one or the source form has a field):
   4 short paragraphs in the posting's language, grounded in those facts, no exaggeration.
   Save to `<project>/state/applications/<application_id>/cover-letter.md` and set
   `cover_letter_path`.
6. **Screening answers**: for each known question, answer ONLY if it is deterministic from
   `preferences.standard_answers`, `auto_apply_allowed_fields` and the profile (work
   authorization, notice period, salary expectation if allowed, remote preference, years of
   experience). Anything else -> add to `requires_user_input[]` as `{question, reason, field}`.
   Store answers with `update_application {answers}`.
7. **Consistency check**: every claim in the letter/answers must trace to the profile. Years,
   titles, employers and technologies must match `Career/Experience.md`. Remove anything you
   cannot trace.
8. Transition:
   - all good -> `READY` (`event_type: prepared`, details: resume_variant, answered_questions,
     cover_letter: yes/no).
   - open questions -> `REQUIRES_USER_INPUT` (`event_type: needs_user_input`, details: the
     questions). Tell the user in Spanish exactly what is needed.
9. For `discover_only` sources: prepare the same package, mark `READY`, and list it in the
   report as a manual hand-off with the URL, CV variant and the drafted answers. The agent never
   submits there.

## Hard rules
- Never invent experience, certifications, employers, technologies, dates or metrics.
- Never exaggerate responsibilities or seniority.
- Never answer a mandatory question with a guess. `REQUIRES_USER_INPUT` is the correct outcome.
- Personal data used automatically is limited to `auto_apply_allowed_fields`. Fields in
  `requires_approval_fields` always stop for the user.
- No credentials, tokens or passwords are ever written to SQLite, the vault or logs.
