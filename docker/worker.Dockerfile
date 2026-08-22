FROM node:22-alpine

RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @intrinsic/worker build

CMD ["pnpm", "--filter", "@intrinsic/worker", "start"]
