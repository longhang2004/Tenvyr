# Base node image
FROM node:22-alpine AS base
RUN npm install -g pnpm@9.0.0
WORKDIR /usr/src/app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/agent-code-reviewer/package.json ./services/agent-code-reviewer/
COPY scripts/copy-contract-schemas.mjs ./scripts/copy-contract-schemas.mjs

RUN pnpm install --frozen-lockfile --filter agent-code-reviewer...

# Development stage
FROM base AS development
ENV NODE_ENV=development
COPY contracts/ ./contracts/
COPY packages/contracts/ ./packages/contracts/
COPY services/agent-code-reviewer/ ./services/agent-code-reviewer/
RUN pnpm --filter @tenvyr/contracts run build
CMD ["pnpm", "--filter", "agent-code-reviewer", "run", "start:dev"]

# Build stage
FROM base AS build
COPY contracts/ ./contracts/
COPY packages/contracts/ ./packages/contracts/
COPY services/agent-code-reviewer/ ./services/agent-code-reviewer/
RUN pnpm --filter agent-code-reviewer run build

# Production stage
FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN npm install -g pnpm@9.0.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/agent-code-reviewer/package.json ./services/agent-code-reviewer/
RUN pnpm install --prod --frozen-lockfile --filter agent-code-reviewer...
COPY contracts/schemas/ ./contracts/schemas/
COPY --from=build /usr/src/app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /usr/src/app/services/agent-code-reviewer/dist ./services/agent-code-reviewer/dist
COPY skills ./skills
CMD ["pnpm", "--filter", "agent-code-reviewer", "run", "start:prod"]
