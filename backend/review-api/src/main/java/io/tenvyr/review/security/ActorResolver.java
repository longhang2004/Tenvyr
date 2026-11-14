package io.tenvyr.review.security;

import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.domain.ReviewTypes.Role;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.DisabledException;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.UUID;

/**
 * Resolves current authenticated Actor from PostgreSQL database.
 * Rejects null, unauthenticated, or anonymous tokens before touching JDBC.
 * Queries current enabled status and role on each request to prevent stale authority privilege.
 */
@Component
public class ActorResolver {

    private final JdbcTemplate jdbcTemplate;

    public ActorResolver(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public Actor current(Authentication authentication) throws AuthenticationException {
        if (authentication == null) {
            throw new InsufficientAuthenticationException("Authentication required");
        }
        if (!authentication.isAuthenticated()) {
            throw new InsufficientAuthenticationException("Token is unauthenticated");
        }
        if (authentication instanceof AnonymousAuthenticationToken) {
            throw new InsufficientAuthenticationException("Anonymous token is not permitted");
        }

        String username = authentication.getName();
        if (username == null || username.isBlank()) {
            throw new InsufficientAuthenticationException("Authentication name is missing");
        }

        record UserRow(UUID id, String roleStr, boolean enabled) {}

        List<UserRow> rows = jdbcTemplate.query(
                "SELECT id, role, enabled FROM tenvyr_review.users WHERE username = ?",
                (rs, rowNum) -> new UserRow(
                        rs.getObject("id", UUID.class),
                        rs.getString("role"),
                        rs.getBoolean("enabled")
                ),
                username
        );

        if (rows.isEmpty()) {
            throw new BadCredentialsException("User not found: " + username);
        }

        UserRow user = rows.get(0);
        if (!user.enabled()) {
            throw new DisabledException("User account is disabled: " + username);
        }

        Role role = Role.valueOf(user.roleStr());
        return new Actor(user.id(), username, role);
    }
}
