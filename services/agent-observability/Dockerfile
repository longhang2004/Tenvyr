# Base node image
FROM node:22-alpine AS base
RUN npm install -g pnpm@9.0.0
WORKDIR /usr/src/app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/agent-observability/package.json ./services/agent-observability/

RUN pnpm install --frozen-lockfile --filter agent-observability...

# Development stage
FROM base AS development
ENV NODE_ENV=development
COPY contracts/ ./contracts/
COPY packages/contracts/ ./packages/contracts/
COPY services/agent-observability/ ./services/agent-observability/
RUN pnpm --filter @tenvyr/contracts run build
CMD ["pnpm", "--filter", "agent-observability", "run", "start:dev"]

# Build stage
FROM base AS build
COPY contracts/ ./contracts/
COPY packages/contracts/ ./packages/contracts/
COPY services/agent-observability/ ./services/agent-observability/
RUN pnpm --filter agent-observability run build

# Production stage
FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm@9.0.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/agent-observability/package.json ./services/agent-observability/
RUN pnpm install --prod --frozen-lockfile --filter agent-observability...
COPY contracts/schemas/ ./contracts/schemas/
COPY --from=build /usr/src/app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /usr/src/app/services/agent-observability/dist ./services/agent-observability/dist
COPY skills ./skills
CMD ["pnpm", "--filter", "agent-observability", "run", "start:prod"]
