# Base node image
FROM node:20-alpine AS base
RUN npm install -g pnpm
WORKDIR /usr/src/app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/orchestrator/package.json ./services/orchestrator/

RUN pnpm install --frozen-lockfile --filter orchestrator...

# Development stage
FROM base AS development
ENV NODE_ENV=development
COPY contracts/ ./contracts/
COPY packages/contracts/ ./packages/contracts/
COPY services/orchestrator/ ./services/orchestrator/
RUN pnpm --filter @agentweave/contracts run build
CMD ["pnpm", "--filter", "orchestrator", "run", "start:dev"]

# Build stage
FROM base AS build
COPY contracts/ ./contracts/
COPY packages/contracts/ ./packages/contracts/
COPY services/orchestrator/ ./services/orchestrator/
RUN pnpm --filter orchestrator run build

# Production stage
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/orchestrator/package.json ./services/orchestrator/
RUN pnpm install --prod --frozen-lockfile --filter orchestrator...
COPY contracts/schemas/ ./contracts/schemas/
COPY --from=build /usr/src/app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /usr/src/app/services/orchestrator/dist ./services/orchestrator/dist
CMD ["pnpm", "--filter", "orchestrator", "run", "start:prod"]
