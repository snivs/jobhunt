---
name: score-job
description: Explain and (re)compute the compatibility score of a job against the candidate profile using the configurable weighted model (technical, required skills, experience, seniority, leadership, location, language, compensation, industry, responsibilities, preferences) plus hard constraints. Use to re-score after profile changes or to explain a score to the user.
---

# score-job

Scoring is deterministic code (`src/core/scoring.ts`) driven by `config/jobhunt.yaml`
(`matching.weights`, `matching.minimum_score`, `matching.undisclosed_compensation_score`).
The agent supplies the structured job analysis; the code computes the factors. Never adjust a
score by hand and never hide why a job scored what it scored.

## Score one job
1. `get_job` -> if `latest_match` exists for the current `profile_version` and
   `scoring_version` (compare with `get_candidate_profile().profile.version` and
   `get_config().matching.scoring_version`) and the posting did not change, reuse it.
2. Otherwise build the analysis (see `analyze-job`; reuse `latest_match.analysis` when the
   posting is unchanged) and call `calculate_job_match`.
3. Present the result in Spanish using the explanation block:

```
Overall: 91/100 (elegible)
technical match: 95 - ...
required skill match: 100 - 4/4 required skills covered
...
Fortalezas: ...
Riesgos: ...
Restricciones duras incumplidas: ...
Informacion faltante: ...
```

## Re-score the backlog (after profile/config changes)
- `get_jobs_pending_analysis` returns every active canonical job without a match for the
  current profile/scoring version. For each: reuse the stored `analysis` from `get_job_match`
  history when present (call `calculate_job_match` again with the same fields) instead of
  re-reading the posting.

## Rules
- Hard constraints win: a job can score 95 and still be `eligible: false`.
- Eligibility threshold = `matching.minimum_score` (default 80). The user changes it in
  config, never the agent.
- Salary not disclosed is a risk and "missing information", not a rejection, unless the user
  configured `applyWhenUndisclosed` on the minimum-salary constraint.
- Different currency than the candidate's: not compared automatically (score 65, flagged).
