package io.tenvyr.review;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.control.engine.HttpAgentAdapter;
import io.tenvyr.platform.Json;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.SmartLifecycle;

import javax.sql.DataSource;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T01 Boot dependency-closure compatibility test.
 * Verifies Jackson convergence, immutable canonical JSON / hash goldens,
 * deterministic HMAC signature verification vectors, and production symbol contracts.
 */
public class ReviewContractCompatibilityTest {

    @Test
    @DisplayName("Jackson component versions converge under Spring Boot 3.5.16 dependency closure")
    void testJacksonVersionConvergence() {
        Package corePkg = JsonFactory.class.getPackage();
        Package databindPkg = ObjectMapper.class.getPackage();
        Package annotationPkg = JsonProperty.class.getPackage();

        assertNotNull(corePkg, "jackson-core package must be present");
        assertNotNull(databindPkg, "jackson-databind package must be present");
        assertNotNull(annotationPkg, "jackson-annotations package must be present");

        com.fasterxml.jackson.core.Version coreVer = new JsonFactory().version();
        com.fasterxml.jackson.core.Version databindVer = new ObjectMapper().version();

        assertNotNull(coreVer, "jackson-core Version must be available");
        assertNotNull(databindVer, "jackson-databind Version must be available");
        assertEquals(2, coreVer.getMajorVersion(), "jackson-core major version must be 2");
        assertEquals(2, databindVer.getMajorVersion(), "jackson-databind major version must be 2");
        assertEquals(coreVer.getMajorVersion(), databindVer.getMajorVersion(),
                "Jackson core and databind major versions must match");
        assertEquals(coreVer.getMinorVersion(), databindVer.getMinorVersion(),
                "Jackson core (" + coreVer + ") and databind (" + databindVer + ") minor versions must converge");

        String annotationVersion = annotationPkg.getImplementationVersion();
        if (annotationVersion == null || annotationVersion.isBlank()) {
            try (InputStream in = JsonProperty.class.getResourceAsStream(
                    "/META-INF/maven/com.fasterxml.jackson.core/jackson-annotations/pom.properties")) {
                if (in != null) {
                    java.util.Properties props = new java.util.Properties();
                    props.load(in);
                    annotationVersion = props.getProperty("version");
                }
            } catch (Exception ignored) {}
        }
        assertNotNull(annotationVersion, "jackson-annotations version metadata must be available");
        assertTrue(annotationVersion.startsWith("2."),
                "jackson-annotations (" + annotationVersion + ") must belong to Jackson 2.x family");
        String annotationMajorMinor = annotationVersion.replaceAll("^(\\d+\\.\\d+).*", "$1");
        assertEquals(coreVer.getMajorVersion() + "." + coreVer.getMinorVersion(), annotationMajorMinor,
                "jackson-annotations (" + annotationVersion + ") must converge with jackson-core (" + coreVer + ")");
    }

    @Test
    @DisplayName("Boot runtime reproduces exact canonical JSON and SHA-256 hashes for immutable Node goldens")
    void testCanonicalJsonGoldenParity() throws Exception {
        Path path = Path.of("backend/platform/src/test/resources/node-canonical-goldens.json");
        if (!Files.exists(path)) {
            path = Path.of("../platform/src/test/resources/node-canonical-goldens.json");
        }
        if (!Files.exists(path)) {
            path = Path.of("../../backend/platform/src/test/resources/node-canonical-goldens.json");
        }
        assertTrue(Files.exists(path), "node-canonical-goldens.json must exist at: " + path.toAbsolutePath());

        JsonNode vectors = Json.parse(Files.readString(path));
        assertTrue(vectors.isArray(), "Golden vectors must be an array");
        assertTrue(vectors.size() > 0, "Golden vectors must not be empty");

        int checked = 0;
        for (JsonNode vector : vectors) {
            JsonNode value = vector.get("value");
            String expectedCanonical = vector.path("canonical").asText();
            String expectedHash = vector.path("hash").asText();

            String actualCanonical = Json.canonical(value);
            String actualHash = Json.hash(value);

            assertEquals(expectedCanonical, actualCanonical,
                    "Canonical JSON mismatch for golden vector " + vector.path("name").asText());
            assertEquals(expectedHash, actualHash,
                    "SHA-256 hash mismatch for golden vector " + vector.path("name").asText());
            checked++;
        }
        assertTrue(checked >= 200, "Must verify full suite of canonical goldens, checked: " + checked);
    }

