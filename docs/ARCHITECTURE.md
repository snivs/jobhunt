# Arquitectura - Autonomous Job Hunter

Estado: diseño aprobado el 2026-09-05; fases 1 a 6, 8 y 9 implementadas y en uso (dos ciclos reales corridos el 2026-09-05); fase 7 (envío automático) pendiente de una fuente que lo permita oficialmente. Este documento es la referencia de diseño; el código es la fuente de verdad de los detalles.

## 1. Objetivo

Un sistema autónomo, recurrente y auditable que descubre vacantes en múltiples fuentes, las normaliza y deduplica, extrae habilidades y compensación, califica compatibilidad contra un perfil profundo del candidato, investiga empresas, prepara aplicaciones y las envía solo cuando la fuente lo permite; y que aprende del mercado y de sus resultados. Optimiza **valor esperado de carrera**, no volumen de aplicaciones.

## 2. Capas

```
Claude Code (agente/orquestador)
  ├── Skills de proyecto (.claude/skills/*)      <- razonamiento, decisiones, redacción
  ├── /loop                                       <- recurrencia auto-programada
  └── MCP
       ├── jobhunt-db (propio, TypeScript)        <- SQLite: estado transaccional y analítico
       └── vault (plugin obsidian-second-brain)   <- búsqueda/lectura/escritura del vault

Segundo cerebro (vault Obsidian, plugin obsidian-second-brain v0.15.0)
  ├── index.md (dos saltos a cualquier hub)
  ├── Career/            perfil, experiencia, skills, educación
  ├── Job Search/        Job Matches.md, estrategias, reportes por ciclo
  ├── Market Intelligence/  skills, compensación, empresas
  ├── Research/          salidas de /research
  └── Logs/YYYY-MM-DD.md log de operaciones

SQLite (data/jobhunt.db, WAL)
  sources · companies · jobs · job_versions · skills · skill_aliases · job_skills
  compensation_observations · candidate_profile · candidate_skills · candidate_preferences
  job_matches · search_runs · run_source_results · run_errors · applications
  application_events · company_research · market_snapshots · run_locks · system_state
```

### Qué vive dónde

| Información | Dónde | Por qué |
|---|---|---|
| Vacantes, versiones, duplicados, skills por vacante, compensación, matches, ejecuciones, aplicaciones y sus eventos, estadísticas | SQLite | transaccional, idempotente, consultable, histórico |
| Perfil narrativo, experiencia con cifras, criterios, estrategia, conocimiento de empresas, aprendizajes, reportes | Vault | contexto cualitativo, navegable por humanos y agentes, mantenido por obsidian-second-brain |
| Campos normalizados del perfil (seniority, años, skills con nivel, preferencias, restricciones duras) | SQLite (`candidate_*`) con `vault_note` apuntando a la nota | scoring determinista sin releer Markdown |
| Configuración (horarios, pesos, umbrales, límites, fuentes, rate limits) | `config/jobhunt.yaml` | fuera del código |
| Secretos | `.env` / secret manager | nunca en SQLite, Markdown, logs ni git |

## 3. Reutilización de obsidian-second-brain

Se instaló como plugin de Claude Code (marketplace `eugeniughelbur/obsidian-second-brain`, scope user). Se usan tal cual: los 47 comandos (`/obsidian-init`, `/obsidian-save`, `/obsidian-find`, `/obsidian-world`, `/obsidian-reconcile`, `/obsidian-health`, `/research`, `/research-deep`...), sus hooks (contexto de sesión, validador AI-first en cada escritura, agente de fondo opcional), su servidor MCP `vault`, sus reglas de escritura (`references/ai-first-rules.md`, `freshness-policy.md`, `folder-map.md`) y su bootstrap de vault (`scripts/bootstrap_vault.py`, preset `builder`).

Lo único que se añadió, de forma compatible: `scripts/init-vault.mjs`, que crea la estructura Career / Job Search / Market Intelligence, `index.md`, `log.md` + `Logs/`, `CRITICAL_FACTS.md` y una sección gestionada en `_CLAUDE.md` y `Home.md` (nunca sobrescribe notas existentes). No se reimplementó ninguna capacidad del plugin.

## 4. Servidor MCP `jobhunt-db`

