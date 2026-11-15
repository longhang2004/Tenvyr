# Multi-stage Dockerfile for review-api built from committed source
FROM maven:3.9.9-eclipse-temurin-17 AS builder
ARG SOURCE_REVISION=unspecified
LABEL revision=${SOURCE_REVISION}

WORKDIR /build
COPY backend/ ./backend/

RUN mvn -B -f backend/pom.xml clean package -DskipTests -pl review-api -am

FROM eclipse-temurin:17-jre-jammy
ARG SOURCE_REVISION=unspecified
LABEL revision=${SOURCE_REVISION}

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/backend/review-api/target/review-api-*.jar app.jar

EXPOSE 8080
ENTRYPOINT ["java", "-Djava.security.egd=file:/dev/./urandom", "-jar", "app.jar"]