    @Test
    @DisplayName("HMAC signature verification matches immutable conformance vectors and verifies raw bytes")
    void testHmacSignatureVerificationVectors() throws Exception {
        Path path = Path.of("contracts/conformance/callback-signatures/vectors.json");
        if (!Files.exists(path)) {
            path = Path.of("../contracts/conformance/callback-signatures/vectors.json");
        }
        if (!Files.exists(path)) {
            path = Path.of("../../contracts/conformance/callback-signatures/vectors.json");
        }
        assertTrue(Files.exists(path), "vectors.json must exist at: " + path.toAbsolutePath());

        JsonNode vectors = Json.parse(Files.readString(path));
        assertTrue(vectors.isArray(), "Vectors must be a JSON array");
        assertTrue(vectors.size() > 0, "Vectors must not be empty");

        int checked = 0;
        for (JsonNode vector : vectors) {
            String name = vector.path("name").asText();
            String secret = vector.path("secret").asText();
            String timestamp = vector.path("timestamp").asText();
            String deliveryId = vector.path("deliveryId").asText();
            byte[] rawBodyUtf8 = vector.path("rawBodyUtf8").asText().getBytes(StandardCharsets.UTF_8);
            String expectedSignature = vector.path("expectedSignature").asText();

            String actualSignature = HttpAgentAdapter.signature(secret, timestamp, deliveryId, rawBodyUtf8);
            assertEquals(expectedSignature, actualSignature, "HMAC signature mismatch for vector: " + name);

            long timestampSeconds = Long.parseLong(timestamp);
            long nowMs = timestampSeconds * 1000L;
            assertDoesNotThrow(() ->
                    HttpAgentAdapter.verify(secret, timestamp, deliveryId, expectedSignature, rawBodyUtf8, 300, nowMs),
                    "HttpAgentAdapter.verify must accept expected signature for vector: " + name);

            checked++;
        }
        assertTrue(checked >= 8, "Must verify all conformance vectors, checked: " + checked);

        // Verification failure modes
        JsonNode first = vectors.get(0);
        String secret = first.path("secret").asText();
        String timestamp = first.path("timestamp").asText();
        String deliveryId = first.path("deliveryId").asText();
        byte[] rawBytes = first.path("rawBodyUtf8").asText().getBytes(StandardCharsets.UTF_8);
        String signature = first.path("expectedSignature").asText();
        long nowMs = Long.parseLong(timestamp) * 1000L;

        // Tampered body (even single byte mutation) MUST fail
        byte[] tamperedBytes = (new String(rawBytes, StandardCharsets.UTF_8) + " ").getBytes(StandardCharsets.UTF_8);
        assertThrows(RuntimeException.class, () ->
                HttpAgentAdapter.verify(secret, timestamp, deliveryId, signature, tamperedBytes, 300, nowMs),
                "Tampered body must fail verification");

        // Expired timestamp beyond max skew MUST fail
        assertThrows(RuntimeException.class, () ->
                HttpAgentAdapter.verify(secret, timestamp, deliveryId, signature, rawBytes, 300, nowMs + 301_000L),
                "Expired timestamp must fail verification");

        // Malformed signature MUST fail
        assertThrows(RuntimeException.class, () ->
                HttpAgentAdapter.verify(secret, timestamp, deliveryId, "v1=" + "f".repeat(64), rawBytes, 300, nowMs),
                "Wrong signature must fail verification");
        assertThrows(RuntimeException.class, () ->
                HttpAgentAdapter.verify(secret, timestamp, deliveryId, "invalid", rawBytes, 300, nowMs),
                "Malformed signature format must fail verification");
    }