`src/mcp/server.ts` (stdio, registrado en `.mcp.json` como `node dist/mcp/server.js`). No expone SQL. Herramientas tipadas con zod, todas con inputs validados, queries parametrizadas, transacciones e idempotencia:

- Vacantes: `search_jobs`, `get_job`, `create_job` (normaliza + deduplica + registra salario explícito), `update_job`, `get_jobs_pending_analysis`.
- Empresas: `get_company`, `create_company`, `update_company`.
- Skills: `search_skills`, `create_skill`, `record_job_skill`, `get_job_skills`, `get_skill_market_demand`, `get_skill_cooccurrence`, `get_candidate_skill_gaps`.
- Compensación: `record_compensation`, `get_compensation_statistics` (explícita y esperada siempre separadas).
- Perfil: `get_candidate_profile`, `update_candidate_profile`, `set_candidate_skill`, `remove_candidate_skill`, `set_candidate_preference`.
- Matching: `calculate_job_match`, `get_job_match`, `get_matching_jobs`.
- Ejecuciones: `create_search_run` (lock + recuperación + slot), `heartbeat_search_run`, `update_search_run`, `complete_search_run`, `get_search_run`, `list_search_runs`, `record_run_error`, `record_source_result`, `get_schedule_status`, `get_system_state`, `set_system_state`.
- Aplicaciones: `record_application`, `get_application`, `update_application`, `record_application_event` (máquina de estados), `get_application_candidates`, `check_can_submit`, `list_applications`, `get_application_statistics`, `mark_no_response`.
- Investigación: `record_company_research`, `get_company_research`, `get_companies_needing_research`.
- Mercado: `get_source_statistics`, `get_market_statistics`, `save_market_snapshot`, `get_market_snapshots`.
- Sistema: `list_sources`, `get_config`.

## 5. Módulos núcleo (`src/core`)

- `normalize.ts` - normalización de vacantes: URL canónica (sin parámetros de tracking), título y empresa normalizados, inferencia de modalidad/seniority/tipo, HTML a texto, `content_hash` (detección de cambios) y `dedup_key` (empresa + título; URL canónica como respaldo).
- `scoring.ts` - scoring explicable con 11 factores y pesos configurables renormalizados sobre los factores aplicables; restricciones duras (salario mínimo, modalidad, país, idioma, autorización laboral, tecnología esencial, tipo de contrato) que descartan aunque el score sea alto; fortalezas, riesgos e información faltante.
- `state-machine.ts` - estados y transiciones válidas de una aplicación (`DISCOVERED → MATCHED → SELECTED → PREPARING → READY → SUBMITTING → SUBMITTED` + `REJECTED`, `SKIPPED`, `REQUIRES_USER_INPUT`, `FAILED`, `BLOCKED`, `EXPIRED`, `WITHDRAWN` y el embudo posterior `RESPONSE_RECEIVED`, `INTERVIEW`, `OFFER`, `ACCEPTED`, `DECLINED`, `NO_RESPONSE`).
- `lock.ts` - lock/lease persistente en SQLite con TTL y heartbeat; un lock vencido se considera ejecución muerta.
- `run-manager.ts` - inicio de ciclo: calcula el slot pendiente en la zona horaria configurada, adquiere el lock (o registra el ciclo como `skipped` por solapamiento), recupera ejecuciones interrumpidas (`SUBMITTING → REQUIRES_USER_INPUT`, `PREPARING → FAILED`, run → `interrupted`) y crea el run (idempotente por `run_key`).
- `time.ts` - slots de horario con `Intl` (sin dependencias), grace window configurable.
- `ingest.ts` - normaliza + upsert + registra compensación explícita de la publicación.

## 6. Fuentes (`src/sources`)

Arquitectura de adapters `JobSource { key, fetch, verify?, submit? }` con cliente HTTP por fuente (rate limiter por segundo/minuto/hora + concurrencia, reintentos con backoff exponencial y `Retry-After`). Implementados: Remotive (API pública), Remote OK (feed JSON), Arbeitnow (API), Hacker News "Who is hiring" (API Algolia), We Work Remotely (RSS), Himalayas (API), tableros ATS públicos Greenhouse / Lever / Ashby (tokens por empresa en config) y career sites alojados en Workday (JSON público, por tenant). LinkedIn e Indeed están `blocked`: nunca se consultan ni se automatizan. `submit` solo existirá para fuentes cuya API oficial permita enviar aplicaciones de terceros (Fase 7); hasta entonces todas son `discover_only` y el resultado es un hand-off manual.

