---
name: submit-application
description: Submit a READY application through a permitted, official method (source adapter with automation_policy apply_allowed) with full idempotency and audit trail - max 3 per source per run, never twice for the same job, never on platforms that forbid automation. Otherwise hand off to the user.
---

# submit-application

Input: `application_id` in `READY`, current `run_id`, session `holder`.

## Pre-flight (all must pass, every time)
1. `check_can_submit {application_id, run_id}`. If `ok` is false: do NOT submit. Transition to
   `BLOCKED` (`event_type: blocked`, details: reasons) when the reason is policy/quota/job
   state, or leave it `READY` when the reason is temporary (limit reached this run -> it will be
   considered next run). Report the reasons.
2. Verify the posting is still open: run `npm run jobhunt -- verify-job --job-id <id>` (the
   adapter re-fetches the posting). If gone -> `update_job {status: expired}` and
   `record_application_event -> EXPIRED`.
3. Confirm the application material: `resume_variant` file exists, `answers` cover every
   mandatory field of the form/API, no `requires_user_input` left.

## Submit
4. `record_application_event -> SUBMITTING` (`event_type: submit_start`, `run_id`). This is
   the point of no return: a crash after this leaves the application in `REQUIRES_USER_INPUT`
   on recovery so it is never sent twice blindly.
5. Execute the source's submit adapter:

```bash
npm run jobhunt -- submit --application-id <id> --run-id <RUN_ID>
```

   The adapter only exists for sources with `automation_policy: apply_allowed` and uses the
   official application endpoint of that ATS/API. It returns `{ok, external_reference, error,
   requires_user_input}`. It never fills web forms with a browser on sites that forbid it and
   never handles CAPTCHAs.
6. On success: `record_application_event -> SUBMITTED` (`event_type: submitted`,
   `external_reference`, details: method, resume_variant, timestamp).
   On a definitive failure (validation error, 4xx): `-> FAILED` (`event_type: submit_failed`,
   `failure_reason`). On policy/permission errors: `-> BLOCKED`. On unknown outcome (timeout
   after the request was sent): `-> REQUIRES_USER_INPUT` with details asking the user to verify.
7. Update the vault: `Job Search/Job Matches.md` "Aplicaciones recientes" entry with wikilinks
   to the company note; append to `Logs/YYYY-MM-DD.md`.

## Limits
- `applications.max_per_source_per_run` (default 3). `check_can_submit` enforces it; you enforce
  it too by never starting a 4th submission for a source in the same run.
- One application per job, forever. Re-applying to a reposted job requires the user's explicit
  instruction and a new job record.
- `applications.automatic_submission: false` disables this skill entirely (hand-off mode).

## Manual hand-off (discover_only sources)
Never submit. Produce, in Spanish, a ready-to-use package: URL, CV variant, cover letter path,
answers, and 3 bullet points on why it matches. Leave the application `READY` and list it under
"Hand-off manual" in the report and in `Job Matches.md`.
