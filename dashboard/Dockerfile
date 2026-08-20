FROM node:20-alpine AS builder

WORKDIR /app

# Salin file konfigurasi dependensi
COPY package*.json ./
COPY dashboard/package*.json ./dashboard/

# Instal dependensi
RUN cd dashboard && npm install

# Salin kode sumber
COPY dashboard/ ./dashboard/

# Build Next.js app
RUN cd dashboard && npm run build

# --- Stage 2: Production ---
FROM node:20-alpine AS runner

WORKDIR /app

# Set env ke production
ENV NODE_ENV=production

# Salin file yang dibutuhkan dari stage builder
COPY --from=builder /app/dashboard/next.config.mjs ./dashboard/
COPY --from=builder /app/dashboard/public ./dashboard/public
COPY --from=builder /app/dashboard/.next ./dashboard/.next
COPY --from=builder /app/dashboard/node_modules ./dashboard/node_modules
COPY --from=builder /app/dashboard/package.json ./dashboard/

# Ekspos port
EXPOSE 3000

# Start server Next.js
CMD ["npm", "run", "start", "--prefix", "dashboard"]
