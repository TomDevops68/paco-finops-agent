# syntax=docker/dockerfile:1
# Two-stage build: compile the whole monorepo (this app plus every
# `packages/*` it imports via relative paths), then run on a fresh
# production-only `node_modules` so the final image never carries devDeps
# (aws-cdk, eslint, vitest, ...) or the CDK app itself.

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json tsconfig.build.json ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --prod --frozen-lockfile

COPY --from=build /repo/dist ./dist

# The Agent SDK spawns the bundled Claude CLI as a subprocess; give it a
# stable, writable config directory scoped to this task. Durable recovery
# comes from the external SessionStore (S3/DynamoDB), not this ephemeral
# local directory.
ENV CLAUDE_CONFIG_DIR=/repo/.claude-runtime
ENV CLAUDE_CODE_PROJECT_DIR_NAME=cost-agent
RUN mkdir -p /repo/.claude-runtime /tmp/cost-workspace && \
    addgroup --system --gid 1001 worker && \
    adduser --system --uid 1001 --gid 1001 worker && \
    chown -R worker:worker /repo/.claude-runtime /tmp/cost-workspace

USER worker
ENTRYPOINT ["node", "dist/apps/agent-worker/src/main.js"]
