# syntax=docker/dockerfile:1
#
# Multi-stage image for the walking skeleton (FND-07). Both stages pin the
# same base image family by tag and digest (research Pitfall 12). The build
# stage needs no secret: `npm run build` (rsbuild build) opens no database and
# reads no BETTER_AUTH_SECRET (src/app/server/auth.ts builds its options lazily).
#
# The server bundle keeps better-sqlite3 and takumi-pdf external (they load a
# native binding and a WASM file from their own package), so the runtime stage
# takes the build stage's node_modules after `npm prune --omit=dev`; the native
# binding fetched by `npm ci` is reused, not rebuilt.
#
# The better-sqlite3 binding must be the published prebuilt for this
# architecture, checked by sha256 right after `npm ci` below (linux-arm64 and
# linux-x64). If `npm ci` cannot fetch it, the build fails; the remedy is a
# retry, never a source build (nodejs/node#65446: a binding built against
# Node >= 24.19.0 headers aborts in GC).

FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY docker/better-sqlite3 ./docker/better-sqlite3
RUN npm ci
RUN sha256sum -c "docker/better-sqlite3/linux-$(node -p process.arch).sha256"
COPY rsbuild.config.ts postcss.config.mjs tsconfig.json ./
COPY scripts/check-data-dir.mjs ./scripts/check-data-dir.mjs
# src/pipeline/select imports the robots-first preflight from the spike script.
COPY scripts/spikes/pick-projects.mjs ./scripts/spikes/pick-projects.mjs
COPY scripts/spikes/lib/preflight.mjs scripts/spikes/lib/paths.mjs ./scripts/spikes/lib/
COPY src ./src
# /office: the four pinned editors and the four findings files, each checked against a pinned SHA-256
# before it is written to public/ (python3 unpacks the editor ZIPs only).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY office-apps.lock.json ./
COPY scripts/prepare-office-apps.mjs ./scripts/prepare-office-apps.mjs
COPY site/downloads.sha256 ./site/downloads.sha256
RUN node scripts/prepare-office-apps.mjs
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# The vendored gate's own Python runtime, isolated in its own venv (research
# Pitfall 4). No secret is set or read here either.
COPY requirements-gate.txt ./
RUN python3 -m venv /opt/gate \
 && /opt/gate/bin/pip install --no-cache-dir -r requirements-gate.txt

COPY vendor/ai-output-to-value ./vendor/ai-output-to-value
# Read at request time from the working directory: /review and /method load the codebook and gap text.
COPY codebook.md ./codebook.md
COPY protocol/gap-text.json ./protocol/gap-text.json
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/serve.mjs ./scripts/serve.mjs

RUN mkdir /data && chown node:node /data

ENV NODE_ENV=production
ENV PORT=3000
ENV PRISM_DATA_DIR=/data
ENV PRISM_PYTHON=/opt/gate/bin/python

USER node
EXPOSE 3000
CMD ["node", "scripts/serve.mjs"]