    @Test
    @DisplayName("T01 Stage A RED: ReviewApplication production entrypoint must exist and be annotated")
    void testReviewApplicationProductionClassPresent() throws Exception {
        Class<?> appClass = Class.forName("io.tenvyr.review.ReviewApplication");
        assertNotNull(appClass, "io.tenvyr.review.ReviewApplication must be declared");
        assertTrue(appClass.isAnnotationPresent(org.springframework.boot.autoconfigure.SpringBootApplication.class),
                "ReviewApplication must be annotated with @SpringBootApplication");
    }

    @Test
    @DisplayName("T01 Stage A RED: EngineConfiguration must declare ControlPlaneRuntime managed bean")
    void testEngineConfigurationBeanContract() throws Exception {
        Class<?> configClass = Class.forName("io.tenvyr.review.EngineConfiguration");
        assertNotNull(configClass, "io.tenvyr.review.EngineConfiguration must be declared");
        Method beanMethod = configClass.getMethod("engineRuntime");
        assertEquals(ControlPlaneRuntime.class, beanMethod.getReturnType(),
                "engineRuntime() must produce ControlPlaneRuntime singleton bean");
    }

    @Test
    @DisplayName("T01 Stage A RED: EngineLifecycle must implement SmartLifecycle with ordered startup")
    void testEngineLifecycleContract() throws Exception {
        Class<?> lifecycleClass = Class.forName("io.tenvyr.review.EngineLifecycle");
        assertNotNull(lifecycleClass, "io.tenvyr.review.EngineLifecycle must be declared");
        assertTrue(SmartLifecycle.class.isAssignableFrom(lifecycleClass),
                "EngineLifecycle must implement SmartLifecycle");
    }

