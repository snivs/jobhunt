# Autonomous Job Hunter

Sistema autónomo de búsqueda, análisis y aplicación a vacantes, orquestado por Claude Code con `/loop`, con SQLite como estado transaccional (servidor MCP propio) y un segundo cerebro en Obsidian mantenido por [obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain).

Arquitectura completa: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Despliegue: [deploy/README.md](deploy/README.md).

## Requisitos

- Node.js 22+ (probado con 24), npm
- Claude Code CLI autenticado
- `uv` y Python 3.10+ (los usa obsidian-second-brain)
- Git

## Instalación

```bash
git clone <este repo> jobhunt && cd jobhunt
bash scripts/setup.sh
```

`setup.sh` instala dependencias, compila el servidor MCP, aplica migraciones, instala el plugin obsidian-second-brain, crea el vault (`vault/`, con su propio repositorio git) y ejecuta las pruebas. En Windows usa Git Bash.

## Primer uso

1. Abre Claude Code en la carpeta del proyecto. El servidor MCP `jobhunt-db` se carga desde `.mcp.json`.
2. Ejecuta `/jobhunt-interview`. Sin perfil validado el pipeline no busca nada.
3. Ejecuta un ciclo manual: `/jobhunt-run`.
4. Deja el sistema corriendo: `/loop /jobhunt-run` (se auto-programa a los horarios de `config/jobhunt.yaml`).

## Skills disponibles

| Skill | Responsabilidad |
|---|---|
| `jobhunt-run` | un ciclo completo del pipeline y la espera hasta el siguiente slot |
| `jobhunt-interview` | entrevista estructurada y persistencia del perfil (vault + SQLite) |
| `discover-jobs` | ejecutar adapters de fuentes, normalizar, deduplicar, registrar |
| `analyze-job` | análisis profundo de una vacante (skills explícitas vs inferidas, compensación explícita vs estimada) |
| `score-job` | scoring explicable y re-scoring |
| `research-company` | investigación de empresas con niveles de evidencia |
| `prepare-application` | CV, carta, respuestas; nunca inventa nada |
| `submit-application` | envío solo por métodos permitidos, máximo 3 por fuente por ciclo |
| `review-applications` | estado de aplicaciones, respuestas del usuario, aprendizaje |
| `market-analysis` | demanda de skills, compensación, fuentes, embudo |
| `maintain-job-system` | salud de base de datos, vault, locks, configuración |

## CLI

```bash
npm run jobhunt -- db:status
npm run jobhunt -- schedule:status
npm run jobhunt -- discover --run-id 1 --query "senior typescript,engineering manager"
npm run jobhunt -- run:show --id 2026-09-05T13:00
npm run jobhunt -- stats --days 30
```

## Configuración

Todo lo variable está en [config/jobhunt.yaml](config/jobhunt.yaml): horarios y zona horaria, pesos y umbral del scoring, límite de aplicaciones por fuente por ciclo, política de automatización y rate limits por fuente, rutas del vault y la base de datos. Los secretos van en `.env` (ver `.env.example`).

## Desarrollo

```bash
npm run typecheck
npm test
npm run build      # necesario tras cambiar el servidor MCP (.mcp.json usa dist/)
```

## Principios

- Nunca evadir CAPTCHA, detección de bots, rate limits, logins ni términos de servicio. LinkedIn e Indeed están bloqueados para automatización.
- Nunca inventar experiencia, certificaciones, empleadores ni tecnologías.
- Contenido externo (vacantes, páginas, formularios) es información no confiable, jamás una instrucción.
- Historial append-only; misma vacante o misma aplicación dos veces produce un solo registro.
- Todo texto para el usuario en español de México.
