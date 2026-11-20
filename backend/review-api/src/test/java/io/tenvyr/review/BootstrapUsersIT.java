package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.zaxxer.hikari.HikariDataSource;
import io.tenvyr.platform.Json;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationPreparedEvent;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;

import javax.sql.DataSource;
import java.io.IOException;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T03 Integration Test: Explicit Local User Bootstrap, Bcrypt Password Hashing,
 * Strict Manifest Validation, Conflict Isolation, and All-or-Nothing Transactions.
 * Requires real disposable PostgreSQL (no H2/mocks).
 */
public class BootstrapUsersIT {

    private static String testDbUrl;
    private static String testUser;
    private static String testPassword;

    private final Set<String> ownedUsernames = Collections.synchronizedSet(new HashSet<>());
    private final Set<UUID> ownedUserIds = Collections.synchronizedSet(new HashSet<>());

    @BeforeAll
    static void initAndValidateDatabase() {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("BootstrapUsersIT requires real PostgreSQL: TENVYR_REVIEW_TEST_DATABASE_URL must be set");
        }
        ReviewCallbackIT.validateDisposableDatabaseUrl(raw);

        testDbUrl = raw;
        testUser = System.getenv().getOrDefault("POSTGRES_USER", "postgres");
        testPassword = System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres");

