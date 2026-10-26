FROM docker.io/library/node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY backend backend
COPY frontend frontend
RUN npm run build

FROM docker.io/library/node:22.23.4-bookworm-slim AS hub
ARG TARGETARCH
ARG CLAUDE_CODE_VERSION=2.1.308
ARG CODEX_VERSION=0.164.0
ARG MUTAGEN_VERSION=0.18.1
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git openssh-client ripgrep bubblewrap xz-utils util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force
RUN set -eu; case "$TARGETARCH" in amd64|arm64) ;; *) exit 1 ;; esac; \
    asset="mutagen_linux_${TARGETARCH}_v${MUTAGEN_VERSION}.tar.gz"; \
    url="https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}"; \
    cd /tmp; curl -fsSLO "$url/$asset"; curl -fsSLO "$url/SHA256SUMS"; \
    grep " $asset\$" SHA256SUMS > mutagen-checksum; sha256sum -c mutagen-checksum; \
    tar -xzf "$asset" -C /usr/local/bin mutagen mutagen-agents.tar.gz; rm -f "$asset" SHA256SUMS mutagen-checksum
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace backend && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
RUN mkdir -p /srv/pool && chown node:node /srv/pool
USER node
ENV NODE_ENV=production CC_POOL_DATA_DIR=/srv/pool CC_POOL_HOST=0.0.0.0 CC_POOL_PORT=3001
EXPOSE 3001
CMD ["node", "backend/dist/server.js"]

FROM docker.io/library/nginx:1.28-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
