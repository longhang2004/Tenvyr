# Build stage
FROM maven:3.8.8-eclipse-temurin-17 AS build
WORKDIR /app
COPY services/agent-runner/pom.xml .
# Download dependencies first
RUN mvn dependency:go-offline -B
COPY services/agent-runner/src ./src
RUN mvn package -DskipTests

# Package stage
FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
