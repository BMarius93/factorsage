FROM node:22-alpine

RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @intrinsic/api... build

EXPOSE 3001
CMD ["pnpm", "--filter", "@intrinsic/api", "start:prod"]