        // Initialize base/catalog/users schema once via controlled no-bootstrap app startup + close
        // before any fixture SQL runs on a fresh database, preserving no implicit seed users
        Set<UUID> beforeInitUuids = readExistingUserUuids();
        ConfigurableApplicationContext initCtx = null;
        try {
            initCtx = createAppStatic(Map.of(), null, null);
        } finally {
            if (initCtx != null) {
                try {
                    initCtx.close();
                } catch (Exception ignored) {}
            }
        }
        Set<UUID> afterInitUuids = readExistingUserUuids();
        assertEquals(beforeInitUuids, afterInitUuids,
                "Initial startup without bootstrap property must not seed any default users");
    }

    private static Set<UUID> readExistingUserUuids() {
        Set<UUID> ids = new HashSet<>();
        try (Connection conn = DriverManager.getConnection(testDbUrl, testUser, testPassword)) {
            try (PreparedStatement ps = conn.prepareStatement("SELECT id FROM tenvyr_review.users")) {
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        ids.add(rs.getObject("id", UUID.class));
                    }
                }
            } catch (SQLException ignored) {
                // Table tenvyr_review.users may not exist before first migration
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to read user UUIDs from database", e);
        }
        return ids;
    }

    @AfterEach
    void cleanBootstrapTestUsers() throws SQLException {
        List<Throwable> cleanupFailures = new ArrayList<>();
        synchronized (ownedUserIds) {
            if (!ownedUserIds.isEmpty()) {
                try (Connection conn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
                     PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.users WHERE id = ?")) {
                    for (UUID id : ownedUserIds) {
                        ps.setObject(1, id);
                        ps.addBatch();
                    }
                    ps.executeBatch();
                } catch (Throwable t) {
                    cleanupFailures.add(t);
                } finally {
                    ownedUserIds.clear();
                }
            }
        }
        synchronized (ownedUsernames) {
            if (!ownedUsernames.isEmpty()) {
                try (Connection conn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
                     PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.users WHERE username = ?")) {
                    for (String uname : ownedUsernames) {
                        ps.setString(1, uname);
                        ps.addBatch();
                    }
                    ps.executeBatch();
                } catch (Throwable t) {
                    cleanupFailures.add(t);
                } finally {
                    ownedUsernames.clear();
                }
            }
        }
        if (!cleanupFailures.isEmpty()) {
            AssertionError err = new AssertionError("Cleanup failed: " + cleanupFailures.get(0).getMessage(), cleanupFailures.get(0));
            for (int i = 1; i < cleanupFailures.size(); i++) {
                err.addSuppressed(cleanupFailures.get(i));
            }
            throw err;
        }
    }

    private String uniqueUsername(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
    }

    private static ConfigurableApplicationContext createAppStatic(
            Map<String, Object> overrides,
            AtomicReference<HikariDataSource> capturedPool,
            AtomicBoolean readyEventFired) {
        SpringApplication app = new SpringApplication(ReviewApplication.class);

        if (readyEventFired != null) {
            app.addListeners((ApplicationListener<ApplicationReadyEvent>) event -> readyEventFired.set(true));
        }

        if (capturedPool != null) {
            app.addListeners((ApplicationListener<ApplicationPreparedEvent>) event -> {
                event.getApplicationContext().getBeanFactory().addBeanPostProcessor(new BeanPostProcessor() {
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
        }

        Map<String, Object> props = new HashMap<>(Map.of(
                "server.port", "0",
                "spring.datasource.url", testDbUrl,
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

        app.addInitializers((ConfigurableApplicationContext ctx) -> {
            ctx.getEnvironment().getPropertySources().addFirst(
                    new org.springframework.core.env.MapPropertySource("highPrecedenceTestProps", props)
            );
        });

        List<String> cliArgs = new ArrayList<>();
        for (Map.Entry<String, Object> entry : props.entrySet()) {
            cliArgs.add("--" + entry.getKey() + "=" + entry.getValue());
        }
        return app.run(cliArgs.toArray(new String[0]));
    }

    private ConfigurableApplicationContext createApp(Map<String, Object> overrides) {
        return createAppStatic(overrides, null, null);
    }

    private static <T extends Throwable> T findCause(Throwable throwable, Class<T> expectedType) {
        Throwable cursor = throwable;
        while (cursor != null) {
            if (expectedType.isInstance(cursor)) {
                boolean fromBootstrap = false;
                for (StackTraceElement frame : cursor.getStackTrace()) {
                    if (frame.getClassName().contains("BootstrapUsers")) {
                        fromBootstrap = true;
                        break;
                    }
                }
                String msg = cursor.getMessage();
                if (fromBootstrap || (msg != null && (msg.toLowerCase(Locale.ROOT).contains("bootstrap") || msg.toLowerCase(Locale.ROOT).contains("manifest")))) {
                    return expectedType.cast(cursor);
                }
            }
            if (cursor.getCause() == cursor) {
                break;
            }
            cursor = cursor.getCause();
        }
        return null;
    }

    private void assertBootstrapFailure(
            Map<String, Object> overrides,
            Class<? extends Throwable> expectedCauseType,
            String failureDescription) {
        AtomicReference<HikariDataSource> capturedPool = new AtomicReference<>();
        AtomicBoolean readyEventFired = new AtomicBoolean(false);
        ConfigurableApplicationContext failedCtx = null;
        Exception thrown = null;
        try {
            failedCtx = createAppStatic(overrides, capturedPool, readyEventFired);
        } catch (Exception e) {
            thrown = e;
        } finally {
            if (failedCtx != null) {
                try {
                    failedCtx.close();
                } catch (Exception ignored) {}
            }
        }

        assertNotNull(thrown, failureDescription + ": startup must fail");

        Throwable expectedCause = findCause(thrown, expectedCauseType);
        assertNotNull(expectedCause, failureDescription + ": expected cause " + expectedCauseType.getSimpleName()
                + " in cause chain, but got: " + thrown);

        assertFalse(readyEventFired.get(), "ApplicationReadyEvent must never be emitted on bootstrap failure");

        HikariDataSource pool = capturedPool.get();
        assertNotNull(pool, "HikariDataSource pool must be captured during startup before initialization");
        assertTrue(pool.isClosed(), "HikariDataSource must be closed unconditionally on startup failure");
    }

    private record CsrfToken(String headerName, String parameterName, String token) {}

    private CsrfToken fetchCsrf(HttpClient client, int port) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/auth/csrf"))
                .GET()
                .build();
        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode());
        JsonNode json = Json.parse(resp.body());
        return new CsrfToken(
                json.path("headerName").asText(),
                json.path("parameterName").asText(),
                json.path("token").asText()
        );
    }

    private HttpResponse<String> login(HttpClient client, int port, String username, String password, CsrfToken csrf) throws Exception {
        String body = "username=" + URLEncoder.encode(username, StandardCharsets.UTF_8) +
                "&password=" + URLEncoder.encode(password, StandardCharsets.UTF_8);
        if (csrf != null && csrf.parameterName() != null && !csrf.parameterName().isBlank()) {
            body += "&" + URLEncoder.encode(csrf.parameterName(), StandardCharsets.UTF_8) +
                    "=" + URLEncoder.encode(csrf.token(), StandardCharsets.UTF_8);
        }

        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/login"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(body));

        if (csrf != null && csrf.headerName() != null && !csrf.headerName().isBlank()) {
            builder.header(csrf.headerName(), csrf.token());
        }

        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    @DisplayName("Bootstrap never runs when review.bootstrap-users-file property is absent")
    void testBootstrapAbsentPropertyNeverRuns() throws Exception {
        String ownedName = uniqueUsername("boot_absent");
        ownedUsernames.add(ownedName);

        Set<UUID> beforeStartupUuids = readExistingUserUuids();

        ConfigurableApplicationContext ctx = null;
        try {
            ctx = createApp(Map.of());
            assertTrue(ctx.isActive(), "Application must start normally when bootstrap property is absent");

            Set<UUID> afterStartupUuids = readExistingUserUuids();
            assertEquals(beforeStartupUuids, afterStartupUuids,
                    "Application startup without bootstrap property must not insert any users into tenvyr_review.users");

            // Verify owned fixture identity was never created
            try (Connection conn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
                 PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.users WHERE username = ?")) {
                ps.setString(1, ownedName);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1), "Owned identity must not exist when property is absent");
                }
            }
        } finally {
            if (ctx != null) {
                try {
                    ctx.close();
                } catch (Exception ignored) {}
            }
        }
    }

    @Test
    @DisplayName("Bootstrap valid manifest persists bcrypt users with generated UUIDs and enables successful form login")
    void testBootstrapValidManifestPersistsUsersAndAllowsLogin(@TempDir Path tempDir) throws Exception {
        Path manifest = tempDir.resolve("valid-bootstrap.json");
        String subUsername = uniqueUsername("boot_valid_sub");
        String subPassword = "subPassword-123!";
        String revUsername = uniqueUsername("boot_valid_rev");
        String revPassword = "revPassword-456!";
        ownedUsernames.add(subUsername);
        ownedUsernames.add(revUsername);

        String content = """
                [
                  {
                    "username": "%s",
                    "password": "%s",
                    "role": "SUBMITTER"
                  },
                  {
                    "username": "%s",
                    "password": "%s",
                    "role": "REVIEWER"
                  }
                ]
                """.formatted(subUsername, subPassword, revUsername, revPassword);
        Files.writeString(manifest, content);

        ConfigurableApplicationContext ctx = null;
        try {
            ctx = createApp(Map.of("review.bootstrap-users-file", manifest.toAbsolutePath().toString()));
            assertTrue(ctx.isActive(), "Application must start successfully with valid bootstrap manifest");

            Integer port = ctx.getEnvironment().getProperty("local.server.port", Integer.class);
            assertNotNull(port);
            assertTrue(port > 0);

            // Verify PostgreSQL persisted data in tenvyr_review.users
            PasswordEncoder encoder = PasswordEncoderFactories.createDelegatingPasswordEncoder();
            try (Connection conn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
                 PreparedStatement ps = conn.prepareStatement(
                         "SELECT id, username, password_hash, role, enabled FROM tenvyr_review.users WHERE username IN (?, ?)")) {
                ps.setString(1, subUsername);
                ps.setString(2, revUsername);
                try (ResultSet rs = ps.executeQuery()) {
                    int count = 0;
                    while (rs.next()) {
                        count++;
                        UUID id = rs.getObject("id", UUID.class);
                        assertNotNull(id, "Generated user ID must be a non-null UUID");
                        ownedUserIds.add(id);

                        String username = rs.getString("username");
                        String hash = rs.getString("password_hash");
                        String role = rs.getString("role");
                        boolean enabled = rs.getBoolean("enabled");

                        assertTrue(enabled, "Bootstrapped user must be enabled");
                        assertTrue(hash.startsWith("{bcrypt}"), "Password hash must start with {bcrypt}");

                        if (subUsername.equals(username)) {
                            assertEquals("SUBMITTER", role);
                            assertTrue(encoder.matches(subPassword, hash), "Password encoder must verify submitter password");
                        } else if (revUsername.equals(username)) {
                            assertEquals("REVIEWER", role);
                            assertTrue(encoder.matches(revPassword, hash), "Password encoder must verify reviewer password");
                        } else {
                            fail("Unexpected username in query: " + username);
                        }
                    }
                    assertEquals(2, count, "Both bootstrap users must be persisted in database");
                }
            }

            // Real HTTP form login test using bootstrapped credentials
            CookieManager cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
            HttpClient client = HttpClient.newBuilder()
                    .cookieHandler(cookieManager)
                    .followRedirects(HttpClient.Redirect.NEVER)
                    .build();

            CsrfToken csrf = fetchCsrf(client, port);
            HttpResponse<String> loginResp = login(client, port, subUsername, subPassword, csrf);
            assertEquals(204, loginResp.statusCode(), "Bootstrapped user must be able to log in with 204 No Content");

            HttpRequest meReq = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/me"))
                    .GET()
                    .build();
            HttpResponse<String> meResp = client.send(meReq, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, meResp.statusCode());
            JsonNode meBody = Json.parse(meResp.body());
            assertEquals(subUsername, meBody.path("username").asText());
            assertEquals("SUBMITTER", meBody.path("role").asText());

        } finally {
            if (ctx != null) {
                try {
                    ctx.close();
                } catch (Exception ignored) {}
            }
        }
    }

    @Test
    @DisplayName("Bootstrap rejects non-existent manifest file path and fails application startup with IOException")
    void testBootstrapRejectsMissingManifestFile(@TempDir Path tempDir) {
        Path missing = tempDir.resolve("missing-file.json");
        assertBootstrapFailure(
                Map.of("review.bootstrap-users-file", missing.toAbsolutePath().toString()),
                IOException.class,
                "Missing manifest file"
        );
    }

    @Test
    @DisplayName("Bootstrap strict manifest validation rejects malformed entries and fails startup with IllegalArgumentException")
    void testBootstrapStrictValidationFailures(@TempDir Path tempDir) throws Exception {
        // 1. Missing password
        String userNoPass = uniqueUsername("boot_sub_nopass");
        ownedUsernames.add(userNoPass);
        Path missingPassword = tempDir.resolve("missing-pass.json");
        Files.writeString(missingPassword, """
                [{"username": "%s", "role": "SUBMITTER"}]
                """.formatted(userNoPass));
        assertBootstrapFailure(
                Map.of("review.bootstrap-users-file", missingPassword.toAbsolutePath().toString()),
                IllegalArgumentException.class,
                "Missing password in bootstrap entry"
        );

        // 2. Duplicate usernames within manifest
        String userDup = uniqueUsername("boot_dup_user");
        ownedUsernames.add(userDup);
        Path duplicateUsers = tempDir.resolve("dup-users.json");
        Files.writeString(duplicateUsers, """
                [
                  {"username": "%s", "password": "pass1", "role": "SUBMITTER"},
                  {"username": "%s", "password": "pass2", "role": "REVIEWER"}
                ]
                """.formatted(userDup, userDup));
        assertBootstrapFailure(
                Map.of("review.bootstrap-users-file", duplicateUsers.toAbsolutePath().toString()),
                IllegalArgumentException.class,
                "Duplicate usernames in manifest"
        );

        // 3. Uppercase username
        String upperSuffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        String userUpper = "Boot_Uppercase_" + upperSuffix;
        ownedUsernames.add(userUpper);
        Path uppercase = tempDir.resolve("uppercase.json");
        Files.writeString(uppercase, """
                [{"username": "%s", "password": "pass", "role": "SUBMITTER"}]
                """.formatted(userUpper));
        assertBootstrapFailure(
                Map.of("review.bootstrap-users-file", uppercase.toAbsolutePath().toString()),
                IllegalArgumentException.class,
                "Uppercase username in manifest"
        );

        // 4. Invalid role
        String userBadRole = uniqueUsername("boot_bad_role");
        ownedUsernames.add(userBadRole);
        Path badRole = tempDir.resolve("bad-role.json");
        Files.writeString(badRole, """
                [{"username": "%s", "password": "pass", "role": "ADMIN"}]
                """.formatted(userBadRole));
        assertBootstrapFailure(
                Map.of("review.bootstrap-users-file", badRole.toAbsolutePath().toString()),
                IllegalArgumentException.class,
                "Unsupported role in manifest"
        );

        // 5. Unknown fields (strict rejection)
        String userUnknownFields = uniqueUsername("boot_unknown_fields");
        ownedUsernames.add(userUnknownFields);
        Path unknownFields = tempDir.resolve("unknown-fields.json");
        Files.writeString(unknownFields, """
                [{"username": "%s", "password": "pass", "role": "SUBMITTER", "injectedField": "evil"}]
                """.formatted(userUnknownFields));
        assertBootstrapFailure(
                Map.of("review.bootstrap-users-file", unknownFields.toAbsolutePath().toString()),
                IllegalArgumentException.class,
                "Unknown properties in manifest"
        );
    }

    @Test
    @DisplayName("Existing username conflict fails startup without resetting password/UUID or partially writing new entry")
    void testBootstrapConflictDoesNotResetOrPartiallyWrite(@TempDir Path tempDir) throws Exception {
        String existingUsername = uniqueUsername("boot_conflict_existing");
        String newUnwrittenUsername = uniqueUsername("boot_conflict_new");
        ownedUsernames.add(existingUsername);
        ownedUsernames.add(newUnwrittenUsername);

        String originalPassword = "originalPassword-123!";
        UUID originalUuid = UUID.randomUUID();
        ownedUserIds.add(originalUuid);

        PasswordEncoder encoder = PasswordEncoderFactories.createDelegatingPasswordEncoder();
        String originalHash = encoder.encode(originalPassword);

        // Pre-insert existing user into tenvyr_review.users
        try (Connection conn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
             PreparedStatement ps = conn.prepareStatement(
                     "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) VALUES (?, ?, ?, 'SUBMITTER', true)")) {
           ps.setObject(1, originalUuid);
           ps.setString(2, existingUsername);
           ps.setString(3, originalHash);
           assertEquals(1, ps.executeUpdate());
        }

        // MUST put NEW owned username FIRST, EXISTING username SECOND
        Path manifest = tempDir.resolve("conflict-manifest.json");
        String content = """
                [
                  {
                    "username": "%s",
                    "password": "newPassword-456!",
                    "role": "SUBMITTER"
                  },
                  {
                    "username": "%s",
                    "password": "attemptedNewPassword-999!",
                    "role": "SUBMITTER"
                  }
                ]
                """.formatted(newUnwrittenUsername, existingUsername);
        Files.writeString(manifest, content);

        // Startup must fail due to conflict on existing user with specific conflict cause
        assertBootstrapFailure(
                Map.of("review.bootstrap-users-file", manifest.toAbsolutePath().toString()),
                IllegalStateException.class,
                "Existing username conflict"
        );

        // Verify existing user was NOT reset or modified in database
        try (Connection conn = DriverManager.getConnection(testDbUrl, testUser, testPassword)) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT id, password_hash FROM tenvyr_review.users WHERE username = ?")) {
                ps.setString(1, existingUsername);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next(), "Existing user must still exist");
                    assertEquals(originalUuid, rs.getObject("id", UUID.class), "UUID must NOT be reset or regenerated");
                    assertEquals(originalHash, rs.getString("password_hash"), "Password hash must NOT be updated or reset");
                }
            }

            // Verify all-or-nothing rollback: first new user in manifest was NOT partially written
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT count(*) FROM tenvyr_review.users WHERE username = ?")) {
                ps.setString(1, newUnwrittenUsername);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals(0, rs.getInt(1),
                            "New user placed first in conflicting manifest must NOT be partially written (all-or-nothing rollback)");
                }
            }
        }
    }

    @Test
    @DisplayName("Invalid or duplicate entries manifest performs all-or-nothing rollback leaving first entry unwritten")
    void testBootstrapInvalidOrDuplicateEntriesAllOrNothing(@TempDir Path tempDir) throws Exception {
        String validFirstUser = uniqueUsername("boot_allnothing_first");
        String duplicateUser = uniqueUsername("boot_allnothing_dup");
        ownedUsernames.add(validFirstUser);
        ownedUsernames.add(duplicateUser);

        // Manifest puts valid user FIRST, duplicate users SECOND/THIRD
        Path manifest = tempDir.resolve("dup-all-or-nothing.json");
        String content = """
                [
                  {
                    "username": "%s",
                    "password": "validPass123!",
                    "role": "SUBMITTER"
                  },
                  {
                    "username": "%s",
                    "password": "pass1",
                    "role": "REVIEWER"
                  },
                  {
                    "username": "%s",
                    "password": "pass2",
                    "role": "REVIEWER"
                  }
                ]
                """.formatted(validFirstUser, duplicateUser, duplicateUser);
        Files.writeString(manifest, content);

        assertBootstrapFailure(
                Map.of("review.bootstrap-users-file", manifest.toAbsolutePath().toString()),
                IllegalArgumentException.class,
                "Duplicate username validation failure"
        );

        // Verify valid first user was NOT partially committed to database
        try (Connection conn = DriverManager.getConnection(testDbUrl, testUser, testPassword);
             PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM tenvyr_review.users WHERE username = ?")) {
            ps.setString(1, validFirstUser);
            try (ResultSet rs = ps.executeQuery()) {
                assertTrue(rs.next());
                assertEquals(0, rs.getInt(1), "First user in manifest with subsequent duplicate must NOT be committed");
            }
        }
    }

    @Test
    @DisplayName("No public user registration or user management endpoints exist")
    void testNoPublicSignupOrUserManagementEndpoints() throws Exception {
        ConfigurableApplicationContext ctx = null;
        try {
            ctx = createApp(Map.of());
            Integer port = ctx.getEnvironment().getProperty("local.server.port", Integer.class);
            assertNotNull(port);

            HttpClient client = HttpClient.newHttpClient();

            HttpRequest postUsers = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/users"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"hacker\",\"password\":\"pass\"}"))
                    .build();
            HttpResponse<String> postUsersResp = client.send(postUsers, HttpResponse.BodyHandlers.ofString());
            assertTrue(postUsersResp.statusCode() == 401 || postUsersResp.statusCode() == 403 || postUsersResp.statusCode() == 404,
                    "POST /api/v1/users must not be accessible, got: " + postUsersResp.statusCode());

            HttpRequest register = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + "/register"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"hacker\",\"password\":\"pass\"}"))
                    .build();
            HttpResponse<String> registerResp = client.send(register, HttpResponse.BodyHandlers.ofString());
            assertTrue(registerResp.statusCode() == 401 || registerResp.statusCode() == 403 || registerResp.statusCode() == 404,
                    "POST /register must not be accessible, got: " + registerResp.statusCode());

            HttpRequest getUsers = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/users"))
                    .GET()
                    .build();
            HttpResponse<String> getUsersResp = client.send(getUsers, HttpResponse.BodyHandlers.ofString());
            assertTrue(getUsersResp.statusCode() == 401 || getUsersResp.statusCode() == 403 || getUsersResp.statusCode() == 404,
                    "GET /api/v1/users must not be accessible, got: " + getUsersResp.statusCode());
        } finally {
            if (ctx != null) {
                try {
                    ctx.close();
                } catch (Exception ignored) {}
            }
        }
    }
}
