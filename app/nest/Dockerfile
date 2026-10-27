FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /workspace/app/nest

FROM base AS dependencies
COPY app/nest/package.json app/nest/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY app/nest/ ./
RUN pnpm build

FROM build AS migrate
CMD ["pnpm", "exec", "drizzle-kit", "migrate"]

FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=8001
WORKDIR /workspace/app/nest
COPY --from=build /workspace/app/nest/node_modules ./node_modules
COPY --from=build /workspace/app/nest/dist ./dist
COPY --from=build /workspace/app/nest/drizzle ./drizzle
COPY --from=build /workspace/app/nest/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /workspace/app/nest/package.json ./package.json
EXPOSE 8001
CMD ["node", "dist/src/main.js"]
