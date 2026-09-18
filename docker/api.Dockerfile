FROM node:22-alpine

RUN corepack enable
WORKDIR /repo

COPY . .
# Corepack runs the pnpm version pinned by `packageManager`; the install fails if pnpm-lock.yaml is
# out of step with any package.json, so the image carries exactly the reviewed dependency graph.
RUN pnpm install --frozen-lockfile

RUN pnpm --filter @intrinsic/api... build

EXPOSE 3001
CMD ["pnpm", "--filter", "@intrinsic/api", "start:prod"]
