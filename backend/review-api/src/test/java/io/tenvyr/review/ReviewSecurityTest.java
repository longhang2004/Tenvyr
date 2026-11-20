package io.tenvyr.review;

import io.tenvyr.review.domain.ReviewTypes.Role;
import io.tenvyr.review.security.ActorResolver;
import io.tenvyr.review.security.BootstrapUsers;
import io.tenvyr.review.security.BootstrapUsers.Entry;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.authority.AuthorityUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * T03 Stage A Unit Tests: Pure security components, ActorResolver constructor/input contracts,
 * and pure strict manifest parsing rules.
 * No PG/env/SpringBoot dependencies; asserts specific AuthenticationException,
 * verifyNoInteractions, IOException, and IllegalArgumentException.
 */
public class ReviewSecurityTest {

    @Test
    @DisplayName("ActorResolver.current rejects null authentication with AuthenticationException and leaves JDBC untouched")
    void testActorResolverRejectsNullAuthentication() {
        JdbcTemplate jdbcTemplate = Mockito.mock(JdbcTemplate.class);
        ActorResolver resolver = new ActorResolver(jdbcTemplate);

        assertThrows(AuthenticationException.class, () -> resolver.current(null),
                "ActorResolver.current must reject null authentication with AuthenticationException");
        verifyNoInteractions(jdbcTemplate);
    }

    @Test
    @DisplayName("ActorResolver.current rejects unauthenticated token with AuthenticationException and leaves JDBC untouched")
    void testActorResolverRejectsUnauthenticatedToken() {
        JdbcTemplate jdbcTemplate = Mockito.mock(JdbcTemplate.class);
        ActorResolver resolver = new ActorResolver(jdbcTemplate);
        UsernamePasswordAuthenticationToken unauth =
                UsernamePasswordAuthenticationToken.unauthenticated("testuser", "secret");
        assertFalse(unauth.isAuthenticated(), "Token must be unauthenticated");

        assertThrows(AuthenticationException.class, () -> resolver.current(unauth),
                "ActorResolver.current must reject unauthenticated token with AuthenticationException");
        verifyNoInteractions(jdbcTemplate);
    }

    @Test
    @DisplayName("ActorResolver.current rejects AnonymousAuthenticationToken with AuthenticationException and leaves JDBC untouched")
    void testActorResolverRejectsAnonymousToken() {
        JdbcTemplate jdbcTemplate = Mockito.mock(JdbcTemplate.class);
        ActorResolver resolver = new ActorResolver(jdbcTemplate);
        AnonymousAuthenticationToken anon = new AnonymousAuthenticationToken(
                "test-key",
                "anonymousUser",
                AuthorityUtils.createAuthorityList("ROLE_ANONYMOUS")
        );

        assertThrows(AuthenticationException.class, () -> resolver.current(anon),
                "ActorResolver.current must reject anonymous authentication token with AuthenticationException");
        verifyNoInteractions(jdbcTemplate);
    }

    @Test
    @DisplayName("BootstrapUsers.parse validates valid manifest entries and parses records into List<Entry>")
    void testBootstrapUsersParsesValidManifest(@TempDir Path tempDir) throws Exception {
        Path manifest = tempDir.resolve("users.json");
        String content = """
                [
                  {
                    "username": "alice_sub",
                    "password": "alicePassword123!",
                    "role": "SUBMITTER"
                  },
                  {
                    "username": "bob_rev",
                    "password": "bobPassword456!",
                    "role": "REVIEWER"
                  }
                ]
                """;
        Files.writeString(manifest, content);

        List<Entry> entries = BootstrapUsers.parse(manifest);
        assertNotNull(entries);
        assertEquals(2, entries.size());

        Entry first = entries.get(0);
        assertEquals("alice_sub", first.username());
        assertEquals("alicePassword123!", first.password());
        assertEquals(Role.SUBMITTER, first.role());

        Entry second = entries.get(1);
        assertEquals("bob_rev", second.username());
        assertEquals("bobPassword456!", second.password());
        assertEquals(Role.REVIEWER, second.role());
    }

    @Test
    @DisplayName("BootstrapUsers.parse rejects missing manifest file with IOException")
    void testBootstrapUsersRejectsMissingFile(@TempDir Path tempDir) {
        Path nonExistent = tempDir.resolve("absent-users.json");
        assertThrows(IOException.class, () -> BootstrapUsers.parse(nonExistent),
                "BootstrapUsers.parse must throw IOException when manifest file does not exist");
    }

