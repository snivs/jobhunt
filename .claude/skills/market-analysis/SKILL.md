---
name: market-analysis
description: Produce market intelligence from the accumulated job data - skill demand and growth, co-occurrence, skills by seniority/role, compensation (explicit vs expected, separately), source performance, funnel, and learning-investment suggestions. Saves snapshots to SQLite and a report note to the vault.
---

# market-analysis

Modes: `cycle` (light, called by `jobhunt-run`) and `full` (on demand: "analisis de mercado",
"que skills estan creciendo", "cuanto pagan por X").

## Data (jobhunt-db tools)
- `get_market_statistics {period_days}` - jobs by work mode / seniority / type / country, top
  skills with growth vs previous period, compensation explicit vs expected, per-source stats,
  funnel.
- `get_skill_market_demand` with filters (`seniority`, `title_contains`, `work_mode`,
  `country`, `mention_types`, `category`, `compare_with_previous_period: true`) for questions
  such as "skills mas comunes en puestos Senior/Lead" or "tecnologias perdiendo demanda"
  (negative `growth_pct`). Always report `job_count` (distinct jobs) and `mention_count`
  separately; say which one you are quoting.
- `get_skill_cooccurrence {skill_slug}` - skills that appear together.
- `get_compensation_statistics` - by role / seniority / location / work mode / currency. Report
  `explicit` and `expected` blocks separately with `sample_size`; when `insufficient_sample`
  is true say so instead of quoting a number. Salary correlation per skill: run
  `get_compensation_statistics` restricted by `role`/`seniority` and combine with
  `get_skill_market_demand` for the same filters; label it as an observation, not causation.
- `get_candidate_skill_gaps` - demanded skills missing from the profile.
- `get_source_statistics`, `get_application_statistics`.

## Output (Spanish)
```
Skills: skill | vacantes (distintas) | menciones | requerido/preferido/inferido | variacion vs periodo anterior
Compensacion explicita: mediana, p25-p75, n (moneda)
Compensacion estimada: mediana, p25-p75, n, confianza media
Fuentes: fuente | descubiertas | relevantes | aplicaciones | tasa de respuesta | errores
Funnel: descubiertas -> relevantes -> seleccionadas -> aplicadas -> respuesta -> entrevista -> oferta -> aceptada
Brechas de skills e inversion de aprendizaje sugerida (con evidencia: demanda + salario + crecimiento)
```

## Persist
- `save_market_snapshot` (`kind: summary` in cycle mode; `skills`, `compensation`, `sources`,
  `funnel` in full mode) with `period_start/period_end`.
- Vault: `Market Intelligence/Market Report YYYY-MM-DD.md` (AI-first, `type: market-report`,
  `period-start`, `period-end`, `sample-size`), linked from `Market Intelligence/Skills.md`
  and `Market Intelligence/Compensation.md`. Update per-skill notes
  `Market Intelligence/Skills/<Skill>.md` only for the top 15 skills (demand line with
  `(as of YYYY-MM-DD)` stamps, pointer to SQLite as where truth lives). Numbers in the vault are
  always dated; never write an undated present-tense count.

## Learning suggestions
When history is sufficient (>= 30 applications with outcomes), compare features of jobs that
led to responses/interviews versus not. Present as:
```
Observacion: ...
Sugerencia: ...
```
Changes to the user's criteria or weights need explicit confirmation.
