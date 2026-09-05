# Autonomous Job Hunter runtime image: Node 24 + uv/Python (obsidian-second-brain) + Claude Code.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive TZ=America/Chihuahua
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates python3 tmux \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | sh \
 && npm install -g @anthropic-ai/claude-code

ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY config ./config
COPY src ./src
COPY .claude ./.claude
COPY .mcp.json ./
COPY deploy/run-cycle.sh ./deploy/run-cycle.sh
COPY scripts ./scripts
RUN npm run build && chmod +x deploy/run-cycle.sh scripts/*.sh

# Runtime state is mounted: data/ (SQLite), logs/, vault/, and ~/.claude for Claude Code auth + plugin.
VOLUME ["/app/data", "/app/logs", "/app/vault", "/root/.claude"]

# Install the obsidian-second-brain plugin at first start if missing, then run one cycle.
ENTRYPOINT ["bash", "-lc", "scripts/ensure-second-brain.sh && deploy/run-cycle.sh ${TRIGGER:-scheduled}"]
