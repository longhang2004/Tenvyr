package io.tenvyr.review.security;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import io.tenvyr.review.domain.ReviewTypes.Role;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/**
 * Explicit local user bootstrap component.
 * Non-lazy, depends on database initialization, runs before web admission.
 * Skips bootstrap if review.bootstrap-users-file is absent.
 * Validates manifest strictly and persists all users in a single transaction.
 * Sanitizes all parser and SQL exceptions to prevent credential/hash leakage.
 */
@Component
@DependsOnDatabaseInitialization
public class BootstrapUsers implements InitializingBean {

    public record Entry(String username, String password, Role role) {}

    private final Environment environment;
    private final JdbcTemplate jdbcTemplate;
    private final PlatformTransactionManager transactionManager;
    private final PasswordEncoder passwordEncoder;

    public BootstrapUsers(
            Environment environment,
            JdbcTemplate jdbcTemplate,
            PlatformTransactionManager transactionManager,
            PasswordEncoder passwordEncoder) {
        this.environment = environment;
        this.jdbcTemplate = jdbcTemplate;
        this.transactionManager = transactionManager;
        this.passwordEncoder = passwordEncoder;
    }

    @Override
    public void afterPropertiesSet() throws Exception {
        String filePath = environment.getProperty("review.bootstrap-users-file");
        if (filePath == null || filePath.isBlank()) {
            return;
        }

        Path path = Path.of(filePath);
        List<Entry> entries = parse(path);
        bootstrap(entries);
    }

    public static List<Entry> parse(Path path) throws IOException, IllegalArgumentException {
        if (path == null || !Files.isRegularFile(path)) {
            throw new IOException("Bootstrap manifest file does not exist: " + (path == null ? "null" : path.toAbsolutePath()));
        }

        String content;
        try {
            content = Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IOException("Failed to read bootstrap manifest file: " + path.toAbsolutePath(), e);
        }

        JsonNode root;
        try {
            root = Json.MAPPER.readTree(content);
        } catch (Exception e) {
            // STRICT SANITIZATION: Never retain raw Jackson cause or file contents in exception chain
            throw new IllegalArgumentException("Bootstrap manifest contains invalid JSON format");
        }

        if (root == null || !root.isArray()) {
            throw new IllegalArgumentException("Bootstrap manifest must be a JSON array");
        }
        if (root.isEmpty()) {
            throw new IllegalArgumentException("Bootstrap manifest must contain a non-empty array of users");
        }

        List<Entry> entries = new ArrayList<>();
        Set<String> seenUsernames = new HashSet<>();

        for (int i = 0; i < root.size(); i++) {
            JsonNode item = root.get(i);
            if (!item.isObject()) {
                throw new IllegalArgumentException("Bootstrap manifest entry at index " + i + " must be a JSON object");
            }

            Set<String> fields = new HashSet<>();
            item.fieldNames().forEachRemaining(fields::add);
            if (!fields.equals(Set.of("username", "password", "role"))) {
                throw new IllegalArgumentException("Bootstrap manifest entry at index " + i + " must contain exactly {username, password, role}");
            }

            JsonNode usernameNode = item.get("username");
            JsonNode passwordNode = item.get("password");
            JsonNode roleNode = item.get("role");

            if (!usernameNode.isTextual() || !passwordNode.isTextual() || !roleNode.isTextual()) {
                throw new IllegalArgumentException("Bootstrap manifest entry at index " + i + " must have string fields without type coercion");
            }

            String username = usernameNode.asText();
            String password = passwordNode.asText();
            String roleStr = roleNode.asText();

            if (!username.matches("^[a-z0-9_.-]{1,64}$")) {
                throw new IllegalArgumentException("Bootstrap manifest entry at index " + i + " has invalid username format");
            }
            if (password.isBlank()) {
                throw new IllegalArgumentException("Bootstrap manifest entry at index " + i + " password must not be blank");
            }

            Role role;
            if ("SUBMITTER".equals(roleStr)) {
                role = Role.SUBMITTER;
            } else if ("REVIEWER".equals(roleStr)) {
                role = Role.REVIEWER;
            } else {
                throw new IllegalArgumentException("Bootstrap manifest entry at index " + i + " has unsupported role");
            }

            if (!seenUsernames.add(username)) {
                throw new IllegalArgumentException("Bootstrap manifest entry at index " + i + " has duplicate username");
            }

            entries.add(new Entry(username, password, role));
        }

        return Collections.unmodifiableList(entries);
    }

    private void bootstrap(List<Entry> entries) {
        TransactionTemplate txTemplate = new TransactionTemplate(transactionManager);
        txTemplate.execute(status -> {
            for (Entry entry : entries) {
                Integer existingCount = jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM tenvyr_review.users WHERE username = ?",
                        Integer.class,
                        entry.username()
                );
                if (existingCount != null && existingCount > 0) {
                    throw new IllegalStateException("Bootstrap user already exists in database: " + entry.username());
                }

                UUID id = UUID.randomUUID();
                String hash = passwordEncoder.encode(entry.password());
                try {
                    jdbcTemplate.update(
                            "INSERT INTO tenvyr_review.users (id, username, password_hash, role, enabled) VALUES (?, ?, ?, ?, true)",
                            id,
                            entry.username(),
                            hash,
                            entry.role().name()
                    );
                } catch (Exception e) {
                    // Safe error without raw cause (which could echo password hash or row details)
                    throw new IllegalStateException("Failed to persist bootstrap user in database: " + entry.username());
                }
            }
            return null;
        });
    }
}
