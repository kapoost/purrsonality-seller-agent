# syntax=docker/dockerfile:1.7
# Bun-native AdCP seller agent. Multi-stage: install (cache deps) → run.
# Target: Cloud Run / Fly.io / k8s — infrastructure-agnostic.

FROM oven/bun:1.3.14-alpine AS install
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

# Non-root user (Cloud Run/k8s best practice — no UID 0 in container).
RUN addgroup -S adcp && adduser -S -G adcp -u 10001 adcp

# Copy node_modules from install stage (frozen lockfile, prod-only).
COPY --from=install --chown=adcp:adcp /app/node_modules ./node_modules

# App code (compiled-as-you-run via Bun — no separate build step).
COPY --chown=adcp:adcp package.json bun.lock tsconfig.json ./
COPY --chown=adcp:adcp src ./src

USER adcp

# Cloud Run sets PORT env automatically; honor it. Default 8080 for non-CR hosts.
ENV PORT=8080 \
    NODE_ENV=production

EXPOSE 8080

# No HEALTHCHECK in Dockerfile — Cloud Run uses startup/liveness probes,
# k8s uses readinessProbe in manifest. Both work better than HEALTHCHECK
# which has no orchestrator integration.

CMD ["bun", "run", "src/index.ts"]
