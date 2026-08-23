FROM node:20-alpine AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PUPPETEER_SKIP_DOWNLOAD=true

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /workspace/app/web

FROM base AS dependencies

RUN chown node:node /workspace/app/web
USER node
COPY --chown=node:node app/web/package.json app/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS migrate

COPY --chown=node:node app/server/schema.prisma ./schema.prisma
RUN pnpm exec prisma generate --generator js_client --schema ./schema.prisma

CMD ["pnpm", "exec", "prisma", "db", "push", "--schema", "/workspace/app/web/schema.prisma", "--skip-generate"]

FROM dependencies AS builder

COPY app/server/schema.prisma ./schema.prisma
RUN pnpm exec prisma generate --generator js_client --schema ./schema.prisma
COPY app/web/ ./
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-only-secret-that-is-at-least-32-characters \
    BETTER_AUTH_URL=http://localhost:3000 \
    FTTH_SERVER_URL=http://server:8000 \
    pnpm exec next build --webpack

FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN apk add --no-cache libc6-compat openssl \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S app -G app

WORKDIR /workspace/app/web
COPY --from=builder --chown=app:app /workspace/app/web/.next/standalone ./
COPY --from=builder --chown=app:app /workspace/app/web/.next/static ./.next/static
COPY --from=builder --chown=app:app /workspace/app/web/public ./public

USER app
EXPOSE 3000

CMD ["node", "server.js"]
