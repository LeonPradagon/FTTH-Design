FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /workspace/app/server

FROM base AS dependencies
COPY app/server/package.json app/server/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY app/server/ ./
RUN pnpm build

FROM build AS migrate
CMD ["pnpm", "exec", "drizzle-kit", "migrate"]

FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=8001
WORKDIR /workspace/app/server
COPY --from=build /workspace/app/server/node_modules ./node_modules
COPY --from=build /workspace/app/server/dist ./dist
COPY --from=build /workspace/app/server/drizzle ./drizzle
COPY --from=build /workspace/app/server/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /workspace/app/server/package.json ./package.json
EXPOSE 8001
CMD ["node", "dist/src/main.js"]
