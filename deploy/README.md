# Despliegue en VPS

El sistema corre en un VPS Linux con esta forma:

```
VPS
 ├── Claude Code (CLI, autenticado con la cuenta del usuario)
 ├── plugin obsidian-second-brain (scope user)
 ├── /srv/jobhunt            <- este repositorio (dist/ compilado)
 │    ├── vault/             <- vault de Obsidian (repo git propio)
 │    ├── data/jobhunt.db    <- SQLite (fuente de verdad transaccional)
 │    ├── logs/              <- JSONL por dia
 │    └── config/jobhunt.yaml
 └── systemd: jobhunt.service + jobhunt.timer
```

Hay dos formas de ejecutar el pipeline de manera recurrente. Ambas usan la misma logica
(skill `jobhunt-run`), el mismo lock persistente en SQLite y el mismo calendario de `config/jobhunt.yaml`.

## Opcion A - `/loop` en una sesion interactiva persistente (recomendada para desarrollo)

```bash
cd /srv/jobhunt
tmux new -s jobhunt
claude
# dentro de Claude Code:
/loop /jobhunt-run
```

`/loop` sin intervalo deja que el agente se auto-programe: al terminar cada ciclo consulta
`get_schedule_status` y duerme hasta el siguiente slot (maximo 1 hora entre despertares).
Si la sesion muere, el estado esta en SQLite y el vault; al reiniciar, el primer ciclo recupera
cualquier ejecucion interrumpida.

## Opcion B - systemd timer + `claude -p` (recomendada para produccion)

Los slash commands NO se expanden en modo no interactivo, por eso `run-cycle.sh` le pide a Claude
que lea el archivo de la skill y ejecute sus instrucciones.

```bash
sudo cp deploy/jobhunt.service deploy/jobhunt.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jobhunt.timer
systemctl list-timers jobhunt.timer
journalctl -u jobhunt.service -f
```

El timer dispara a las 07:00, 13:00 y 19:00 (zona horaria del servicio = America/Chihuahua) de
lunes a viernes. Si cambias el horario en `config/jobhunt.yaml`, cambia tambien `OnCalendar` en
`jobhunt.timer` (o usa la opcion A, que lee el YAML directamente). Aunque el timer dispare, el
pipeline solo corre si `create_search_run` confirma que el slot esta pendiente y no hay otro
ciclo activo (lock).

## Docker

```bash
docker build -t jobhunt -f deploy/Dockerfile .
docker run --rm -it \
  -v $PWD/data:/app/data -v $PWD/logs:/app/logs -v $PWD/vault:/app/vault \
  -v $HOME/.claude:/root/.claude \
  --env-file .env jobhunt
```

La imagen contiene Node, uv/Python (para obsidian-second-brain) y Claude Code. La autenticacion de
Claude Code se monta desde `~/.claude`. Nunca copies `.env` ni `~/.claude` dentro de la imagen.

## Primer arranque en un VPS nuevo

```bash
bash scripts/setup.sh /srv/jobhunt
```

Ese script instala dependencias, compila, aplica migraciones, instala el plugin
obsidian-second-brain, crea el vault si no existe y verifica el servidor MCP.

## Seguridad

- Secretos solo en `.env` (permisos 600) o en el secret manager del VPS; nunca en SQLite, Markdown, logs ni git.
- El usuario de sistema `jobhunt` no necesita sudo. `ProtectSystem=strict` en el service limita la escritura a `/srv/jobhunt`.
- Copias de seguridad: `npm run jobhunt -- db:backup` (usa la API de backup en linea de SQLite) y `git` en el vault.
