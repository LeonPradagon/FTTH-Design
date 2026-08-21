FROM node:20-alpine AS builder

WORKDIR /workspace/app/web

# Salin file konfigurasi dependensi
COPY app/web/package*.json ./

# Instal dependensi
RUN npm ci

# Salin kode sumber dan build Next.js
COPY app/web/ ./
RUN npm run build

# --- Stage 2: Production ---
FROM node:20-alpine AS runner

WORKDIR /workspace/app/web

# Set env ke production
ENV NODE_ENV=production

# Salin file yang dibutuhkan dari stage builder
COPY --from=builder /workspace/app/web/next.config.ts ./
COPY --from=builder /workspace/app/web/public ./public
COPY --from=builder /workspace/app/web/.next ./.next
COPY --from=builder /workspace/app/web/node_modules ./node_modules
COPY --from=builder /workspace/app/web/package.json ./

# Ekspos port
EXPOSE 3000

# Start server Next.js
CMD ["npm", "run", "start"]