    @Test
    @DisplayName("BootstrapUsers.parse rejects missing required fields (username, password, role) with IllegalArgumentException")
    void testBootstrapUsersRejectsMissingFields(@TempDir Path tempDir) throws Exception {
        // Missing password
        Path missingPassword = tempDir.resolve("missing-password.json");
        Files.writeString(missingPassword, """
                [
                  {"username": "valid_user", "role": "SUBMITTER"}
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(missingPassword),
                "BootstrapUsers.parse must reject manifest entry missing password");

        // Missing username
        Path missingUsername = tempDir.resolve("missing-username.json");
        Files.writeString(missingUsername, """
                [
                  {"password": "validPassword123!", "role": "SUBMITTER"}
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(missingUsername),
                "BootstrapUsers.parse must reject manifest entry missing username");

        // Missing role
        Path missingRole = tempDir.resolve("missing-role.json");
        Files.writeString(missingRole, """
                [
                  {"username": "valid_user", "password": "validPassword123!"}
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(missingRole),
                "BootstrapUsers.parse must reject manifest entry missing role");
    }

    @Test
    @DisplayName("BootstrapUsers.parse rejects duplicate usernames within manifest with IllegalArgumentException")
    void testBootstrapUsersRejectsDuplicateUsernames(@TempDir Path tempDir) throws Exception {
        Path duplicateManifest = tempDir.resolve("duplicate-users.json");
        Files.writeString(duplicateManifest, """
                [
                  {"username": "duplicate_user", "password": "pass1", "role": "SUBMITTER"},
                  {"username": "duplicate_user", "password": "pass2", "role": "REVIEWER"}
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(duplicateManifest),
                "BootstrapUsers.parse must reject duplicate usernames within manifest");
    }

    @Test
    @DisplayName("BootstrapUsers.parse rejects uppercase characters and invalid username formats with IllegalArgumentException")
    void testBootstrapUsersRejectsInvalidUsernames(@TempDir Path tempDir) throws Exception {
        // Uppercase username
        Path uppercaseManifest = tempDir.resolve("uppercase.json");
        Files.writeString(uppercaseManifest, """
                [
                  {"username": "Alice_Sub", "password": "pass", "role": "SUBMITTER"}
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(uppercaseManifest),
                "BootstrapUsers.parse must reject uppercase username");

        // Spaces and disallowed characters
        Path invalidCharsManifest = tempDir.resolve("invalid-chars.json");
        Files.writeString(invalidCharsManifest, """
                [
                  {"username": "user name with spaces", "password": "pass", "role": "SUBMITTER"}
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(invalidCharsManifest),
                "BootstrapUsers.parse must reject username with spaces or special characters");

        // Over 64 chars
        Path tooLongManifest = tempDir.resolve("too-long.json");
        String longUsername = "u".repeat(65);
        Files.writeString(tooLongManifest, """
                [
                  {"username": "%s", "password": "pass", "role": "SUBMITTER"}
                ]
                """.formatted(longUsername));
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(tooLongManifest),
                "BootstrapUsers.parse must reject username exceeding 64 characters");
    }

    @Test
    @DisplayName("BootstrapUsers.parse rejects unsupported roles with IllegalArgumentException")
    void testBootstrapUsersRejectsUnsupportedRoles(@TempDir Path tempDir) throws Exception {
        Path unsupportedRoleManifest = tempDir.resolve("bad-role.json");
        Files.writeString(unsupportedRoleManifest, """
                [
                  {"username": "admin_user", "password": "pass", "role": "ADMIN"}
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(unsupportedRoleManifest),
                "BootstrapUsers.parse must reject unsupported role 'ADMIN'");

        Path lowercaseRoleManifest = tempDir.resolve("lowercase-role.json");
        Files.writeString(lowercaseRoleManifest, """
                [
                  {"username": "submitter_user", "password": "pass", "role": "submitter"}
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(lowercaseRoleManifest),
                "BootstrapUsers.parse must reject lowercase role 'submitter'");
    }

    @Test
    @DisplayName("BootstrapUsers.parse strictly rejects unknown properties in user entries with IllegalArgumentException")
    void testBootstrapUsersRejectsUnknownProperties(@TempDir Path tempDir) throws Exception {
        Path unknownPropsManifest = tempDir.resolve("unknown-props.json");
        Files.writeString(unknownPropsManifest, """
                [
                  {
                    "username": "safe_user",
                    "password": "validPassword123!",
                    "role": "SUBMITTER",
                    "extraAdminFlag": true
                  }
                ]
                """);
        assertThrows(IllegalArgumentException.class, () -> BootstrapUsers.parse(unknownPropsManifest),
                "BootstrapUsers.parse must strictly reject unknown properties in manifest JSON");
    }

    @Test
    @DisplayName("BootstrapUsers.parse sanitizes invalid JSON without leaking secret marker in exception or cause chain")
    void testBootstrapUsersParseSanitizesMalformedJsonSecretMarker(@TempDir Path tempDir) throws Exception {
        Path malformed = tempDir.resolve("malformed-secret.json");
        String secretMarker = "SUPER_SECRET_FAKE_PASSWORD_TOKEN_XYZ123";
        // Unquoted password token simulates malformed JSON that raw Jackson parser might echo in exception cause
        String content = """
                [
                  {
                    "username": "secret_user",
                    "password": %s,
                    "role": "SUBMITTER"
                  }
                ]
                """.formatted(secretMarker);
        Files.writeString(malformed, content);

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> BootstrapUsers.parse(malformed),
                "BootstrapUsers.parse must throw IllegalArgumentException on malformed JSON");

        Throwable cursor = ex;
        while (cursor != null) {
            String msg = cursor.getMessage();
            if (msg != null) {
                assertFalse(msg.contains(secretMarker),
                        "Exception or cause message must not leak secret marker: " + msg);
                assertFalse(msg.contains("username"),
                        "Exception or cause message must not leak manifest text: " + msg);
            }
            if (cursor.getCause() == cursor) {
                break;
            }
            cursor = cursor.getCause();
        }
    }

    @Test
    @DisplayName("BootstrapUsers.parse sanitizes invalid username value without leaking secret marker in exception or cause chain")
    void testBootstrapUsersParseSanitizesInvalidUsernameValue(@TempDir Path tempDir) throws Exception {
        Path manifest = tempDir.resolve("invalid-username-secret.json");
        String secretMarker = "SUPER_SECRET_FAKE_USERNAME_TOKEN_XYZ123\n";
        String invalidUsername = "bad user " + secretMarker;
        String content = io.tenvyr.platform.Json.stringify(io.tenvyr.platform.Json.array(
                io.tenvyr.platform.Json.object(
                        "username", invalidUsername,
                        "password", "validPassword123!",
                        "role", "SUBMITTER"
                )
        ));
        Files.writeString(manifest, content);

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> BootstrapUsers.parse(manifest),
                "BootstrapUsers.parse must throw IllegalArgumentException on invalid username");

        Throwable cursor = ex;
        while (cursor != null) {
            String msg = cursor.getMessage();
            if (msg != null) {
                assertFalse(msg.contains(secretMarker),
                        "Exception or cause message must not leak secret marker: " + msg);
                assertFalse(msg.contains(content),
                        "Exception or cause message must not leak full manifest text: " + msg);
            }
            if (cursor.getCause() == cursor) {
                break;
            }
            cursor = cursor.getCause();
        }
    }

    @Test
    @DisplayName("BootstrapUsers.parse sanitizes unsupported role value without leaking secret marker in exception or cause chain")
    void testBootstrapUsersParseSanitizesUnsupportedRoleValue(@TempDir Path tempDir) throws Exception {
        Path manifest = tempDir.resolve("unsupported-role-secret.json");
        String secretMarker = "SUPER_SECRET_FAKE_ROLE_TOKEN_XYZ123\n";
        String invalidRole = "ROLE_UNSUPPORTED_" + secretMarker;
        String content = io.tenvyr.platform.Json.stringify(io.tenvyr.platform.Json.array(
                io.tenvyr.platform.Json.object(
                        "username", "valid_user",
                        "password", "validPassword123!",
                        "role", invalidRole
                )
        ));
        Files.writeString(manifest, content);

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> BootstrapUsers.parse(manifest),
                "BootstrapUsers.parse must throw IllegalArgumentException on unsupported role");

        Throwable cursor = ex;
        while (cursor != null) {
            String msg = cursor.getMessage();
            if (msg != null) {
                assertFalse(msg.contains(secretMarker),
                        "Exception or cause message must not leak secret marker: " + msg);
                assertFalse(msg.contains(content),
                        "Exception or cause message must not leak full manifest text: " + msg);
            }
            if (cursor.getCause() == cursor) {
                break;
            }
            cursor = cursor.getCause();
        }
    }
}
