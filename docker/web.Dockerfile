FROM node:22-alpine

RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @intrinsic/web build

EXPOSE 3000
CMD ["pnpm", "--filter", "@intrinsic/web", "start"]
