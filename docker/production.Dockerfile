# syntax=docker/dockerfile:1.7
#
# Production images for FactorSage (`docs/production/RUNBOOK.md`): one build stage, and one runtime
# target per process — `api`, `worker`, `web` — plus `migrate`, the one-shot schema job a deploy runs
# before anything else starts.
#
#   docker build -f docker/production.Dockerfile --target api    -t factorsage/api:$REV .
#   docker build -f docker/production.Dockerfile --target worker -t factorsage/worker:$REV .
#   docker build -f docker/production.Dockerfile --target web    -t factorsage/web:$REV \
#     --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.factorsage.example .
#   docker build -f docker/production.Dockerfile --target migrate -t factorsage/migrate:$REV .
#
# What differs from the development images in `docker/*.Dockerfile`:
# - the runtime stages run as the unprivileged `node` user and start `node` directly — never pnpm —
#   so SIGTERM reaches the process that handles it (the worker supervisor releases its claims on it);
# - devDependencies are pruned from the runtime stages, and no source, test or `.env` is copied in;
# - secrets are never build arguments: every one is runtime environment, read at process start.
#
# Builds behind a TLS-intercepting proxy may pass its CA as a BuildKit secret
# (`--secret id=build_ca,src=/path/ca.pem`); it is used for the install only and never lands in an
# image layer.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /repo
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false

# The lockfile alone decides what is fetched, so this layer is reused until a dependency changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm fetch --frozen-lockfile

COPY . .
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --frozen-lockfile --offline
# The Prisma client is generated explicitly, as CI does: install scripts do not find a workspace
# package's schema. The query engine for this image's platform is downloaded here.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm db:generate

# The public API URL is compiled into the browser bundle (see docker/web.Dockerfile); the web target
# refuses to build a release without one.
ARG NEXT_PUBLIC_API_BASE_URL=""
ARG FACTORSAGE_RELEASE_BUILD=true
ARG BUILD_WEB=true
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    FACTORSAGE_RELEASE_BUILD=$FACTORSAGE_RELEASE_BUILD

RUN pnpm --filter "@intrinsic/api..." --filter "@intrinsic/worker..." build
# The web build downloads its fonts (next/font), so it may need the same optional build CA.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    if [ "$BUILD_WEB" = "true" ]; then pnpm --filter "@intrinsic/web..." build; fi

# The schema job keeps the Prisma CLI; the runtime stages do not need it.
FROM build AS migrate
USER node
WORKDIR /repo/packages/database
CMD ["node", "./scripts/prisma-command.mjs", "migrate", "deploy"]

# Everything a runtime stage copies: built output and production dependencies only.
FROM build AS pruned
RUN pnpm prune --prod --config.ignore-scripts=true \
 && rm -rf /root/.cache /root/.local/share/pnpm /repo/.git \
 && find /repo/apps /repo/packages -name "*.test.*" -delete \
 && find /repo/apps /repo/packages -type d \( -name "__tests__" -o -name "e2e" -o -name "coverage" \) -prune -exec rm -rf {} +

FROM ${NODE_IMAGE} AS runtime
# No init binary is baked in: run with Docker's own (`init: true` in compose, `--init` for
# `docker run`), which forwards signals and reaps children. Each Node entry point also handles
# SIGTERM itself, so it shuts down gracefully even as PID 1.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY --from=pruned --chown=node:node /repo /repo
USER node

FROM runtime AS api
WORKDIR /repo/apps/api
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM runtime AS worker
WORKDIR /repo/apps/worker
# No port: the worker serves nothing. Liveness is the supervisor's own process; its children are
# restarted by it with backoff, and a supervisor crash exits the container for the restart policy.
CMD ["node", "dist/index.js"]

FROM runtime AS web
WORKDIR /repo/apps/web
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
