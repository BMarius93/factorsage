FROM node:22-alpine

RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --no-frozen-lockfile

# The public API URL is compiled into the browser bundle, so it is a build argument, not runtime
# configuration: `docker build --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com`.
# This image is a release build by default, and `next.config.ts` then refuses to compile when the
# URL is missing, not https, or loopback (see apps/web/src/lib/release-build.ts). Only a local stack
# that really serves the API on localhost opts out, with FACTORSAGE_RELEASE_BUILD=false. Never
# pass a secret here: every NEXT_PUBLIC_* value is readable by any visitor.
ARG NEXT_PUBLIC_API_BASE_URL
ARG FACTORSAGE_RELEASE_BUILD=true
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    FACTORSAGE_RELEASE_BUILD=$FACTORSAGE_RELEASE_BUILD

# `...` builds the workspace packages the web app imports first, as the API and worker images do;
# they resolve to their `dist/`, which the build context never contains.
RUN pnpm --filter @intrinsic/web... build

EXPOSE 3000
CMD ["pnpm", "--filter", "@intrinsic/web", "start"]