## 7. Pipeline por ciclo (skill `jobhunt-run`)

`load_state → load_candidate_context → discover_jobs → normalize → deduplicate → extract_skills → extract_compensation → score_jobs → research_companies → select_applications → prepare_applications → submit_applications → record_results → update_market_intelligence → update_second_brain → generate_report → persist_state`.

Cada etapa se registra en `search_runs.current_stage`; cada fuente en `run_source_results`; cada error en `run_errors`. La pregunta "¿qué hizo el agente hoy a las 13:00?" se responde con `npm run jobhunt -- run:show --id 2026-09-05T13:00` sin historial de conversación.

## 8. Recurrencia

`/loop /jobhunt-run` en una sesión de Claude Code: el agente, al terminar un ciclo, consulta `get_schedule_status` y programa su siguiente despertar (máximo 1 h). `create_search_run` solo inicia si hay un slot pendiente (Lun-Vie 07:00 / 13:00 / 19:00 America/Chihuahua, configurable) y no hay lock activo; los solapes se registran como `skipped`. Para VPS: `deploy/jobhunt.timer` + `deploy/run-cycle.sh` (`claude -p` leyendo la skill), o `/loop` dentro de tmux.

## 9. Idempotencia y recuperación

- Misma vacante dos veces → un registro (identidad por `source + external_id` o `source + url canónica`; duplicados entre fuentes se enlazan con `duplicate_of_job_id`).
- Misma aplicación dos veces → una (`applications.job_id UNIQUE`, `record_application` devuelve la existente).
- Antes de enviar: `check_can_submit` verifica aplicación no enviada, vacante activa, política de la fuente, cupo por fuente y ejecución (3), score/elegibilidad y CV seleccionado.
- Al iniciar: runs en `running` se marcan `interrupted`; aplicaciones en `SUBMITTING` pasan a `REQUIRES_USER_INPUT` (nunca se reenvían a ciegas).

## 10. Seguridad y cumplimiento

Sin evasión de CAPTCHA, bot detection, rate limits, login ni términos de servicio. Contenido externo = datos no confiables (las skills lo repiten explícitamente). Secretos solo en `.env`. Operaciones destructivas requieren instrucción explícita. Historial (versiones, eventos, errores) append-only.

## 11. Fases

| Fase | Estado | Contenido |
|---|---|---|
| 1 Infraestructura | hecha | repo, config, SQLite + migraciones, MCP, logging, lock, tests, despliegue, vault |
| 2 Perfil | hecha (entrevista 2026-09-05) | skill `jobhunt-interview`, persistencia vault + SQLite |
| 3 Descubrimiento | hecha (9 fuentes activas) | adapters + `discover` CLI; se activa tras la entrevista |
| 4 Análisis + scoring | hecha (umbral 70, fx_rates, rescore CLI) | `analyze-job`, `score-job`, `calculate_job_match` |
| 5 Investigación | hecha (company_research con niveles de evidencia) | `research-company` + `/research` |
| 6 Preparación | hecha (paquetes de aplicación en el vault, hand-off manual, códigos VAC-run.job) | `prepare-application` |
| 7 Envío permitido | pendiente | adapters `submit` para fuentes que lo permitan oficialmente |
| 8 Market intelligence | hecha (snapshots por ciclo) | estadísticas, snapshots, `market-analysis` |
| 9 Mantenimiento autónomo | hecha | `maintain-job-system`, vault health/reconcile |

## 12. Riesgos conocidos

- Las APIs públicas cambian de forma sin aviso: los adapters están aislados y un fallo no detiene el ciclo.
- Pocas fuentes permiten envío automático legítimo: el valor principal está en descubrimiento, scoring y preparación; el envío será hand-off en la mayoría de los casos.
- Estimaciones de compensación: siempre etiquetadas `expected` con confianza y metodología; no se mezclan con datos publicados.
- `claude -p` no expande slash commands: `run-cycle.sh` entrega el archivo de la skill directamente.
- `better-sqlite3` es un módulo nativo: en el VPS se compila o usa prebuild para la versión de Node instalada.
