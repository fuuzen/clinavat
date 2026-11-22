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
ARG ANTIGRAVITY_RELEASE=1.5.14-5302690847260672
ARG ANTIGRAVITY_SHA512_AMD64=83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9
ARG ANTIGRAVITY_SHA512_ARM64=c9b29bba475f63a1a80161ae93ba72b221c7a586d9851e4d0061546704bab66d6b2760b25d716d191724fc7564f3246456ee151e28aa37af48dbcd72bdc6c463
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git openssh-client ripgrep bubblewrap xz-utils util-linux python3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force
RUN set -eu; case "$TARGETARCH" in amd64|arm64) ;; *) exit 1 ;; esac; \
    asset="mutagen_linux_${TARGETARCH}_v${MUTAGEN_VERSION}.tar.gz"; \
    url="https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}"; \
    cd /tmp; curl -fsSLO "$url/$asset"; curl -fsSLO "$url/SHA256SUMS"; \
    grep " $asset\$" SHA256SUMS > mutagen-checksum; sha256sum -c mutagen-checksum; \
    tar -xzf "$asset" -C /usr/local/bin mutagen mutagen-agents.tar.gz; rm -f "$asset" SHA256SUMS mutagen-checksum
RUN set -eu; case "$TARGETARCH" in \
      amd64) asset=linux-x64/cli_linux_x64.tar.gz; sum="$ANTIGRAVITY_SHA512_AMD64" ;; \
      arm64) asset=linux-arm/cli_linux_arm64.tar.gz; sum="$ANTIGRAVITY_SHA512_ARM64" ;; *) exit 1 ;; esac; \
    cd /tmp; curl -fsSL -o agy.tar.gz "https://storage.googleapis.com/antigravity-public/antigravity-cli/${ANTIGRAVITY_RELEASE}/$asset"; \
    echo "$sum  agy.tar.gz" | sha512sum -c -; tar -xzf agy.tar.gz antigravity; \
    install -m 0755 antigravity /usr/local/bin/agy; rm -f agy.tar.gz antigravity
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace backend && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
RUN mkdir -p /srv/clinavat /var/tmp/clinavat-workspace \
    && chown node:node /srv/clinavat /var/tmp/clinavat-workspace
USER node
ENV NODE_ENV=production CLINAVAT_DATA_DIR=/srv/clinavat CLINAVAT_WORKSPACE_DIR=/var/tmp/clinavat-workspace CLINAVAT_HOST=0.0.0.0 CLINAVAT_PORT=3001
EXPOSE 3001
CMD ["node", "backend/dist/server.js"]

FROM docker.io/library/nginx:1.28-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
