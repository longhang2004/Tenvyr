# Base node image
FROM node:22-alpine AS base
RUN npm install -g pnpm@9.0.0
WORKDIR /usr/src/app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile --filter frontend...

# Development stage
FROM base AS development
ENV NODE_ENV=development
COPY frontend/ ./frontend/
CMD ["pnpm", "--filter", "frontend", "run", "dev"]

# Build stage
FROM base AS build
COPY frontend/ ./frontend/
RUN mkdir -p ./frontend/public
# Skip type check and lint during docker builds for speed
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter frontend run build

# Production stage
FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm@9.0.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY frontend/package.json ./frontend/
RUN pnpm install --prod --frozen-lockfile --filter frontend...
COPY --from=build /usr/src/app/frontend/.next ./frontend/.next
COPY --from=build /usr/src/app/frontend/public ./frontend/public
CMD ["pnpm", "--filter", "frontend", "run", "start"]
