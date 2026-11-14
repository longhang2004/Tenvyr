package io.tenvyr.review;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariDataSource;
import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationPreparedEvent;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationListener;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.sql.DataSource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T02 Integration Test: Fixed internal review pipeline catalog and PostgreSQL version binding.
 * Requires real disposable PostgreSQL (no H2/mocks).
 * Verifies atomic pipeline creation, advisory transaction lock, duplicate prevention under concurrent startup,
 * definition hash drift rejection, caller-owned connection semantics, two-app concurrent startup on ephemeral ports,
 * and migration failure isolation.
 */
@SpringBootTest(classes = ReviewApplication.class,
        properties = {
                "HTTP_AGENT_ALLOW_INSECURE=true",
                "HTTP_AGENT_CALLBACK_BASE_URL=http://127.0.0.1:8080",
                "TEST_SECRET=" + ReviewCallbackIT.TEST_SECRET,
                "TEST_TOKEN=test-token"
        }
)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public class PipelineCatalogIT {

    @Autowired
    private DataSource dataSource;

    private static String testDbUrl;
    private static String testUser;
    private static String testPassword;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("PipelineCatalogIT requires real PostgreSQL: TENVYR_REVIEW_TEST_DATABASE_URL must be set");
        }

        ReviewCallbackIT.validateDisposableDatabaseUrl(raw);

        testUser = System.getenv().getOrDefault("POSTGRES_USER", "postgres");
        testPassword = System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres");
        testDbUrl = raw;

        registry.add("spring.datasource.url", () -> raw);
        registry.add("spring.datasource.username", () -> testUser);
        registry.add("spring.datasource.password", () -> testPassword);

        String transportConfig = Json.stringify(Json.object(
                ReviewCallbackIT.TEST_AGENT, Json.object(
                        "kind", "http",
                        "submitUrl", "http://127.0.0.1:8081/v1/runs",
                        "outboundAuthentication", Json.object("type", "bearer", "tokenEnv", "TEST_TOKEN"),
                        "callbackAuthentication", Json.object("keyId", ReviewCallbackIT.TEST_KEY_ID, "secretEnv", "TEST_SECRET"),
                        "requestTimeoutMs", 2000,
                        "maxResponseBytes", 65536
                )
        ));
        registry.add("AGENT_TRANSPORT_CONFIG", () -> transportConfig);
    }

    @BeforeAll
    static void requireRealDisposableDatabase() {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        ReviewCallbackIT.validateDisposableDatabaseUrl(raw);
    }

    private ConfigurableApplicationContext createApp(
            String dbUrl,
            Map<String, Object> overrides,
            AtomicReference<HikariDataSource> capturedPool,
            ApplicationListener<?>... additionalListeners) {
        return createApp(dbUrl, overrides, capturedPool, null, additionalListeners);
    }

    private ConfigurableApplicationContext createApp(
            String dbUrl,
            Map<String, Object> overrides,
            AtomicReference<HikariDataSource> capturedPool,
            AtomicReference<ControlPlaneRuntime> capturedRuntime,
            ApplicationListener<?>... additionalListeners) {
        SpringApplication app = new SpringApplication(ReviewApplication.class);
        if (additionalListeners != null) {
            for (ApplicationListener<?> l : additionalListeners) {
                if (l != null) {
                    app.addListeners(l);
                }
            }
        }
        if (capturedPool != null || capturedRuntime != null) {
            app.addListeners((ApplicationListener<ApplicationPreparedEvent>) event -> {
                event.getApplicationContext().getBeanFactory().addBeanPostProcessor(new org.springframework.beans.factory.config.BeanPostProcessor() {
                    @Override
                    public Object postProcessBeforeInitialization(Object bean, String beanName) {
                        if (capturedPool != null) {
                            if (bean instanceof HikariDataSource hds) {
                                capturedPool.set(hds);
                            } else if (bean instanceof DataSource ds) {
                                try {
                                    HikariDataSource hds = ds.unwrap(HikariDataSource.class);
                                    if (hds != null) {
                                        capturedPool.set(hds);
                                    }
                                } catch (Exception ignored) {}
                            }
                        }
                        if (capturedRuntime != null && bean instanceof ControlPlaneRuntime cpr) {
                            capturedRuntime.set(cpr);
                        }
                        return bean;
                    }
                });
            });
        }

        Map<String, Object> props = new HashMap<>(Map.of(
                "server.port", "0",
                "spring.datasource.url", dbUrl,
                "spring.datasource.username", testUser,
                "spring.datasource.password", testPassword,
                "HTTP_AGENT_ALLOW_INSECURE", "true",
                "HTTP_AGENT_CALLBACK_BASE_URL", "http://127.0.0.1:8080",
                "TEST_SECRET", ReviewCallbackIT.TEST_SECRET,
                "TEST_TOKEN", "test-token",
                "AGENT_TRANSPORT_CONFIG", "{\"code-reviewer\":{\"kind\":\"http\",\"submitUrl\":\"http://127.0.0.1:8081/v1/runs\",\"outboundAuthentication\":{\"type\":\"bearer\",\"tokenEnv\":\"TEST_TOKEN\"},\"callbackAuthentication\":{\"keyId\":\"" + ReviewCallbackIT.TEST_KEY_ID + "\",\"secretEnv\":\"TEST_SECRET\"},\"requestTimeoutMs\":2000,\"maxResponseBytes\":65536}}"
        ));
        if (overrides != null) {
            props.putAll(overrides);
        }

        // Add as first PropertySource so application.yml never overrides server.port or datasource
        app.addInitializers((ConfigurableApplicationContext ctx) -> {
            ctx.getEnvironment().getPropertySources().addFirst(
                    new org.springframework.core.env.MapPropertySource("highPrecedenceTestProps", props)
            );
        });

        // Pass CLI arguments to app.run() as highest precedence property source
        List<String> cliArgs = new ArrayList<>();
        for (Map.Entry<String, Object> entry : props.entrySet()) {
            cliArgs.add("--" + entry.getKey() + "=" + entry.getValue());
        }
        return app.run(cliArgs.toArray(new String[0]));
    }

    private ConfigurableApplicationContext createApp(String dbUrl, Map<String, Object> overrides) {
        return createApp(dbUrl, overrides, null);
    }

    @Test
    @DisplayName("PipelineCatalog.ensure creates fixed review-request-v1 pipeline and version 1 binding atomically")
    void testEnsureCreatesPipelineAndBinding() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ObjectNode pipeline = PipelineCatalog.ensure(conn);
                conn.commit();
                assertNotNull(pipeline, "PipelineCatalog.ensure must return created/bound pipeline");

                String pipelineId = pipeline.path("id").asText();
                assertFalse(pipelineId.isBlank(), "Pipeline must have a non-blank ID");
                assertEquals("review-request-v1", pipeline.path("name").asText());
                assertEquals("1", pipeline.path("version").asText());

                // Verify single step: review targeting code-reviewer
                assertEquals(1, pipeline.path("steps").size());
                assertEquals("review", pipeline.path("steps").get(0).path("id").asText());
                assertEquals("code-reviewer", pipeline.path("steps").get(0).path("agent").asText());
                assertEquals(2, pipeline.path("steps").get(0).path("retries").asInt());
                assertEquals("retry", pipeline.path("steps").get(0).path("onFailure").asText());
                assertEquals("30s", pipeline.path("steps").get(0).path("timeout").asText());

                // Verify pipeline_bindings row in tenvyr_review
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT version, pipeline_id, definition_hash FROM tenvyr_review.pipeline_bindings WHERE version = 1")) {
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next(), "tenvyr_review.pipeline_bindings must contain row for version 1");
                        assertEquals(1, rs.getInt("version"));
                        assertEquals(UUID.fromString(pipelineId), rs.getObject("pipeline_id", UUID.class));
                        String hash = rs.getString("definition_hash");
                        assertNotNull(hash);
                        assertEquals(64, hash.trim().length(), "definition_hash must be a 64-character SHA-256 hex string");
                    }
                }

                // Verify pipeline exists in engine pipelines table
                try (PreparedStatement ps = conn.prepareStatement("SELECT name FROM pipelines WHERE id = ?::uuid")) {
                    ps.setString(1, pipelineId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next(), "pipelines table must contain row matching bound pipelineId");
                        assertEquals("review-request-v1", rs.getString("name"));
                    }
                }
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }
    }

    @Test
    @DisplayName("PipelineCatalog.ensure rejects auto-commit connections")
    void testEnsureRejectsAutoCommitTrue() throws Exception {
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(true);
            assertThrows(Exception.class, () -> PipelineCatalog.ensure(conn),
                    "PipelineCatalog.ensure must reject auto-commit true");
        }
    }

    @Test
    @DisplayName("PipelineCatalog.ensure is idempotent: subsequent calls return identical pipeline without duplicates")
    void testEnsureIsIdempotent() throws Exception {
        String firstPipelineId;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ObjectNode first = PipelineCatalog.ensure(conn);
                conn.commit();
                firstPipelineId = first.path("id").asText();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        String secondPipelineId;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ObjectNode second = PipelineCatalog.ensure(conn);
                conn.commit();
                secondPipelineId = second.path("id").asText();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        assertEquals(firstPipelineId, secondPipelineId,
                "Repeat PipelineCatalog.ensure must reuse existing pipeline and return identical ID");

        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.pipeline_bindings WHERE version = 1")) {
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(1, rs.getInt(1), "Exactly one binding row must exist for version 1");
                }
            }
        }
    }

    @Test
    @DisplayName("PipelineCatalog.ensure with concurrent callers creates exactly one pipeline and binding row via advisory transaction lock")
    void testEnsureConcurrentStartupNoDuplicates() throws Exception {
        int threads = 8;
        ExecutorService executor = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch ready = new CountDownLatch(threads);
            CountDownLatch start = new CountDownLatch(1);
            List<Future<String>> futures = new ArrayList<>();

            for (int i = 0; i < threads; i++) {
                futures.add(executor.submit(() -> {
                    ready.countDown();
                    start.await(5, TimeUnit.SECONDS);
                    try (Connection conn = dataSource.getConnection()) {
                        conn.setAutoCommit(false);
                        try {
                            ObjectNode p = PipelineCatalog.ensure(conn);
                            conn.commit();
                            return p.path("id").asText();
                        } catch (Exception e) {
                            conn.rollback();
                            throw e;
                        }
                    }
                }));
            }

            assertTrue(ready.await(5, TimeUnit.SECONDS), "All concurrent threads must reach barrier");
            start.countDown();

            Set<String> observedIds = new HashSet<>();
            for (Future<String> future : futures) {
                String id = future.get(10, TimeUnit.SECONDS);
                assertNotNull(id);
                observedIds.add(id);
            }

            assertEquals(1, observedIds.size(),
                    "All concurrent startup threads must receive the exact same pipeline ID");

            try (Connection conn = dataSource.getConnection()) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.pipeline_bindings WHERE version = 1")) {
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one pipeline binding must exist after concurrent execution");
                    }
                }
            }
        } finally {
            executor.shutdown();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Two concurrent Spring application startups on an isolated fresh fixture create one binding, one fixed pipeline, both healthy, and public search_path")
    void testTwoConcurrentApplicationStartupsOnFreshDatabase() throws Exception {
        String freshDbName = "tenvyr_review_test_concur_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        String freshDbUrl = testDbUrl.replaceFirst("/[a-zA-Z0-9_.-]+(\\?|$)", "/" + freshDbName + "$1");
        ReviewCallbackIT.validateDisposableDatabaseUrl(freshDbUrl);

        try (Connection rootConn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
             Statement stmt = rootConn.createStatement()) {
            stmt.execute("CREATE DATABASE " + freshDbName);
        }

        ConfigurableApplicationContext ctx1 = null;
        ConfigurableApplicationContext ctx2 = null;
        ExecutorService startService = Executors.newFixedThreadPool(2);
        try {
            CyclicBarrier barrier = new CyclicBarrier(2);
            Future<ConfigurableApplicationContext> f1 = startService.submit(() -> {
                barrier.await(5, TimeUnit.SECONDS);
                return createApp(freshDbUrl, Map.of("server.port", "0"));
            });
            Future<ConfigurableApplicationContext> f2 = startService.submit(() -> {
                barrier.await(5, TimeUnit.SECONDS);
                return createApp(freshDbUrl, Map.of("server.port", "0"));
            });

            Throwable t1 = null;
            Throwable t2 = null;
            try {
                ctx1 = f1.get(60, TimeUnit.SECONDS);
            } catch (Throwable t) {
                t1 = t;
            }
            try {
                ctx2 = f2.get(60, TimeUnit.SECONDS);
            } catch (Throwable t) {
                t2 = t;
            }
            if (t1 != null) throw new AssertionError("Application 1 failed to start", t1);
            if (t2 != null) throw new AssertionError("Application 2 failed to start", t2);

            assertNotNull(ctx1);
            assertNotNull(ctx2);
            assertTrue(ctx1.isActive(), "Application 1 must be active and healthy");
            assertTrue(ctx2.isActive(), "Application 2 must be active and healthy");

            // Verify both concurrent apps own distinct ephemeral ports
            Integer port1 = ctx1.getEnvironment().getProperty("local.server.port", Integer.class);
            Integer port2 = ctx2.getEnvironment().getProperty("local.server.port", Integer.class);
            assertNotNull(port1, "Application 1 must be assigned an ephemeral port");
            assertNotNull(port2, "Application 2 must be assigned an ephemeral port");
            assertTrue(port1 > 0, "Application 1 port must be > 0");
            assertTrue(port2 > 0, "Application 2 port must be > 0");
            assertNotEquals(port1, port2, "Both concurrent applications must actually own distinct ephemeral ports");

            // Assert HTTP readiness endpoint UP on both apps
            HttpClient httpClient = HttpClient.newHttpClient();
            HttpRequest req1 = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port1 + "/actuator/health/readiness"))
                    .GET()
                    .build();
            HttpResponse<String> resp1 = httpClient.send(req1, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, resp1.statusCode(), "Application 1 readiness endpoint must return 200");
            assertTrue(resp1.body().contains("\"UP\""), "Application 1 readiness probe must be UP");

            HttpRequest req2 = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port2 + "/actuator/health/readiness"))
                    .GET()
                    .build();
            HttpResponse<String> resp2 = httpClient.send(req2, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, resp2.statusCode(), "Application 2 readiness endpoint must return 200");
            assertTrue(resp2.body().contains("\"UP\""), "Application 2 readiness probe must be UP");

            // Verify database state in the fresh database
            try (Connection conn = DriverManager.getConnection(freshDbUrl, testUser, testPassword)) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM tenvyr_review.pipeline_bindings WHERE version = 1")) {
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one binding must exist after two concurrent startups");
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM pipelines WHERE name = 'review-request-v1'")) {
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Exactly one fixed pipeline row must exist");
                    }
                }
            }

            // Verify all leased pool connections (all 10) have search_path = public for both contexts
            DataSource ds1 = ctx1.getBean(DataSource.class);
            List<Connection> conns1 = new ArrayList<>();
            try {
                for (int i = 0; i < 10; i++) {
                    Connection c = ds1.getConnection();
                    conns1.add(c);
                    try (PreparedStatement ps = c.prepareStatement("SELECT current_schema()")) {
                        try (ResultSet rs = ps.executeQuery()) {
                            assertTrue(rs.next());
                            assertEquals("public", rs.getString(1), "App 1 pool connection " + i + " must have search_path public");
                        }
                    }
                }
            } finally {
                for (Connection c : conns1) {
                    try { c.close(); } catch (Exception ignored) {}
                }
            }

            DataSource ds2 = ctx2.getBean(DataSource.class);
            List<Connection> conns2 = new ArrayList<>();
            try {
                for (int i = 0; i < 10; i++) {
                    Connection c = ds2.getConnection();
                    conns2.add(c);
                    try (PreparedStatement ps = c.prepareStatement("SELECT current_schema()")) {
                        try (ResultSet rs = ps.executeQuery()) {
                            assertTrue(rs.next());
                            assertEquals("public", rs.getString(1), "App 2 pool connection " + i + " must have search_path public");
                        }
                    }
                }
            } finally {
                for (Connection c : conns2) {
                    try { c.close(); } catch (Exception ignored) {}
                }
            }
        } finally {
            startService.shutdown();
            try {
                startService.awaitTermination(5, TimeUnit.SECONDS);
            } catch (Exception ignored) {}

            List<Throwable> cleanupFailures = new ArrayList<>();
            if (ctx1 != null) {
                try { ctx1.close(); } catch (Throwable t) { cleanupFailures.add(t); }
            }
            if (ctx2 != null) {
                try { ctx2.close(); } catch (Throwable t) { cleanupFailures.add(t); }
            }
            try (Connection rootConn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
                 Statement stmt = rootConn.createStatement()) {
                stmt.execute("DROP DATABASE IF EXISTS " + freshDbName + " WITH (FORCE)");
            } catch (Throwable t) {
                cleanupFailures.add(t);
            }

            if (!cleanupFailures.isEmpty()) {
                AssertionError err = new AssertionError("Cleanup failed: " + cleanupFailures.get(0).getMessage(), cleanupFailures.get(0));
                for (int i = 1; i < cleanupFailures.size(); i++) {
                    err.addSuppressed(cleanupFailures.get(i));
                }
                throw err;
            }
        }
    }

    @Test
    @DisplayName("Business Flyway review migration failure on fresh owned DB causes root Flyway/SQL error, pool closed, no readiness, runtime not started")
    void testBusinessFlywayMigrationFailureOnFreshDatabase() throws Exception {
        String freshDbName = "tenvyr_review_test_migfail_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        String freshDbUrl = testDbUrl.replaceFirst("/[a-zA-Z0-9_.-]+(\\?|$)", "/" + freshDbName + "$1");
        ReviewCallbackIT.validateDisposableDatabaseUrl(freshDbUrl);

        try (Connection rootConn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
             Statement stmt = rootConn.createStatement()) {
            stmt.execute("CREATE DATABASE " + freshDbName);
        }

        List<Throwable> cleanupFailures = new ArrayList<>();
        try {
            // Pre-create an incompatible review table to trigger a specific Flyway review migration failure
            try (Connection conn = DriverManager.getConnection(freshDbUrl, testUser, testPassword);
                 Statement stmt = conn.createStatement()) {
                stmt.execute("CREATE SCHEMA tenvyr_review");
                stmt.execute("CREATE TABLE tenvyr_review.users (incompatible_col INT)");
            }

            // Explicitly baseline owned fresh schema at version 0 using Flyway after incompatible table creation
            Flyway.configure()
                    .dataSource(freshDbUrl, testUser, testPassword)
                    .schemas("tenvyr_review")
                    .defaultSchema("tenvyr_review")
                    .baselineVersion("0")
                    .load()
                    .baseline();

            AtomicReference<HikariDataSource> capturedPool = new AtomicReference<>();
            AtomicReference<ControlPlaneRuntime> capturedRuntime = new AtomicReference<>();
            AtomicBoolean readyEventFired = new AtomicBoolean(false);
            ApplicationListener<ApplicationReadyEvent> readyListener = event -> readyEventFired.set(true);

            ConfigurableApplicationContext failedCtx = null;
            Exception thrown = null;
            try {
                failedCtx = createApp(freshDbUrl, Map.of(), capturedPool, capturedRuntime, readyListener);
            } catch (Exception e) {
                thrown = e;
            } finally {
                if (failedCtx != null) {
                    try {
                        failedCtx.close();
                    } catch (Exception ignored) {}
                }
            }

            assertNotNull(thrown, "Startup must fail when review Flyway migration encounters incompatible pre-created table");

            // Assert root cause chain contains PostgreSQL SQLState 42P07 and Flyway V1 migration failure evidence
            Throwable cursor = thrown;
            boolean hasSqlState42P07 = false;
            boolean hasFlywayV1Evidence = false;
            while (cursor != null) {
                if (cursor instanceof SQLException se) {
                    if ("42P07".equals(se.getSQLState())) {
                        hasSqlState42P07 = true;
                    }
                }
                String msg = cursor.getMessage();
                String className = cursor.getClass().getName();
                if ((className.contains("Flyway") || (msg != null && msg.toLowerCase(Locale.ROOT).contains("flyway")))
                        && ((msg != null && msg.contains("V1")) || cursor.toString().contains("V1"))) {
                    hasFlywayV1Evidence = true;
                }
                cursor = cursor.getCause();
            }
            assertTrue(hasSqlState42P07, "Cause chain must contain PostgreSQL SQLState 42P07 (duplicate table), got: " + thrown);
            assertTrue(hasFlywayV1Evidence, "Cause chain must contain Flyway migration failure / V1 evidence, got: " + thrown);

            // Assert no ApplicationReadyEvent / readiness admission
            assertFalse(readyEventFired.get(), "ApplicationReadyEvent must never be emitted on migration failure");

            // Assert child runtime not created
            assertNull(capturedRuntime.get(), "ControlPlaneRuntime must not be created in child context when migration fails");

            // Assert pool closed
            HikariDataSource pool = capturedPool.get();
            assertNotNull(pool, "HikariDataSource pool must be captured during startup");
            assertTrue(pool.isClosed(), "Hikari pool must be closed unconditionally after migration failure");

        } finally {
            try (Connection rootConn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
                 Statement stmt = rootConn.createStatement()) {
                stmt.execute("DROP DATABASE IF EXISTS " + freshDbName + " WITH (FORCE)");
            } catch (Throwable t) {
                cleanupFailures.add(t);
            }

            if (!cleanupFailures.isEmpty()) {
                AssertionError err = new AssertionError("Cleanup failed: " + cleanupFailures.get(0).getMessage(), cleanupFailures.get(0));
                for (int i = 1; i < cleanupFailures.size(); i++) {
                    err.addSuppressed(cleanupFailures.get(i));
                }
                throw err;
            }
        }
    }

    @Test
    @DisplayName("Invalid review environment configuration before DB migrations fails startup, keeps ledger absent, and admits no readiness")
    void testInvalidConfigBeforeDbMigrationsProof() throws Exception {
        String freshDbName = "tenvyr_review_test_cfgfail_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        String freshDbUrl = testDbUrl.replaceFirst("/[a-zA-Z0-9_.-]+(\\?|$)", "/" + freshDbName + "$1");
        ReviewCallbackIT.validateDisposableDatabaseUrl(freshDbUrl);

        try (Connection rootConn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
             Statement stmt = rootConn.createStatement()) {
            stmt.execute("CREATE DATABASE " + freshDbName);
        }

        List<Throwable> cleanupFailures = new ArrayList<>();
        try {
            AtomicBoolean readyEventFired = new AtomicBoolean(false);
            ApplicationListener<ApplicationReadyEvent> readyListener = event -> readyEventFired.set(true);

            // Injected unsupported Kafka config must fail validation before any migrations run
            Exception thrown = assertThrows(Exception.class, () ->
                    createApp(freshDbUrl, Map.of("KAFKA_BROKERS", "localhost:9092"), null, readyListener));

            // Verify actual config failure cause, not accidental wrong reason
            Throwable cursor = thrown;
            boolean hasConfigCause = false;
            while (cursor != null) {
                if (cursor instanceof IllegalStateException && cursor.getMessage() != null &&
                        cursor.getMessage().contains("Kafka configuration is not supported in review mode")) {
                    hasConfigCause = true;
                    break;
                }
                cursor = cursor.getCause();
            }
            assertTrue(hasConfigCause, "Startup failure must be caused by review environment validation: " + thrown);

            // Prove new fresh DB base migration ledger is STILL ABSENT after config failure
            try (Connection conn = DriverManager.getConnection(freshDbUrl, testUser, testPassword);
                 PreparedStatement ps = conn.prepareStatement(
                         "SELECT count(*) FROM information_schema.tables WHERE table_name = 'migrations'")) {
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "Base migrations ledger must still be absent after config validation failure");
                }
            }

            assertFalse(readyEventFired.get(), "ApplicationReadyEvent must never be emitted on config failure");

        } finally {
            try (Connection rootConn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
                 Statement stmt = rootConn.createStatement()) {
                stmt.execute("DROP DATABASE IF EXISTS " + freshDbName + " WITH (FORCE)");
            } catch (Throwable t) {
                cleanupFailures.add(t);
            }

            if (!cleanupFailures.isEmpty()) {
                AssertionError err = new AssertionError("Cleanup failed: " + cleanupFailures.get(0).getMessage(), cleanupFailures.get(0));
                for (int i = 1; i < cleanupFailures.size(); i++) {
                    err.addSuppressed(cleanupFailures.get(i));
                }
                throw err;
            }
        }
    }

    @Test
    @DisplayName("PipelineCatalog.ensure fails on definition hash drift rather than silently rewriting, without corrupting baseline")
    void testEnsureRejectsDefinitionHashDrift() throws Exception {
        // Ensure baseline exists
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                PipelineCatalog.ensure(conn);
                conn.commit();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Inside a rolled-back transaction, tamper with the definition_hash to test rejection
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                String tamperedHash = "0000000000000000000000000000000000000000000000000000000000000000";
                try (PreparedStatement ps = conn.prepareStatement(
                        "UPDATE tenvyr_review.pipeline_bindings SET definition_hash = ? WHERE version = 1")) {
                    ps.setString(1, tamperedHash);
                    assertEquals(1, ps.executeUpdate());
                }

                IllegalStateException thrown = assertThrows(IllegalStateException.class,
                        () -> PipelineCatalog.ensure(conn),
                        "PipelineCatalog.ensure must reject definition hash drift");
                assertTrue(thrown.getMessage().toLowerCase(Locale.ROOT).contains("drift") ||
                                thrown.getMessage().toLowerCase(Locale.ROOT).contains("hash") ||
                                thrown.getMessage().toLowerCase(Locale.ROOT).contains("mismatch"),
                        "Exception message must identify definition hash drift");
            } finally {
                // Roll back so baseline is cleanly restored for other tests
                conn.rollback();
            }
        }
    }

    @Test
    @DisplayName("Definition drift rejects application startup and prevents web readiness admission")
    void testDefinitionDriftRejectsStartup() throws Exception {
        String freshDbName = "tenvyr_review_test_drift_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        String freshDbUrl = testDbUrl.replaceFirst("/[a-zA-Z0-9_.-]+(\\?|$)", "/" + freshDbName + "$1");
        ReviewCallbackIT.validateDisposableDatabaseUrl(freshDbUrl);

        try (Connection rootConn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
             Statement stmt = rootConn.createStatement()) {
            stmt.execute("CREATE DATABASE " + freshDbName);
        }

        ConfigurableApplicationContext ctx = null;
        List<Throwable> cleanupFailures = new ArrayList<>();
        try {
            // First run: initializes schema and catalog normally
            ctx = createApp(freshDbUrl, Map.of("server.port", "0"));
            assertTrue(ctx.isActive());
            ctx.close();
            ctx = null;

            // Tamper with definition_hash in that database
            try (Connection conn = DriverManager.getConnection(freshDbUrl, testUser, testPassword);
                 PreparedStatement ps = conn.prepareStatement(
                         "UPDATE tenvyr_review.pipeline_bindings SET definition_hash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE version = 1")) {
                assertEquals(1, ps.executeUpdate());
            }

            AtomicBoolean readyEventFired = new AtomicBoolean(false);
            ApplicationListener<ApplicationReadyEvent> readyListener = event -> readyEventFired.set(true);

            // Second run: startup must fail with actual drift cause, readiness must never be admitted
            Exception ex = assertThrows(Exception.class, () -> createApp(freshDbUrl, Map.of("server.port", "0"), null, readyListener));
            assertNotNull(ex);

            Throwable cursor = ex;
            boolean hasDriftCause = false;
            while (cursor != null) {
                if (cursor instanceof IllegalStateException && cursor.getMessage() != null &&
                        (cursor.getMessage().toLowerCase(Locale.ROOT).contains("drift") ||
                         cursor.getMessage().toLowerCase(Locale.ROOT).contains("hash"))) {
                    hasDriftCause = true;
                    break;
                }
                cursor = cursor.getCause();
            }
            assertTrue(hasDriftCause, "Exception chain must identify definition hash drift, got: " + ex);
            assertFalse(readyEventFired.get(), "ApplicationReadyEvent must never be admitted when catalog drift occurs");

        } finally {
            if (ctx != null) {
                try { ctx.close(); } catch (Throwable t) { cleanupFailures.add(t); }
            }
            try (Connection rootConn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
                 Statement stmt = rootConn.createStatement()) {
                stmt.execute("DROP DATABASE IF EXISTS " + freshDbName + " WITH (FORCE)");
            } catch (Throwable t) {
                cleanupFailures.add(t);
            }

            if (!cleanupFailures.isEmpty()) {
                AssertionError err = new AssertionError("Cleanup failed: " + cleanupFailures.get(0).getMessage(), cleanupFailures.get(0));
                for (int i = 1; i < cleanupFailures.size(); i++) {
                    err.addSuppressed(cleanupFailures.get(i));
                }
                throw err;
            }
        }
    }

    @Test
    @DisplayName("PipelineCatalog.ensure preserves caller connection ownership, and rollback restores baseline and discards new pipeline")
    void testEnsurePreservesCallerConnectionOwnership() throws Exception {
        UUID baselinePipelineId;
        String baselineHash;

        // 1. Properly capture baseline with explicit commit
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ObjectNode p = PipelineCatalog.ensure(conn);
                conn.commit();
                baselinePipelineId = UUID.fromString(p.path("id").asText());
                baselineHash = Json.hash(PipelineCatalog.definition());
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // 2. Open caller-owned connection, delete binding INSIDE TX, call ensure on SAME connection, assert uncommitted visible, rollback outside ensure
        UUID newTempPipelineId = null;
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                // Delete binding inside TX
                try (PreparedStatement ps = conn.prepareStatement(
                        "DELETE FROM tenvyr_review.pipeline_bindings WHERE version = 1")) {
                    assertEquals(1, ps.executeUpdate(), "Must delete baseline binding inside tx");
                }

                // Call ensure on SAME connection -> creates new pipeline and temp binding
                ObjectNode temp = PipelineCatalog.ensure(conn);
                assertNotNull(temp, "ensure must return created pipeline");
                newTempPipelineId = UUID.fromString(temp.path("id").asText());
                assertNotEquals(baselinePipelineId, newTempPipelineId, "New pipeline ID must be distinct from baseline");

                // Assert uncommitted pipeline and binding are visible inside TX
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT pipeline_id, definition_hash FROM tenvyr_review.pipeline_bindings WHERE version = 1")) {
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next(), "Uncommitted binding must be visible inside TX");
                        assertEquals(newTempPipelineId, rs.getObject("pipeline_id", UUID.class));
                        assertEquals(baselineHash, rs.getString("definition_hash").trim());
                    }
                }
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM pipelines WHERE id = ?::uuid")) {
                    ps.setObject(1, newTempPipelineId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(1, rs.getInt(1), "Uncommitted new pipeline must be visible inside TX");
                    }
                }

                assertFalse(conn.isClosed(), "Caller connection must remain open");
            } finally {
                // Call rollback outside ensure
                conn.rollback();
                conn.setAutoCommit(true);
            }
        }

        // 3. Prove baseline binding restored and new pipeline absent
        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT pipeline_id, definition_hash FROM tenvyr_review.pipeline_bindings WHERE version = 1")) {
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next(), "Baseline binding must be restored after rollback");
                    assertEquals(baselinePipelineId, rs.getObject("pipeline_id", UUID.class));
                    assertEquals(baselineHash, rs.getString("definition_hash").trim());
                }
            }
            if (newTempPipelineId != null) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT count(*) FROM pipelines WHERE id = ?::uuid")) {
                    ps.setObject(1, newTempPipelineId);
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals(0, rs.getInt(1), "New pipeline created in rolled back transaction must be absent");
                    }
                }
            }
        }
    }

    @Test
    @DisplayName("PipelineCatalog.ensure rejects mutation cases: tampered steps with old contentHash OR tampered contentHash with unchanged binding; rollback each")
    void testEnsureRejectsMutationsAndRollsBack() throws Exception {
        UUID baselinePipelineId;

        // Ensure baseline exists
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ObjectNode p = PipelineCatalog.ensure(conn);
                conn.commit();
                baselinePipelineId = UUID.fromString(p.path("id").asText());
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }

        // Mutation Case A: Tamper pipeline.steps with old contentHash
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ObjectNode tamperedStep = PipelineCatalog.definition().path("steps").get(0).deepCopy();
                tamperedStep.put("timeout", "31s");
                String tamperedStepsJson = Json.stringify(Json.array(tamperedStep));
                try (PreparedStatement ps = conn.prepareStatement(
                        "UPDATE pipelines SET steps = ?::jsonb WHERE id = ?::uuid")) {
                    ps.setString(1, tamperedStepsJson);
                    ps.setObject(2, baselinePipelineId);
                    assertEquals(1, ps.executeUpdate());
                }

                assertThrows(IllegalStateException.class, () -> PipelineCatalog.ensure(conn),
                        "PipelineCatalog.ensure must reject tampered steps");
            } finally {
                conn.rollback();
            }
        }

        // Mutation Case B: Tamper contentHash / definition_hash with unchanged binding
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                try (PreparedStatement ps = conn.prepareStatement(
                        "UPDATE public.pipelines SET \"contentHash\" = '0000000000000000000000000000000000000000000000000000000000000000' WHERE id = ?::uuid")) {
                    ps.setObject(1, baselinePipelineId);
                    assertEquals(1, ps.executeUpdate());
                }

                assertThrows(IllegalStateException.class, () -> PipelineCatalog.ensure(conn),
                        "PipelineCatalog.ensure must reject tampered contentHash with unchanged binding");
            } finally {
                conn.rollback();
            }
        }

        // Verify baseline is intact after both mutation rollbacks
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                ObjectNode baseline = PipelineCatalog.ensure(conn);
                conn.commit();
                assertEquals(baselinePipelineId.toString(), baseline.path("id").asText(),
                        "Baseline pipeline must remain intact after rolling back mutation tests");
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        }
    }
}
