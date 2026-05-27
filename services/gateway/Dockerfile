# Base node image
FROM node:20-alpine AS base

# Install pnpm globally
RUN npm install -g pnpm

WORKDIR /usr/src/app

# Copy lockfile and configs for monorepo resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/gateway/package.json ./services/gateway/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter gateway...

# Development stage
FROM base AS development
ENV NODE_ENV=development
COPY services/gateway/ ./services/gateway/
CMD ["pnpm", "--filter", "gateway", "run", "start:dev"]

# Build stage
FROM base AS build
COPY services/gateway/ ./services/gateway/
RUN pnpm --filter gateway run build

# Production stage
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/gateway/package.json ./services/gateway/
RUN pnpm install --prod --frozen-lockfile --filter gateway...
COPY --from=build /usr/src/app/services/gateway/dist ./services/gateway/dist
CMD ["pnpm", "--filter", "gateway", "run", "start:prod"]
