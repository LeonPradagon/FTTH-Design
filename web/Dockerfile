FROM node:20-alpine AS builder

WORKDIR /app/web

# Salin file konfigurasi dependensi
COPY web/package*.json ./

# Instal dependensi
RUN npm ci

# Salin kode sumber dan build Next.js
COPY web/ ./
RUN npm run build

# --- Stage 2: Production ---
FROM node:20-alpine AS runner

WORKDIR /app/web

# Set env ke production
ENV NODE_ENV=production

# Salin file yang dibutuhkan dari stage builder
COPY --from=builder /app/web/next.config.ts ./
COPY --from=builder /app/web/public ./public
COPY --from=builder /app/web/.next ./.next
COPY --from=builder /app/web/node_modules ./node_modules
COPY --from=builder /app/web/package.json ./

# Ekspos port
EXPOSE 3000

# Start server Next.js
CMD ["npm", "run", "start"]
