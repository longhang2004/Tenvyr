# Base node image
FROM node:20-alpine AS base
RUN npm install -g pnpm
WORKDIR /usr/src/app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/agent-code-reviewer/package.json ./services/agent-code-reviewer/

RUN pnpm install --frozen-lockfile --filter agent-code-reviewer...

# Development stage
FROM base AS development
ENV NODE_ENV=development
COPY services/agent-code-reviewer/ ./services/agent-code-reviewer/
CMD ["pnpm", "--filter", "agent-code-reviewer", "run", "start:dev"]

# Build stage
FROM base AS build
COPY services/agent-code-reviewer/ ./services/agent-code-reviewer/
RUN pnpm --filter agent-code-reviewer run build

# Production stage
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/agent-code-reviewer/package.json ./services/agent-code-reviewer/
RUN pnpm install --prod --frozen-lockfile --filter agent-code-reviewer...
COPY --from=build /usr/src/app/services/agent-code-reviewer/dist ./services/agent-code-reviewer/dist
CMD ["pnpm", "--filter", "agent-code-reviewer", "run", "start:prod"]
