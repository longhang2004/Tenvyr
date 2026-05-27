# Base node image
FROM node:20-alpine AS base
RUN npm install -g pnpm
WORKDIR /usr/src/app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/agent-observability/package.json ./services/agent-observability/

RUN pnpm install --frozen-lockfile --filter agent-observability...

# Development stage
FROM base AS development
ENV NODE_ENV=development
COPY services/agent-observability/ ./services/agent-observability/
CMD ["pnpm", "--filter", "agent-observability", "run", "start:dev"]

# Build stage
FROM base AS build
COPY services/agent-observability/ ./services/agent-observability/
RUN pnpm --filter agent-observability run build

# Production stage
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/agent-observability/package.json ./services/agent-observability/
RUN pnpm install --prod --frozen-lockfile --filter agent-observability...
COPY --from=build /usr/src/app/services/agent-observability/dist ./services/agent-observability/dist
CMD ["pnpm", "--filter", "agent-observability", "run", "start:prod"]
