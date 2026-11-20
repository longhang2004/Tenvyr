package io.tenvyr.review;

import com.zaxxer.hikari.HikariDataSource;
import io.tenvyr.control.ControlPlaneRuntime;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationPreparedEvent;
import org.springframework.context.ApplicationEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.SmartLifecycle;

import javax.sql.DataSource;
import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T01 Integration Test: Application Lifecycle, Admission Gates, and Shutdown Coordination.
 * Requires real disposable PostgreSQL.
 * Verifies SmartLifecycle ordering, database lock retention across shutdown, and pool shutdown sequencing.
 */
public class ReviewLifecycleIT {

    private static String testDbUrl;
    private static String testUser;
    private static String testPassword;

    private static final String LIFECYCLE_AGENT = "code-reviewer";
    private static final String LIFECYCLE_SECRET = "lifecycle-test-secret-64bytes-long-hmac-sha256-signature-ok";
    private static final String LIFECYCLE_KEY_ID = "lifecycle-key-1";

    private static final Set<String> FORBIDDEN_ROUTING_KEYS = Set.of(
            "pgdbname",
            "pghost",
            "pgport",
            "service",
            "dbname",
            "databasename",
            "database",
            "host",
            "port"
    );

    static void validateDisposableDatabaseUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("Test database URL is required (TENVYR_REVIEW_TEST_DATABASE_URL)");
        }

        if (!raw.startsWith("jdbc:postgresql://")) {
            throw new IllegalArgumentException("Test database URL must be a valid PostgreSQL JDBC URL (jdbc:postgresql://host/db)");
        }

        URI parsed;
        try {
            parsed = URI.create(raw.substring(5));
        } catch (Exception e) {
            throw new IllegalArgumentException("Malformed test database URL");
        }

        if (parsed.getRawFragment() != null) {
            throw new IllegalArgumentException("Malformed test database URL");
        }

        if (parsed.getScheme() == null || !parsed.getScheme().equalsIgnoreCase("postgresql")) {
            throw new IllegalArgumentException("Test database URL must be a valid PostgreSQL JDBC URL");
        }
        if (parsed.getHost() == null || parsed.getHost().isBlank()) {
            throw new IllegalArgumentException("Test database URL must specify a host");
        }

        String path = parsed.getPath();
        if (path == null || path.length() <= 1) {
            throw new IllegalArgumentException("Test database URL must specify a database name");
        }

        String rawDbName = path.substring(1);
        String name;
        try {
            name = java.net.URLDecoder.decode(rawDbName, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalArgumentException("Malformed test database URL: invalid percent decoding");
        }

        if (!name.toLowerCase(Locale.ROOT).matches(".*(?:test|scratch|disposable).*")) {
            throw new IllegalArgumentException("Refusing non-disposable test database. Database name must contain test, scratch, or disposable");
        }

        int qIndex = raw.indexOf('?');
        if (qIndex != -1) {
            String queryPart = raw.substring(qIndex + 1);
            String[] pairs = queryPart.split("&");
            for (String pair : pairs) {
                if (pair.isEmpty()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                String rawKey = eq >= 0 ? pair.substring(0, eq) : pair;
                String decodedKey;
                try {
                    decodedKey = java.net.URLDecoder.decode(rawKey, java.nio.charset.StandardCharsets.UTF_8).trim().toLowerCase(Locale.ROOT);
                } catch (Exception e) {
                    throw new IllegalArgumentException("Malformed test database URL: invalid query parameter encoding");
                }
                if (FORBIDDEN_ROUTING_KEYS.contains(decodedKey)) {
                    throw new IllegalArgumentException("Test database URL must not override database routing in query parameters");
                }
            }
        }
    }

    @BeforeAll
    static void requireRealDisposableDatabase() {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("T01 IT requires real PostgreSQL: TENVYR_REVIEW_TEST_DATABASE_URL must be set");
        }

        validateDisposableDatabaseUrl(raw);

        testUser = System.getenv().getOrDefault("POSTGRES_USER", "postgres");
        testPassword = System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres");
        testDbUrl = raw;
    }

    private ConfigurableApplicationContext createApplicationContext(Map<String, Object> extraProperties) {
        SpringApplication app = new SpringApplication(ReviewApplication.class);
        Map<String, Object> props = new HashMap<>(Map.of(
                "server.port", "0",
                "spring.datasource.url", testDbUrl,
                "spring.datasource.username", testUser,
                "spring.datasource.password", testPassword,
                "HTTP_AGENT_ALLOW_INSECURE", "true",
                "HTTP_AGENT_CALLBACK_BASE_URL", "http://127.0.0.1:8080",
                "TEST_SECRET", LIFECYCLE_SECRET,
                "TEST_TOKEN", "lifecycle-token",
                "AGENT_TRANSPORT_CONFIG", "{\"code-reviewer\":{\"kind\":\"http\",\"submitUrl\":\"http://127.0.0.1:8081/v1/runs\",\"outboundAuthentication\":{\"type\":\"bearer\",\"tokenEnv\":\"TEST_TOKEN\"},\"callbackAuthentication\":{\"keyId\":\"" + LIFECYCLE_KEY_ID + "\",\"secretEnv\":\"TEST_SECRET\"},\"requestTimeoutMs\":2000,\"maxResponseBytes\":65536}}"
        ));
        if (extraProperties != null) {
            props.putAll(extraProperties);
        }
        app.setDefaultProperties(props);
        return app.run();
    }

    @Test
    @DisplayName("Engine runtime starts and becomes active before web admission readiness")
    void engineRuntimeStartsBeforeWebAdmission() {
        ConfigurableApplicationContext context = null;
        try {
            context = createApplicationContext(Map.of());
            assertTrue(context.isActive(), "Application context must be active");

            ControlPlaneRuntime runtime = context.getBean(ControlPlaneRuntime.class);
            assertNotNull(runtime, "ControlPlaneRuntime bean must be registered");
            assertNotNull(runtime.engine(), "EngineService must be initialized");
            assertNotNull(runtime.callbacks(), "HttpAgentAdapter must be initialized");

            SmartLifecycle engineLifecycle = (SmartLifecycle) context.getBean("engineLifecycle");
            assertNotNull(engineLifecycle, "engineLifecycle bean must be present");
            assertTrue(engineLifecycle.isRunning(), "EngineLifecycle must be running once context is started");

            // WebServerStartStopLifecycle runs at Integer.MAX_VALUE - 1; engine runtime must precede web admission
            assertTrue(engineLifecycle.getPhase() < Integer.MAX_VALUE - 2048,
                    "EngineLifecycle phase (" + engineLifecycle.getPhase() + ") must precede web server admission");
        } finally {
            if (context != null && context.isActive()) {
                context.close();
            }
        }
    }

    @Test
    @DisplayName("Shutdown holds/waits on database lock before releasing resources and closing pool")
    void shutdownWaitsForDatabaseLock() throws Exception {
        ConfigurableApplicationContext context = null;
        Connection lockConn = null;
        ExecutorService closer = Executors.newSingleThreadExecutor();
        try {
            context = createApplicationContext(Map.of());
            DataSource dataSource = context.getBean(DataSource.class);
            assertNotNull(dataSource, "DataSource bean must be present");

            HikariDataSource hikariDs = dataSource.unwrap(HikariDataSource.class);
            assertNotNull(hikariDs, "DataSource must be a HikariDataSource");
            assertFalse(hikariDs.isClosed(), "Hikari pool must be open initially");

            // Borrow a dedicated connection from dataSource to hold ACCESS EXCLUSIVE lock on step_attempts
            lockConn = dataSource.getConnection();
            lockConn.setAutoCommit(false);

            long attemptsTableOid;
            try (Statement stmt = lockConn.createStatement();
                 ResultSet rs = stmt.executeQuery("SELECT 'step_attempts'::regclass::oid AS id")) {
                assertTrue(rs.next(), "step_attempts table must exist in schema");
                attemptsTableOid = rs.getLong("id");
            }

            // Acquire ACCESS EXCLUSIVE lock on step_attempts in transaction
            try (Statement stmt = lockConn.createStatement()) {
                stmt.execute("LOCK TABLE step_attempts IN ACCESS EXCLUSIVE MODE");
            }

            // Wait until pg_locks proves the real recovery query is waiting with AccessShareLock on step_attempts
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            boolean recoveryBlocked = false;
            while (!recoveryBlocked && System.nanoTime() < deadline) {
                try (PreparedStatement ps = lockConn.prepareStatement(
                        "SELECT 1 FROM pg_locks WHERE relation=?::oid AND mode='AccessShareLock' AND NOT granted")) {
                    ps.setLong(1, attemptsTableOid);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (rs.next()) {
                            recoveryBlocked = true;
                            break;
                        }
                    }
                }
                Thread.sleep(50);
            }
            assertTrue(recoveryBlocked, "Real recovery query must be blocked waiting on step_attempts AccessShareLock before shutdown");

            // Call actual context.close in a background thread
            ConfigurableApplicationContext closingContext = context;
            CountDownLatch closeStarted = new CountDownLatch(1);
            Future<?> shutdownFuture = closer.submit(() -> {
                closeStarted.countDown();
                closingContext.close();
                return null;
            });

            assertTrue(closeStarted.await(5, TimeUnit.SECONDS), "Shutdown close task must start");

            // Assert that context.close remains blocked while lock is held, and Hikari pool remains open
            Thread.sleep(1500);
            assertFalse(shutdownFuture.isDone(), "context.close() must remain blocked while recovery is waiting on database lock");
            assertFalse(hikariDs.isClosed(), "Hikari pool must remain open while shutdown is blocked waiting for recovery drain");

            // Release the lock (rollback transaction)
            lockConn.rollback();
            lockConn.close();
            lockConn = null;

            // Assert shutdown completes and Hikari pool is closed
            shutdownFuture.get(10, TimeUnit.SECONDS);
            assertTrue(shutdownFuture.isDone(), "context.close() must complete after database lock is released");
            assertFalse(context.isActive(), "Application context must be inactive after close");
            assertTrue(hikariDs.isClosed(), "Hikari pool must be closed after context close completes");

        } finally {
            if (lockConn != null) {
                try {
                    lockConn.rollback();
                    lockConn.close();
                } catch (Exception ignored) {}
            }
            if (context != null && context.isActive()) {
                try {
                    context.close();
                } catch (Exception ignored) {}
            }
            closer.shutdownNow();
        }
    }

    @Test
    @DisplayName("Startup failure during initialization cleans up resources and closes pool cleanly")
    void startupOrMigrationFailureCleansUp() {
        AtomicReference<HikariDataSource> capturedPool = new AtomicReference<>();
        SpringApplication failingApp = new SpringApplication(ReviewApplication.class);
        failingApp.addInitializers((ConfigurableApplicationContext ctx) -> {
            ctx.getBeanFactory().addBeanPostProcessor(new org.springframework.beans.factory.config.BeanPostProcessor() {
                @Override
                public Object postProcessBeforeInitialization(Object bean, String beanName) {
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
                    return bean;
                }
            });
        });

        failingApp.setDefaultProperties(Map.ofEntries(
                Map.entry("server.port", "0"),
                Map.entry("spring.datasource.url", "jdbc:postgresql://127.0.0.1:1/invalid_nonexistent_test_db"),
                Map.entry("spring.datasource.username", testUser),
                Map.entry("spring.datasource.password", testPassword),
                Map.entry("spring.datasource.hikari.connection-timeout", "1000"),
                Map.entry("spring.datasource.hikari.initialization-fail-timeout", "1000"),
                Map.entry("HTTP_AGENT_ALLOW_INSECURE", "true"),
                Map.entry("HTTP_AGENT_CALLBACK_BASE_URL", "http://127.0.0.1:8080"),
                Map.entry("TEST_SECRET", LIFECYCLE_SECRET),
                Map.entry("TEST_TOKEN", "lifecycle-token"),
                Map.entry("AGENT_TRANSPORT_CONFIG", "{\"code-reviewer\":{\"kind\":\"http\",\"submitUrl\":\"http://127.0.0.1:8081/v1/runs\",\"outboundAuthentication\":{\"type\":\"bearer\",\"tokenEnv\":\"TEST_TOKEN\"},\"callbackAuthentication\":{\"keyId\":\"" + LIFECYCLE_KEY_ID + "\",\"secretEnv\":\"TEST_SECRET\"},\"requestTimeoutMs\":2000,\"maxResponseBytes\":65536}}")
        ));

        assertThrows(Exception.class, failingApp::run,
                "Startup against unreachable database must throw during initialization");

        // Verify pool resource cleanup unconditionally
        HikariDataSource pool = capturedPool.get();
        assertNotNull(pool, "HikariDataSource pool must be captured during startup before failure");
        assertTrue(pool.isClosed(), "Captured Hikari pool must be closed unconditionally after real DB initialization fails");

        // Verify no orphaned background recovery or adapter timers left running
        boolean backgroundThreadsRunning = Thread.getAllStackTraces().keySet().stream()
                .anyMatch(t -> t.getName().contains("tenvyr-runtime-recovery") || t.getName().contains("tenvyr-http-adapter"));
        assertFalse(backgroundThreadsRunning,
                "No engine recovery or adapter timer threads may remain running after failed startup");
    }

    @Test
    @DisplayName("Managed Hikari pool closes even if another cleanup component throws an exception")
    void poolClosesEvenIfOtherCleanupThrows() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean probeExecuted = new java.util.concurrent.atomic.AtomicBoolean(false);
        AtomicReference<HikariDataSource> capturedPool = new AtomicReference<>();
        SpringApplication app = new SpringApplication(ReviewApplication.class);
        app.addInitializers((ConfigurableApplicationContext ctx) -> {
            org.springframework.beans.factory.support.DefaultListableBeanFactory beanFactory =
                    (org.springframework.beans.factory.support.DefaultListableBeanFactory) ctx.getBeanFactory();
            beanFactory.registerDisposableBean("cleanupFailureProbe", () -> {
                HikariDataSource pool = capturedPool.get();
                if (pool != null) {
                    assertFalse(pool.isClosed(), "Hikari pool must still be open when other cleanup probe throws");
                }
                probeExecuted.set(true);
                throw new RuntimeException("Simulated cleanup component failure");
            });
            beanFactory.registerDependentBean("engineRuntime", "cleanupFailureProbe");
        });

        Map<String, Object> props = new HashMap<>(Map.of(
                "server.port", "0",
                "spring.datasource.url", testDbUrl,
                "spring.datasource.username", testUser,
                "spring.datasource.password", testPassword,
                "HTTP_AGENT_ALLOW_INSECURE", "true",
                "HTTP_AGENT_CALLBACK_BASE_URL", "http://127.0.0.1:8080",
                "TEST_SECRET", LIFECYCLE_SECRET,
                "TEST_TOKEN", "lifecycle-token",
                "AGENT_TRANSPORT_CONFIG", "{\"code-reviewer\":{\"kind\":\"http\",\"submitUrl\":\"http://127.0.0.1:8081/v1/runs\",\"outboundAuthentication\":{\"type\":\"bearer\",\"tokenEnv\":\"TEST_TOKEN\"},\"callbackAuthentication\":{\"keyId\":\"" + LIFECYCLE_KEY_ID + "\",\"secretEnv\":\"TEST_SECRET\"},\"requestTimeoutMs\":2000,\"maxResponseBytes\":65536}}"
        ));
        app.setDefaultProperties(props);

        ConfigurableApplicationContext context = app.run();
        try {
            DataSource ds = context.getBean(DataSource.class);
            HikariDataSource pool = ds.unwrap(HikariDataSource.class);
            capturedPool.set(pool);
            assertFalse(pool.isClosed(), "Hikari pool must be open while context is active");
        } finally {
            try {
                context.close();
            } catch (Exception ignored) {
                // Expected simulated cleanup failure
            }
        }

        assertTrue(probeExecuted.get(), "Failing cleanup probe must have executed during context shutdown");
        HikariDataSource pool = capturedPool.get();
        assertNotNull(pool, "Hikari pool must have been captured");
        assertTrue(pool.isClosed(), "Hikari pool must be closed unconditionally after context close even when cleanup probe threw");
    }
}
