FROM golang:1.23.4-bookworm AS native
WORKDIR /src
COPY backend/executor-host/native/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /executor-launcher ./

FROM maven:3.9.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY backend/ backend/
RUN mvn -B -f backend/pom.xml package -DskipTests org.apache.maven.plugins:maven-dependency-plugin:3.9.0:copy-dependencies -DincludeScope=runtime

FROM eclipse-temurin:17-jre-jammy AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG TENVYR_SOURCE_REVISION=unknown
ENV TENVYR_SOURCE_REVISION=${TENVYR_SOURCE_REVISION} EXECUTOR_HOST_LAUNCHER=/app/bin/executor-launcher TENVYR_ROOT=/app
COPY --from=native /executor-launcher /app/bin/executor-launcher
COPY --from=build /src/backend/platform/target/ /app/backend/platform/target/
COPY --from=build /src/backend/control-plane/target/ /app/backend/control-plane/target/
COPY --from=build /src/backend/gateway/target/ /app/backend/gateway/target/
COPY --from=build /src/backend/agents/target/ /app/backend/agents/target/
COPY --from=build /src/backend/worker/target/ /app/backend/worker/target/
COPY --from=build /src/backend/executor-host/target/ /app/backend/executor-host/target/
COPY --from=build /src/backend/operations/target/ /app/backend/operations/target/
COPY scripts/java-backend.sh /app/scripts/java-backend.sh
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
CMD ["operations"]