    @Test
    @DisplayName("scripts/review-checks.sh integration strictly validates database URL before Maven without exposing credentials")
    void testDatabaseUrlSafetyGuard(@TempDir Path tempDir) throws Exception {
        createFakeMvnSentinel(tempDir);

        // Missing URL
        ScriptProcessResult missing = runReviewChecksIntegration(null, tempDir);
        assertEquals(1, missing.exitCode(), "Missing URL must exit 1");
        assertTrue(missing.output().contains("ERROR:"), "Output must contain safe error indicator");
        assertTrue(missing.output().contains("Missing test database URL"), "Output must state missing URL");
        assertFalse(missing.output().contains("Building") || missing.output().contains("Scanning for projects"),
                "Early rejection must occur before Maven starts");
        assertFalse(missing.output().contains("MAVEN_REACHED_SENTINEL"), "Fake mvn sentinel must not be reached on missing URL");

        // Foreign database with credentials
        ScriptProcessResult foreign = runReviewChecksIntegration("jdbc:postgresql://user:secretpass@127.0.0.1:5432/production_db?test=true", tempDir);
        assertEquals(1, foreign.exitCode(), "Foreign database must exit 1");
        assertTrue(foreign.output().contains("ERROR:"), "Output must contain safe error indicator");
        assertFalse(foreign.output().contains("secretpass"), "Output must not contain password");
        assertFalse(foreign.output().contains("://"), "Output must not contain URL");
        assertFalse(foreign.output().contains("Building") || foreign.output().contains("Scanning for projects"),
                "Early rejection must occur before Maven starts");
        assertFalse(foreign.output().contains("MAVEN_REACHED_SENTINEL"), "Fake mvn sentinel must not be reached on foreign URL");

        // Invalid non-postgres scheme
        ScriptProcessResult nonPostgres = runReviewChecksIntegration("jdbc:mysql://127.0.0.1:3306/review_test", tempDir);
        assertEquals(1, nonPostgres.exitCode(), "Non-postgres URL must exit 1");
        assertTrue(nonPostgres.output().contains("ERROR:"), "Output must contain safe error indicator");
        assertFalse(nonPostgres.output().contains("://"), "Output must not contain URL");
        assertFalse(nonPostgres.output().contains("Building") || nonPostgres.output().contains("Scanning for projects"),
                "Early rejection must occur before Maven starts");
        assertFalse(nonPostgres.output().contains("MAVEN_REACHED_SENTINEL"), "Fake mvn sentinel must not be reached on non-postgres URL");

        // Malformed URL / invalid percent encoding
        ScriptProcessResult malformed = runReviewChecksIntegration("not_a_valid_url:::", tempDir);
        assertEquals(1, malformed.exitCode(), "Malformed URL must exit 1");
        assertTrue(malformed.output().contains("ERROR:"), "Output must contain safe error indicator");
        assertFalse(malformed.output().contains("MAVEN_REACHED_SENTINEL"), "Fake mvn sentinel must not be reached on malformed URL");

        ScriptProcessResult invalidPercent = runReviewChecksIntegration("jdbc:postgresql://127.0.0.1:5432/test_%ZZ", tempDir);
        assertEquals(1, invalidPercent.exitCode(), "Invalid percent encoding must exit 1");
        assertTrue(invalidPercent.output().contains("ERROR:"), "Output must contain safe error indicator");
        assertFalse(invalidPercent.output().contains("MAVEN_REACHED_SENTINEL"), "Fake mvn sentinel must not be reached on invalid percent URL");

        // Raw non-JDBC postgres URI must be rejected under JDBC URL-only contract
        ScriptProcessResult rawPostgres = runReviewChecksIntegration("postgres://user:pass@127.0.0.1:5432/disposable_db", tempDir);
        assertEquals(1, rawPostgres.exitCode(), "Raw non-JDBC postgres URI must exit 1");
        assertTrue(rawPostgres.output().contains("ERROR:"), "Output must contain safe error indicator");
        assertFalse(rawPostgres.output().contains("MAVEN_REACHED_SENTINEL"), "Fake mvn sentinel must not be reached on raw postgres URL");

        // Malformed query percent encoding
        ScriptProcessResult malformedQuery = runReviewChecksIntegration("jdbc:postgresql://127.0.0.1:5432/review_test?%ZZ=1", tempDir);
        assertEquals(1, malformedQuery.exitCode(), "Malformed query percent encoding must exit 1");
        assertTrue(malformedQuery.output().contains("ERROR:"), "Output must contain safe error indicator");
        assertFalse(malformedQuery.output().contains("MAVEN_REACHED_SENTINEL"), "Fake mvn sentinel must not be reached on malformed query");

        // Unsafe routing queries (case-insensitivity, aliases, percent-encoding)
        List<String> unsafeRoutingUrls = List.of(
                "jdbc:postgresql://localhost/review_test?PGDBNAME=production",
                "jdbc:postgresql://user:secretpass@127.0.0.1:5432/review_test?PGHOST=remote.internal",
                "jdbc:postgresql://localhost/review_test?PGPORT=5433",
                "jdbc:postgresql://localhost/review_test?service=production_service",
                "jdbc:postgresql://localhost/review_test?dbname=production",
                "jdbc:postgresql://localhost/review_test?databaseName=production",
                "jdbc:postgresql://localhost/review_test?database=production",
                "jdbc:postgresql://localhost/review_test?host=remote",
                "jdbc:postgresql://localhost/review_test?port=5433",
                "jdbc:postgresql://localhost/review_test?PgDbName=production",
                "jdbc:postgresql://localhost/review_test?%50%47%44%42%4e%41%4d%45=production",
                "jdbc:postgresql://localhost/review_test?sslmode=disable&PGDBNAME=production",
                "jdbc:postgresql://localhost/review_test?x=y#&PGDBNAME=production"
        );

        for (String unsafeUrl : unsafeRoutingUrls) {
            ScriptProcessResult unsafe = runReviewChecksIntegration(unsafeUrl, tempDir);
            assertEquals(1, unsafe.exitCode(), "Unsafe routing query must exit 1: " + unsafeUrl);
            assertTrue(unsafe.output().contains("ERROR:"), "Output must contain safe error indicator for: " + unsafeUrl);
            assertFalse(unsafe.output().contains("MAVEN_REACHED_SENTINEL"), "Fake mvn sentinel must not be reached for unsafe URL: " + unsafeUrl);
            assertFalse(unsafe.output().contains("secretpass"), "Output must not contain credentials: " + unsafeUrl);
            assertFalse(unsafe.output().contains("://"), "Output must not contain URL: " + unsafeUrl);
        }

        // Normal valid JDBC URL with allowed options (sslmode, currentSchema) must pass guard and reach fake mvn sentinel exit 91
        ScriptProcessResult valid = runReviewChecksIntegration("jdbc:postgresql://localhost:5432/review_test?sslmode=disable&currentSchema=public", tempDir);
        assertEquals(91, valid.exitCode(), "Valid test URL with query options must pass guard and reach fake mvn sentinel");
        assertTrue(valid.output().contains("MAVEN_REACHED_SENTINEL"), "Valid test URL must reach fake mvn sentinel");
        assertTrue(valid.output().contains("INVOKED_MVN_ARGS: -B -f backend/pom.xml -pl review-api,review-worker -am verify -Preview-integration"),
                "Fake maven must be invoked with both modules and -Preview-integration profile");
        assertFalse(valid.output().contains("ERROR:"), "Valid test URL must not produce error");

        // IPv6 valid URL with query options must also reach sentinel
        ScriptProcessResult validIpv6 = runReviewChecksIntegration("jdbc:postgresql://[::1]:5432/review_test?sslmode=disable&currentSchema=public", tempDir);
        assertEquals(91, validIpv6.exitCode(), "Valid IPv6 test URL with query options must pass guard and reach fake mvn sentinel");
        assertTrue(validIpv6.output().contains("MAVEN_REACHED_SENTINEL"), "Valid IPv6 test URL must reach fake mvn sentinel");
        assertTrue(validIpv6.output().contains("INVOKED_MVN_ARGS: -B -f backend/pom.xml -pl review-api,review-worker -am verify -Preview-integration"),
                "Fake maven must be invoked with both modules and -Preview-integration profile for IPv6 URL");
    }

