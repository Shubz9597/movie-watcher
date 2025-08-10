# Build stage
FROM node:20-alpine AS builder
# Fix sharp/Next image deps on Alpine
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install deps (needs package-lock.json present)
COPY package.json package-lock.json ./
RUN npm ci

# Build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# Run stage
FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

# Copy the standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]