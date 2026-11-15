# Multi-stage Dockerfile for review-worker built from committed source
FROM maven:3.9.9-eclipse-temurin-17 AS builder
ARG SOURCE_REVISION=unspecified
LABEL revision=${SOURCE_REVISION}

WORKDIR /build
COPY backend/ ./backend/

RUN mvn -B -f backend/pom.xml clean package dependency:copy-dependencies -DskipTests -pl review-worker -am

FROM eclipse-temurin:17-jre-jammy
ARG SOURCE_REVISION=unspecified
LABEL revision=${SOURCE_REVISION}

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/backend/review-worker/target/review-worker-*.jar app.jar
COPY --from=builder /build/backend/review-worker/target/dependency /app/libs
COPY skills/ /app/skills/

ENTRYPOINT ["java", "-cp", "app.jar:/app/libs/*", "io.tenvyr.reviewworker.ReviewWorkerMain"]