    @Test
    @DisplayName("Direct IT URL guards reject routing queries and preserve allowed query options")
    void testDirectItUrlGuards() {
        List<String> unsafeUrls = List.of(
                "jdbc:postgresql://localhost/review_test?PGDBNAME=production",
                "jdbc:postgresql://user:secretpass@127.0.0.1:5432/review_test?PGHOST=remote.internal",
                "jdbc:postgresql://localhost/review_test?PGPORT=5433",
                "jdbc:postgresql://localhost/review_test?service=production_service",
                "jdbc:postgresql://localhost/review_test?dbname=production",
                "jdbc:postgresql://localhost/review_test?databaseName=production",
                "jdbc:postgresql://localhost/review_test?database=production",
                "jdbc:postgresql://localhost/review_test?host=remote",
                "jdbc:postgresql://localhost/review_test?port=5433",
                "jdbc:postgresql://localhost/review_test?PgDbName=production",
                "jdbc:postgresql://localhost/review_test?%50%47%44%42%4e%41%4d%45=production",
                "jdbc:postgresql://localhost/review_test?sslmode=disable&PGDBNAME=production",
                "jdbc:postgresql://localhost/review_test?x=y#&PGDBNAME=production"
        );

        for (String url : unsafeUrls) {
            IllegalArgumentException ex1 = assertThrows(IllegalArgumentException.class,
                    () -> ReviewCallbackIT.validateDisposableDatabaseUrl(url),
                    "ReviewCallbackIT guard must reject: " + url);
            assertFalse(ex1.getMessage().contains("secretpass"), "ReviewCallbackIT error must not leak credentials");
            assertFalse(ex1.getMessage().contains("://"), "ReviewCallbackIT error must not leak URL");

            IllegalArgumentException ex2 = assertThrows(IllegalArgumentException.class,
                    () -> ReviewLifecycleIT.validateDisposableDatabaseUrl(url),
                    "ReviewLifecycleIT guard must reject: " + url);
            assertFalse(ex2.getMessage().contains("secretpass"), "ReviewLifecycleIT error must not leak credentials");
            assertFalse(ex2.getMessage().contains("://"), "ReviewLifecycleIT error must not leak URL");
        }

        // Malformed query parameter percent decoding
        assertThrows(IllegalArgumentException.class,
                () -> ReviewCallbackIT.validateDisposableDatabaseUrl("jdbc:postgresql://localhost/review_test?%ZZ=1"));
        assertThrows(IllegalArgumentException.class,
                () -> ReviewLifecycleIT.validateDisposableDatabaseUrl("jdbc:postgresql://localhost/review_test?%ZZ=1"));

        // Valid URLs with allowed query options and IPv6 must be accepted
        assertDoesNotThrow(() ->
                ReviewCallbackIT.validateDisposableDatabaseUrl("jdbc:postgresql://localhost:5432/review_test?sslmode=disable&currentSchema=public"));
        assertDoesNotThrow(() ->
                ReviewLifecycleIT.validateDisposableDatabaseUrl("jdbc:postgresql://localhost:5432/review_test?sslmode=disable&currentSchema=public"));
        assertDoesNotThrow(() ->
                ReviewCallbackIT.validateDisposableDatabaseUrl("jdbc:postgresql://[::1]:5432/review_test?sslmode=disable&currentSchema=public"));
        assertDoesNotThrow(() ->
                ReviewLifecycleIT.validateDisposableDatabaseUrl("jdbc:postgresql://[::1]:5432/review_test?sslmode=disable&currentSchema=public"));
    }

