FROM golang:1.23.4-alpine AS native
WORKDIR /src
COPY backend/executor-host/native/ ./
RUN --mount=type=cache,target=/root/.cache/go-build go test ./... && CGO_ENABLED=0 GOOS=linux go build -o /executor-launcher ./

FROM docker:29.6.1-cli AS docker-client

FROM maven:3.9.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY backend/ backend/
RUN --mount=type=cache,target=/root/.m2,sharing=locked mvn -B -f backend/pom.xml clean package -DskipTests org.apache.maven.plugins:maven-dependency-plugin:3.9.0:copy-dependencies -DincludeScope=runtime

FROM eclipse-temurin:17-jre-noble AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG TENVYR_SOURCE_REVISION=unknown
ENV TENVYR_SOURCE_REVISION=${TENVYR_SOURCE_REVISION} EXECUTOR_HOST_LAUNCHER=/app/bin/executor-launcher TENVYR_ROOT=/app TZ=UTC
COPY --from=native /executor-launcher /app/bin/executor-launcher
COPY --from=build /src/backend/platform/target/ /app/backend/platform/target/
COPY --from=build /src/backend/control-plane/target/ /app/backend/control-plane/target/
COPY --from=build /src/backend/gateway/target/ /app/backend/gateway/target/
COPY --from=build /src/backend/agents/target/ /app/backend/agents/target/
COPY --from=build /src/backend/worker/target/ /app/backend/worker/target/
COPY --from=build /src/backend/executor-host/target/ /app/backend/executor-host/target/
COPY --from=build /src/backend/operations/target/ /app/backend/operations/target/
COPY scripts/java-backend.sh /app/scripts/java-backend.sh
COPY skills/security-review-basic.md skills/observability-guidelines.md /app/skills/
ENTRYPOINT ["/app/scripts/java-backend.sh"]

FROM runtime AS control-plane
CMD ["control-plane"]
FROM runtime AS gateway
CMD ["gateway"]
FROM runtime AS agents
CMD ["agents"]
FROM runtime AS executor-host
CMD ["executor-host"]
FROM runtime AS operations
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-client /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
CMD ["operations"]
