package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.domain.ReviewTypes.Role;
import io.tenvyr.review.security.ActorResolver;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.web.bind.annotation.*;

import javax.sql.DataSource;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpCookie;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T03 Integration Test: Spring Security Session Authentication, Real CSRF Rotation,
 * Durable Actors, Dynamic Database Role/Enabled Resolution, Cookie Security, and Owner Visibility.
 * Requires real disposable PostgreSQL (no H2/mocks).
 */
@SpringBootTest(
        classes = {ReviewApplication.class, ReviewSecurityIT.TestSecurityFixtureConfig.class},
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "HTTP_AGENT_ALLOW_INSECURE=true",
                "HTTP_AGENT_CALLBACK_BASE_URL=http://127.0.0.1:8080",
                "TEST_SECRET=" + ReviewCallbackIT.TEST_SECRET,
                "TEST_TOKEN=test-token"
        }
)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
public class ReviewSecurityIT {

    @LocalServerPort
    private int port;

    @Autowired
    private DataSource dataSource;

    @Autowired
    private ActorResolver actorResolver;

    @Autowired
    private UserDetailsService userDetailsService;

    private final Set<UUID> ownedUserIds = Collections.synchronizedSet(new HashSet<>());

    private static String testDbUrl;
    private static String testUser;
    private static String testPassword;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        String raw = System.getenv("TENVYR_REVIEW_TEST_DATABASE_URL");
        if (raw == null || raw.isBlank()) {
            throw new IllegalStateException("ReviewSecurityIT requires real PostgreSQL: TENVYR_REVIEW_TEST_DATABASE_URL must be set");
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

    @AfterEach
    void cleanTestUsers() throws SQLException {
        List<Throwable> cleanupFailures = new ArrayList<>();
        synchronized (ownedUserIds) {
            if (!ownedUserIds.isEmpty()) {
                try (Connection conn = dataSource.getConnection();
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
        if (!cleanupFailures.isEmpty()) {
            AssertionError err = new AssertionError("Cleanup failed: " + cleanupFailures.get(0).getMessage(), cleanupFailures.get(0));
            for (int i = 1; i < cleanupFailures.size(); i++) {
                err.addSuppressed(cleanupFailures.get(i));
            }
            throw err;
        }
    }

    @TestConfiguration
    static class TestSecurityFixtureConfig {
        @RestController
        @RequestMapping("/api/v1/test")
        static class TestFixtureController {
            private final ActorResolver actorResolver;

            TestFixtureController(ActorResolver actorResolver) {
                this.actorResolver = actorResolver;
            }

            @PostMapping(value = "/submitter-action", consumes = MediaType.ALL_VALUE)
            public ResponseEntity<?> submitterAction(Authentication authentication,
                                                     @RequestParam(required = false) String ownerId,
                                                     @RequestParam(required = false) String role,
                                                     @RequestBody(required = false) Map<String, Object> body) {
                Actor actor = actorResolver.current(authentication);
                if (actor.role() != Role.SUBMITTER) {
                    throw new AccessDeniedException("Submitter role required");
                }
                return ResponseEntity.ok(Map.of(
                        "actorId", actor.id().toString(),
                        "username", actor.username(),
                        "role", actor.role().name()
                ));
            }

            @GetMapping("/reviewer-action")
            public ResponseEntity<?> reviewerAction(Authentication authentication) {
                Actor actor = actorResolver.current(authentication);
                if (actor.role() != Role.REVIEWER) {
                    throw new AccessDeniedException("Reviewer role required");
                }
                return ResponseEntity.ok(Map.of(
                        "actorId", actor.id().toString(),
                        "username", actor.username(),
                        "role", actor.role().name()
                ));
            }

            @GetMapping("/resources/{ownerId}")
            public ResponseEntity<?> readResource(Authentication authentication, @PathVariable UUID ownerId) {
                Actor actor = actorResolver.current(authentication);
                if (actor.role() == Role.REVIEWER || actor.id().equals(ownerId)) {
                    return ResponseEntity.ok(Map.of(
                            "ownerId", ownerId.toString(),
                            "actorId", actor.id().toString()
                    ));
                }
                return ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("code", "NOT_FOUND", "message", "Resource not found"));
            }
        }
    }

    private record CsrfToken(String headerName, String parameterName, String token) {}

    private String uniqueUsername(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
    }

    private HttpClient createHttpClient(CookieManager cookieManager) {
        return HttpClient.newBuilder()
                .cookieHandler(cookieManager)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    private UUID insertTestUser(String username, String rawPassword, String role, boolean enabled) throws SQLException {
        UUID id = UUID.randomUUID();
        PasswordEncoder encoder = PasswordEncoderFactories.createDelegatingPasswordEncoder();
        String hash = encoder.encode(rawPassword);
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(
                     "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) VALUES (?, ?, ?, ?, ?)")) {
            ps.setObject(1, id);
            ps.setString(2, username);
            ps.setString(3, hash);
            ps.setString(4, role);
            ps.setBoolean(5, enabled);
            assertEquals(1, ps.executeUpdate());
        }
        ownedUserIds.add(id);
        return id;
    }

    private void assertSafeErrorJson(HttpResponse<String> resp, int expectedStatus, String expectedCode) {
        assertEquals(expectedStatus, resp.statusCode());
        String contentType = resp.headers().firstValue("Content-Type").orElse("");
        assertTrue(contentType.startsWith("application/json"),
                "Error response must be application/json, got: " + contentType);
        String body = resp.body();
        assertFalse(body.toLowerCase(Locale.ROOT).contains("<html>"), "Response must not contain HTML");
        assertFalse(body.toLowerCase(Locale.ROOT).contains("password"), "Response must not leak password");
        assertFalse(body.toLowerCase(Locale.ROOT).contains("hash"), "Response must not leak hash");
        assertFalse(body.toLowerCase(Locale.ROOT).contains("exception"), "Response must not leak exception");
        assertFalse(body.toLowerCase(Locale.ROOT).contains("sqlstate"), "Response must not leak sqlstate");

        JsonNode json = Json.parse(body);
        assertTrue(json.isObject(), "Error response must be a JSON object");

        Set<String> keys = new HashSet<>();
        json.fieldNames().forEachRemaining(keys::add);
        assertEquals(Set.of("code", "message", "requestId"), keys,
                "Error JSON must contain exact {code, message, requestId} fields, got: " + keys);

        String code = json.path("code").asText();
        assertFalse(code.isBlank(), "code must not be blank");
        assertTrue(code.length() <= 64, "code length must be bounded");
        if (expectedCode != null) {
            assertEquals(expectedCode, code);
        }

        String message = json.path("message").asText();
        assertFalse(message.isBlank(), "message must not be blank");
        assertTrue(message.length() <= 256, "message length must be bounded");

        String requestId = json.path("requestId").asText();
        assertDoesNotThrow(() -> UUID.fromString(requestId),
                "requestId must be a valid UUID, got: " + requestId);
    }

    private CsrfToken fetchCsrf(HttpClient client) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/auth/csrf"))
                .GET()
                .build();
        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, resp.statusCode(), "CSRF endpoint must return 200 OK");
        String cacheControl = resp.headers().firstValue("Cache-Control").orElse("");
        assertTrue(cacheControl.contains("no-store"), "CSRF endpoint must return Cache-Control: no-store, got: " + cacheControl);

        JsonNode json = Json.parse(resp.body());
        assertTrue(json.hasNonNull("headerName"), "CSRF response must include headerName");
        assertTrue(json.hasNonNull("parameterName"), "CSRF response must include parameterName");
        assertTrue(json.hasNonNull("token"), "CSRF response must include token");

        return new CsrfToken(
                json.path("headerName").asText(),
                json.path("parameterName").asText(),
                json.path("token").asText()
        );
    }

    private HttpResponse<String> login(HttpClient client, String username, String password, CsrfToken csrf) throws Exception {
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

    private HttpResponse<String> logout(HttpClient client, CsrfToken csrf) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/logout"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.noBody());

        if (csrf != null && csrf.headerName() != null && !csrf.headerName().isBlank()) {
            builder.header(csrf.headerName(), csrf.token());
        }

        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    @DisplayName("GET /api/v1/me anonymously returns 401 JSON safe error (no HTML redirect)")
    void testAnonymousMeReturns401JsonSafeError() throws Exception {
        HttpClient client = createHttpClient(new CookieManager());
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/me"))
                .GET()
                .build();
        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        assertSafeErrorJson(resp, 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("GET /api/v1/auth/csrf anonymously returns 200 OK with no-store and token details")
    void testCsrfEndpointAnonymous200NoStore() throws Exception {
        HttpClient client = createHttpClient(new CookieManager());
        CsrfToken token = fetchCsrf(client);

        assertNotNull(token.headerName());
        assertNotNull(token.parameterName());
        assertNotNull(token.token());
        assertFalse(token.token().isBlank(), "CSRF token must not be blank");
    }

    @Test
    @DisplayName("Standard form login POST /login without CSRF returns 403 Forbidden JSON safe error")
    void testStandardFormLoginWithoutCsrfReturns403() throws Exception {
        String username = uniqueUsername("test_sec_user_nocsrf");
        String password = "testPassword-123!";
        insertTestUser(username, password, "SUBMITTER", true);

        HttpClient client = createHttpClient(new CookieManager());
        HttpResponse<String> resp = login(client, username, password, null);
        assertSafeErrorJson(resp, 403, null);
    }

    @Test
    @DisplayName("Standard form login POST /login with invalid password returns 401 Unauthorized JSON safe error")
    void testStandardFormLoginInvalidPasswordReturns401Json() throws Exception {
        String username = uniqueUsername("test_sec_user_badpass");
        String password = "correctPassword-123!";
        insertTestUser(username, password, "SUBMITTER", true);

        HttpClient client = createHttpClient(new CookieManager());
        CsrfToken csrf = fetchCsrf(client);

        HttpResponse<String> resp = login(client, username, "wrongPassword-999!", csrf);
        assertSafeErrorJson(resp, 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("Standard form login POST /login for disabled user returns 401 Unauthorized JSON")
    void testStandardFormLoginDisabledUserReturns401() throws Exception {
        String username = uniqueUsername("test_sec_user_disabled");
        String password = "validPassword-123!";
        insertTestUser(username, password, "SUBMITTER", false);

        HttpClient client = createHttpClient(new CookieManager());
        CsrfToken csrf = fetchCsrf(client);

        HttpResponse<String> resp = login(client, username, password, csrf);
        assertSafeErrorJson(resp, 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("Standard form login POST /login with valid credentials returns 204 No Content and sets session cookie")
    void testStandardFormLoginValidCredentialsReturns204WithSessionCookie() throws Exception {
        String username = uniqueUsername("test_sec_user_valid");
        String password = "validPassword-123!";
        insertTestUser(username, password, "SUBMITTER", true);

        CookieManager cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient client = createHttpClient(cookieManager);
        CsrfToken csrf = fetchCsrf(client);

        HttpResponse<String> resp = login(client, username, password, csrf);

        assertEquals(204, resp.statusCode(), "Valid form login must return 204 No Content according to SPEC");
        List<HttpCookie> cookies = cookieManager.getCookieStore().get(URI.create("http://127.0.0.1:" + port));
        boolean hasSessionCookie = cookies.stream().anyMatch(c -> "JSESSIONID".equalsIgnoreCase(c.getName()));
        assertTrue(hasSessionCookie, "Valid login must establish a JSESSIONID session cookie");
    }

    @Test
    @DisplayName("Login rotates session fixation and requires fresh CSRF token for mutations on new session")
    void testSessionFixationAndRealCsrfRotation() throws Exception {
        String username = uniqueUsername("test_sec_fixation");
        String password = "validPassword-123!";
        insertTestUser(username, password, "SUBMITTER", true);

        CookieManager cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient client = createHttpClient(cookieManager);

        CsrfToken preLoginCsrf = fetchCsrf(client);
        List<HttpCookie> preLoginCookies = cookieManager.getCookieStore().get(URI.create("http://127.0.0.1:" + port));
        String preLoginSessionId = preLoginCookies.stream()
                .filter(c -> "JSESSIONID".equalsIgnoreCase(c.getName()))
                .map(HttpCookie::getValue)
                .findFirst()
                .orElse(null);

        assertNotNull(preLoginSessionId, "Pre-login session ID must exist");

        HttpResponse<String> loginResp = login(client, username, password, preLoginCsrf);
        assertEquals(204, loginResp.statusCode());

        List<HttpCookie> postLoginCookies = cookieManager.getCookieStore().get(URI.create("http://127.0.0.1:" + port));
        String postLoginSessionId = postLoginCookies.stream()
                .filter(c -> "JSESSIONID".equalsIgnoreCase(c.getName()))
                .map(HttpCookie::getValue)
                .findFirst()
                .orElse(null);

        assertNotNull(postLoginSessionId, "Post-login session ID must exist");
        assertNotEquals(preLoginSessionId, postLoginSessionId,
                "Session fixation defense must assign a new session ID upon authentication");

        // 1. Send old pre-login CSRF token with the NEW session to authenticated unsafe test fixture => 403
        HttpRequest staleMutationReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/submitter-action"))
                .header(preLoginCsrf.headerName(), preLoginCsrf.token())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> staleResp = client.send(staleMutationReq, HttpResponse.BodyHandlers.ofString());
        assertSafeErrorJson(staleResp, 403, null);

        // 2. Fetch new CSRF token and same mutation succeeds => 200
        CsrfToken postLoginCsrf = fetchCsrf(client);
        HttpRequest validMutationReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/submitter-action"))
                .header(postLoginCsrf.headerName(), postLoginCsrf.token())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> validResp = client.send(validMutationReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, validResp.statusCode());

        // 3. Authenticated mutation without CSRF => 403
        HttpRequest noCsrfMutationReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/submitter-action"))
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> noCsrfResp = client.send(noCsrfMutationReq, HttpResponse.BodyHandlers.ofString());
        assertSafeErrorJson(noCsrfResp, 403, null);
    }

    @Test
    @DisplayName("Authenticated GET /api/v1/me returns real durable UUID, username, and role from tenvyr_review.users")
    void testAuthenticatedMeReturnsDurableActorUuidAndRole() throws Exception {
        String subUsername = uniqueUsername("test_sec_me_sub");
        String subPassword = "passwordSub-123!";
        UUID subUuid = insertTestUser(subUsername, subPassword, "SUBMITTER", true);

        CookieManager subCookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient subClient = createHttpClient(subCookieManager);
        CsrfToken subCsrf = fetchCsrf(subClient);
        assertEquals(204, login(subClient, subUsername, subPassword, subCsrf).statusCode());

        HttpRequest meReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/me"))
                .GET()
                .build();
        HttpResponse<String> meResp = subClient.send(meReq, HttpResponse.BodyHandlers.ofString());

        assertEquals(200, meResp.statusCode(), "Authenticated GET /api/v1/me must return 200 OK");
        JsonNode subNode = Json.parse(meResp.body());
        assertEquals(subUuid.toString(), subNode.path("id").asText(), "Actor ID must match real persisted UUID");
        assertEquals(subUsername, subNode.path("username").asText());
        assertEquals("SUBMITTER", subNode.path("role").asText());

        String revUsername = uniqueUsername("test_sec_me_rev");
        String revPassword = "passwordRev-123!";
        UUID revUuid = insertTestUser(revUsername, revPassword, "REVIEWER", true);

        CookieManager revCookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient revClient = createHttpClient(revCookieManager);
        CsrfToken revCsrf = fetchCsrf(revClient);
        assertEquals(204, login(revClient, revUsername, revPassword, revCsrf).statusCode());

        HttpResponse<String> revMeResp = revClient.send(meReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, revMeResp.statusCode());
        JsonNode revNode = Json.parse(revMeResp.body());
        assertEquals(revUuid.toString(), revNode.path("id").asText());
        assertEquals(revUsername, revNode.path("username").asText());
        assertEquals("REVIEWER", revNode.path("role").asText());
    }

    @Test
    @DisplayName("POST /logout requires CSRF, invalidates session, and old CSRF token cannot login while fresh anonymous CSRF can")
    void testLogoutRequiresCsrfInvalidatesSessionAndRotatesTokens() throws Exception {
        String username = uniqueUsername("test_sec_logout");
        String password = "validPassword-123!";
        insertTestUser(username, password, "SUBMITTER", true);

        CookieManager cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient client = createHttpClient(cookieManager);
        CsrfToken csrf = fetchCsrf(client);
        assertEquals(204, login(client, username, password, csrf).statusCode());

        // Logout without CSRF token must fail with 403 Forbidden
        HttpResponse<String> noCsrfLogoutResp = logout(client, null);
        assertSafeErrorJson(noCsrfLogoutResp, 403, null);

        // Obtain post-login CSRF token and perform valid logout
        CsrfToken activeCsrf = fetchCsrf(client);
        HttpResponse<String> validLogoutResp = logout(client, activeCsrf);
        assertEquals(204, validLogoutResp.statusCode(), "Logout with valid CSRF must return 204 No Content");

        // Subsequent GET /api/v1/me with invalidated session must return 401 Unauthorized
        HttpRequest meReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/me"))
                .GET()
                .build();
        HttpResponse<String> afterLogoutMeResp = client.send(meReq, HttpResponse.BodyHandlers.ofString());
        assertSafeErrorJson(afterLogoutMeResp, 401, "UNAUTHORIZED");

        // Fetch fresh anonymous CSRF token
        CsrfToken freshAnonCsrf = fetchCsrf(client);

        // Attempt POST /login using OLD pre-logout CSRF token => 403 Forbidden
        HttpResponse<String> oldTokenLoginResp = login(client, username, password, activeCsrf);
        assertSafeErrorJson(oldTokenLoginResp, 403, null);

        // Attempt POST /login using FRESH anonymous CSRF token => 204 No Content
        HttpResponse<String> freshTokenLoginResp = login(client, username, password, freshAnonCsrf);
        assertEquals(204, freshTokenLoginResp.statusCode(), "Login with fresh anonymous CSRF token must succeed with 204");
    }

    @Test
    @DisplayName("UserDetailsService loads persisted users and maps DB role to ROLE_ authorities")
    void testUserDetailsServiceLoadsPersistedUsersAndMapsRoles() throws Exception {
        String subUsername = uniqueUsername("test_sec_uds_sub");
        String revUsername = uniqueUsername("test_sec_uds_rev");
        insertTestUser(subUsername, "subPassword-123!", "SUBMITTER", true);
        insertTestUser(revUsername, "revPassword-123!", "REVIEWER", true);

        UserDetails subDetails = userDetailsService.loadUserByUsername(subUsername);
        assertNotNull(subDetails);
        assertEquals(subUsername, subDetails.getUsername());
        Set<String> subAuthorities = subDetails.getAuthorities().stream()
                .map(org.springframework.security.core.GrantedAuthority::getAuthority)
                .collect(java.util.stream.Collectors.toSet());
        assertEquals(Set.of("ROLE_SUBMITTER"), subAuthorities,
                "Persisted SUBMITTER must have exact singleton authority set {ROLE_SUBMITTER}");

        UserDetails revDetails = userDetailsService.loadUserByUsername(revUsername);
        assertNotNull(revDetails);
        assertEquals(revUsername, revDetails.getUsername());
        Set<String> revAuthorities = revDetails.getAuthorities().stream()
                .map(org.springframework.security.core.GrantedAuthority::getAuthority)
                .collect(java.util.stream.Collectors.toSet());
        assertEquals(Set.of("ROLE_REVIEWER"), revAuthorities,
                "Persisted REVIEWER must have exact singleton authority set {ROLE_REVIEWER}");
    }

    @Test
    @DisplayName("Visibility rules: minimal owner-read returns 200 for own/reviewer, 404 for A reading B; query and JSON body spoofing rejected")
    void testVisibilityRulesAndImpersonationSpoofRejection() throws Exception {
        String userA = uniqueUsername("test_sec_user_a");
        String userB = uniqueUsername("test_sec_user_b");
        String userRev = uniqueUsername("test_sec_user_rev");
        String pass = "pass123!";

        UUID idA = insertTestUser(userA, pass, "SUBMITTER", true);
        UUID idB = insertTestUser(userB, pass, "SUBMITTER", true);
        UUID idRev = insertTestUser(userRev, pass, "REVIEWER", true);

        // Client A
        CookieManager cookieA = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient clientA = createHttpClient(cookieA);
        CsrfToken csrfA = fetchCsrf(clientA);
        assertEquals(204, login(clientA, userA, pass, csrfA).statusCode());
        csrfA = fetchCsrf(clientA);

        // Client B
        CookieManager cookieB = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient clientB = createHttpClient(cookieB);
        CsrfToken csrfB = fetchCsrf(clientB);
        assertEquals(204, login(clientB, userB, pass, csrfB).statusCode());

        // Client Rev
        CookieManager cookieRev = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient clientRev = createHttpClient(cookieRev);
        CsrfToken csrfRev = fetchCsrf(clientRev);
        assertEquals(204, login(clientRev, userRev, pass, csrfRev).statusCode());
        csrfRev = fetchCsrf(clientRev);

        // 1. Submitter A reading own resource -> 200
        HttpRequest aReadsA = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/resources/" + idA))
                .GET()
                .build();
        assertEquals(200, clientA.send(aReadsA, HttpResponse.BodyHandlers.ofString()).statusCode());

        // 2. Reviewer reading A's resource -> 200
        HttpRequest revReadsA = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/resources/" + idA))
                .GET()
                .build();
        assertEquals(200, clientRev.send(revReadsA, HttpResponse.BodyHandlers.ofString()).statusCode());

        // 3. Submitter A reading B's resource -> 404
        HttpRequest aReadsB = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/resources/" + idB))
                .GET()
                .build();
        HttpResponse<String> aReadsBResp = clientA.send(aReadsB, HttpResponse.BodyHandlers.ofString());
        assertEquals(404, aReadsBResp.statusCode(), "Submitter A reading Submitter B's resource must return 404");

        // 4. Query spoof on unsafe fixture: Submitter A passes ownerId=idB and role=REVIEWER
        HttpRequest querySpoofReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/submitter-action?ownerId=" + idB + "&role=REVIEWER"))
                .header(csrfA.headerName(), csrfA.token())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> querySpoofResp = clientA.send(querySpoofReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, querySpoofResp.statusCode());
        JsonNode querySpoofBody = Json.parse(querySpoofResp.body());
        assertEquals(idA.toString(), querySpoofBody.path("actorId").asText(),
                "Actor ID must remain A despite query parameter spoofing");
        assertEquals("SUBMITTER", querySpoofBody.path("role").asText());

        // 5. JSON body spoof on unsafe fixture: Submitter A passes JSON body with ownerId=idB and role=REVIEWER
        String spoofJson = "{\"ownerId\":\"" + idB + "\",\"role\":\"REVIEWER\"}";
        HttpRequest bodySpoofReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/submitter-action"))
                .header("Content-Type", "application/json")
                .header(csrfA.headerName(), csrfA.token())
                .POST(HttpRequest.BodyPublishers.ofString(spoofJson))
                .build();
        HttpResponse<String> bodySpoofResp = clientA.send(bodySpoofReq, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, bodySpoofResp.statusCode());
        JsonNode bodySpoofNode = Json.parse(bodySpoofResp.body());
        assertEquals(idA.toString(), bodySpoofNode.path("actorId").asText(),
                "Actor ID must remain A despite JSON body spoofing");
        assertEquals("SUBMITTER", bodySpoofNode.path("role").asText());

        // 6. Reviewer cannot Submit: reviewer attempting submitter-action fixture throws AccessDeniedException => 403
        HttpRequest revSubmitReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/submitter-action"))
                .header(csrfRev.headerName(), csrfRev.token())
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> revSubmitResp = clientRev.send(revSubmitReq, HttpResponse.BodyHandlers.ofString());
        assertSafeErrorJson(revSubmitResp, 403, null);
    }

    @Test
    @DisplayName("ActorResolver dynamic lookup rejects disabled or deleted users on existing active sessions")
    void testActorResolverDynamicLookupRejectsDisabledOrDeletedUser() throws Exception {
        String username = uniqueUsername("test_sec_dynamic_user");
        String password = "validPassword-123!";
        UUID userId = insertTestUser(username, password, "SUBMITTER", true);

        CookieManager cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient client = createHttpClient(cookieManager);
        CsrfToken csrf = fetchCsrf(client);
        assertEquals(204, login(client, username, password, csrf).statusCode());

        HttpRequest meReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/me"))
                .GET()
                .build();
        assertEquals(200, client.send(meReq, HttpResponse.BodyHandlers.ofString()).statusCode());

        // Mark user disabled in PostgreSQL while session is active
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET enabled = false WHERE id = ?")) {
            ps.setObject(1, userId);
            assertEquals(1, ps.executeUpdate());
        }

        // Subsequent request on the same active session must be rejected with 401 safe error
        HttpResponse<String> disabledResp = client.send(meReq, HttpResponse.BodyHandlers.ofString());
        assertSafeErrorJson(disabledResp, 401, "UNAUTHORIZED");

        // Re-enable user, verify it succeeds, then delete user
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET enabled = true WHERE id = ?")) {
            ps.setObject(1, userId);
            assertEquals(1, ps.executeUpdate());
        }
        assertEquals(200, client.send(meReq, HttpResponse.BodyHandlers.ofString()).statusCode());

        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("DELETE FROM tenvyr_review.users WHERE id = ?")) {
            ps.setObject(1, userId);
            assertEquals(1, ps.executeUpdate());
        }

        HttpResponse<String> deletedResp = client.send(meReq, HttpResponse.BodyHandlers.ofString());
        assertSafeErrorJson(deletedResp, 401, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("ActorResolver dynamic lookup rejects stale changed role privilege on active session")
    void testActorResolverDynamicLookupRejectsStaleChangedRole() throws Exception {
        String username = uniqueUsername("test_sec_stale_role");
        String password = "validPassword-123!";
        UUID userId = insertTestUser(username, password, "REVIEWER", true);

        CookieManager cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient client = createHttpClient(cookieManager);
        CsrfToken csrf = fetchCsrf(client);
        assertEquals(204, login(client, username, password, csrf).statusCode());

        // Access reviewer-action fixture
        HttpRequest revReq = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/test/reviewer-action"))
                .GET()
                .build();
        assertEquals(200, client.send(revReq, HttpResponse.BodyHandlers.ofString()).statusCode());

        // In database, change user role from REVIEWER to SUBMITTER
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement("UPDATE tenvyr_review.users SET role = 'SUBMITTER' WHERE id = ?")) {
            ps.setObject(1, userId);
            assertEquals(1, ps.executeUpdate());
        }

        // Active session must immediately reject access to reviewer-only action with 403 Forbidden
        HttpResponse<String> deniedRevResp = client.send(revReq, HttpResponse.BodyHandlers.ofString());
        assertSafeErrorJson(deniedRevResp, 403, null);
    }

    @Test
    @DisplayName("Default HTTP profile sets Secure=false, HttpOnly, and SameSite=Lax")
    void testCookieSecurityHeaders() throws Exception {
        String username = uniqueUsername("test_sec_cookie");
        String password = "validPassword-123!";
        insertTestUser(username, password, "SUBMITTER", true);

        CookieManager cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        HttpClient client = createHttpClient(cookieManager);
        CsrfToken csrf = fetchCsrf(client);

        HttpResponse<String> resp = login(client, username, password, csrf);
        assertEquals(204, resp.statusCode());

        List<String> setCookies = resp.headers().allValues("Set-Cookie");
        assertFalse(setCookies.isEmpty(), "Set-Cookie header must be present on login");

        String sessionSetCookie = setCookies.stream()
                .filter(header -> header.contains("JSESSIONID"))
                .findFirst()
                .orElse(null);
        assertNotNull(sessionSetCookie, "Set-Cookie header must contain JSESSIONID");

        assertTrue(sessionSetCookie.toLowerCase(Locale.ROOT).contains("httponly"),
                "Session cookie must be HttpOnly");
        assertTrue(sessionSetCookie.toLowerCase(Locale.ROOT).contains("samesite=lax"),
                "Session cookie must specify SameSite=Lax");
        assertFalse(sessionSetCookie.toLowerCase(Locale.ROOT).contains("secure"),
                "Default HTTP profile must set Secure=false");
    }

    @Test
    @DisplayName("HTTPS deployment profile enforces Secure=true, HttpOnly, and SameSite=Lax on cookies")
    void testHttpsProfileEnforcesSecureCookie() throws Exception {
        SpringApplication app = new SpringApplication(ReviewApplication.class);
        Map<String, Object> props = new HashMap<>(Map.of(
                "server.port", "0",
                "spring.profiles.active", "https",
                "spring.datasource.url", testDbUrl,
                "spring.datasource.username", testUser,
                "spring.datasource.password", testPassword,
                "HTTP_AGENT_ALLOW_INSECURE", "true",
                "HTTP_AGENT_CALLBACK_BASE_URL", "http://127.0.0.1:8080",
                "TEST_SECRET", ReviewCallbackIT.TEST_SECRET,
                "TEST_TOKEN", "test-token",
                "AGENT_TRANSPORT_CONFIG", "{\"code-reviewer\":{\"kind\":\"http\",\"submitUrl\":\"http://127.0.0.1:8081/v1/runs\",\"outboundAuthentication\":{\"type\":\"bearer\",\"tokenEnv\":\"TEST_TOKEN\"},\"callbackAuthentication\":{\"keyId\":\"" + ReviewCallbackIT.TEST_KEY_ID + "\",\"secretEnv\":\"TEST_SECRET\"},\"requestTimeoutMs\":2000,\"maxResponseBytes\":65536}}"
        ));

        app.addInitializers((ConfigurableApplicationContext ctx) -> {
            ctx.getEnvironment().getPropertySources().addFirst(
                    new org.springframework.core.env.MapPropertySource("highPrecedenceTestProps", props)
            );
        });

        List<String> cliArgs = new ArrayList<>();
        for (Map.Entry<String, Object> entry : props.entrySet()) {
            cliArgs.add("--" + entry.getKey() + "=" + entry.getValue());
        }

        ConfigurableApplicationContext childCtx = null;
        try {
            childCtx = app.run(cliArgs.toArray(new String[0]));
            Integer childPort = childCtx.getEnvironment().getProperty("local.server.port", Integer.class);
            assertNotNull(childPort);

            HttpClient client = HttpClient.newBuilder()
                    .followRedirects(HttpClient.Redirect.NEVER)
                    .build();

            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + childPort + "/api/v1/auth/csrf"))
                    .GET()
                    .build();
            HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, resp.statusCode());

            List<String> setCookies = resp.headers().allValues("Set-Cookie");
            assertFalse(setCookies.isEmpty(), "Set-Cookie header must be present on /api/v1/auth/csrf");

            String sessionSetCookie = setCookies.stream()
                    .filter(header -> header.contains("JSESSIONID"))
                    .findFirst()
                    .orElse(null);
            assertNotNull(sessionSetCookie, "Set-Cookie header must contain JSESSIONID, got: " + setCookies);

            assertTrue(sessionSetCookie.toLowerCase(Locale.ROOT).contains("secure"),
                    "HTTPS profile must set Secure attribute on session cookie, got: " + sessionSetCookie);
            assertTrue(sessionSetCookie.toLowerCase(Locale.ROOT).contains("httponly"),
                    "Session cookie must be HttpOnly");
            assertTrue(sessionSetCookie.toLowerCase(Locale.ROOT).contains("samesite=lax"),
                    "Session cookie must specify SameSite=Lax");
        } finally {
            if (childCtx != null) {
                try { childCtx.close(); } catch (Exception ignored) {}
            }
        }
    }
}