    private record ScriptProcessResult(int exitCode, String output) {}

    private Path createFakeMvnSentinel(Path tempDir) throws Exception {
        Path fakeMvn = tempDir.resolve("mvn");
        String script = "#!/bin/sh\n" +
                "echo \"MAVEN_REACHED_SENTINEL\"\n" +
                "echo \"INVOKED_MVN_ARGS: $@\"\n" +
                "exit 91\n";
        Files.writeString(fakeMvn, script, StandardCharsets.UTF_8);
        fakeMvn.toFile().setExecutable(true, false);
        try {
            java.nio.file.attribute.PosixFileAttributeView view =
                    Files.getFileAttributeView(fakeMvn, java.nio.file.attribute.PosixFileAttributeView.class);
            if (view != null) {
                Files.setPosixFilePermissions(fakeMvn, java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));
            }
        } catch (Exception ignored) {}
        return fakeMvn;
    }

    private ScriptProcessResult runReviewChecksIntegration(String dbUrl) throws Exception {
        return runReviewChecksIntegration(dbUrl, null);
    }

    private ScriptProcessResult runReviewChecksIntegration(String dbUrl, Path fakeMvnDir) throws Exception {
        Path root = Path.of("").toAbsolutePath();
        while (root != null && !Files.exists(root.resolve("scripts/review-checks.sh"))) {
            root = root.getParent();
        }
        assertNotNull(root, "Repository root containing scripts/review-checks.sh must be found");
        Path script = root.resolve("scripts/review-checks.sh");

        ProcessBuilder pb = new ProcessBuilder("sh", script.toString().replace('\\', '/'), "integration");
        pb.directory(root.toFile());
        Map<String, String> env = pb.environment();
        env.remove("TEST_DATABASE_URL");
        if (dbUrl == null) {
            env.remove("TENVYR_REVIEW_TEST_DATABASE_URL");
        } else {
            env.put("TENVYR_REVIEW_TEST_DATABASE_URL", dbUrl);
        }

        if (fakeMvnDir != null) {
            String stubDir = fakeMvnDir.toAbsolutePath().toString();
            String existingPath = env.get("PATH");
            if (existingPath == null) {
                existingPath = env.get("Path");
            }
            if (existingPath == null) {
                existingPath = "";
            }
            String pathSep = System.getProperty("os.name", "").toLowerCase().contains("win") ? ";" : ":";
            String newPath = stubDir + pathSep + existingPath;
            env.put("PATH", newPath);
            env.put("Path", newPath);
        }

        Process process = pb.start();
        boolean finished = process.waitFor(5, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            fail("scripts/review-checks.sh integration did not finish within 5-second timeout");
        }

        String stdout = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        String stderr = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
        return new ScriptProcessResult(process.exitValue(), stdout + "\n" + stderr);
    }

    @Test
    @DisplayName("EngineConfiguration must reject explicit nonblank KAFKA_BROKERS before runtime allocation")
    void testEngineConfigurationRejectsExplicitKafkaBrokers() {
        assertEngineConfigurationRejectsExplicitKafkaConfig(
                Map.of("KAFKA_BROKERS", "localhost:9092"),
                "KAFKA_BROKERS"
        );
    }

    @Test
    @DisplayName("EngineConfiguration must reject explicit nonblank ORCHESTRATOR_EVENT_TOPICS before runtime allocation")
    void testEngineConfigurationRejectsExplicitOrchestratorEventTopics() {
        assertEngineConfigurationRejectsExplicitKafkaConfig(
                Map.of("ORCHESTRATOR_EVENT_TOPICS", "review-test-events"),
                "ORCHESTRATOR_EVENT_TOPICS"
        );
    }

    @Test
    @DisplayName("EngineConfiguration must reject explicit nonblank ORCHESTRATOR_RESULT_TOPICS before runtime allocation")
    void testEngineConfigurationRejectsExplicitOrchestratorResultTopics() {
        assertEngineConfigurationRejectsExplicitKafkaConfig(
                Map.of("ORCHESTRATOR_RESULT_TOPICS", "review-test-results"),
                "ORCHESTRATOR_RESULT_TOPICS"
        );
    }

    private void assertEngineConfigurationRejectsExplicitKafkaConfig(Map<String, String> explicitKafkaProps, String keyName) {
        org.springframework.core.env.StandardEnvironment env = new org.springframework.core.env.StandardEnvironment();
        Map<String, Object> props = new HashMap<>(Map.of(
                "HTTP_AGENT_ALLOW_INSECURE", "true",
                "HTTP_AGENT_CALLBACK_BASE_URL", "http://127.0.0.1:8080",
                "TEST_SECRET", "test-secret-64bytes-long-hmac-sha256-signature-ok",
                "TEST_TOKEN", "test-token",
                "AGENT_TRANSPORT_CONFIG", "{\"code-reviewer\":{\"kind\":\"http\",\"submitUrl\":\"http://127.0.0.1:8081/v1/runs\",\"outboundAuthentication\":{\"type\":\"bearer\",\"tokenEnv\":\"TEST_TOKEN\"},\"callbackAuthentication\":{\"keyId\":\"key-1\",\"secretEnv\":\"TEST_SECRET\"},\"requestTimeoutMs\":2000,\"maxResponseBytes\":65536}}"
        ));
        props.putAll(explicitKafkaProps);
        env.getPropertySources().addFirst(new org.springframework.core.env.MapPropertySource("testExplicitKafkaProperties", props));

        DataSource rejectingDataSource = (DataSource) java.lang.reflect.Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[]{DataSource.class},
                (proxy, method, args) -> {
                    throw new AssertionError("Database must not be accessed before configuration validation: " + method.getName());
                }
        );

        EngineConfiguration config = new EngineConfiguration(rejectingDataSource, env);
        ControlPlaneRuntime runtime = null;
        try {
            try {
                runtime = config.engineRuntime();
            } catch (IllegalStateException expected) {
                // Expected rejection before runtime allocation / DB access
                return;
            }
            fail("EngineConfiguration must reject explicit " + keyName + " in review mode before runtime allocation");
        } finally {
            if (runtime != null) {
                try {
                    runtime.close();
                } catch (Exception ignored) {}
            }
        }
    }
}
