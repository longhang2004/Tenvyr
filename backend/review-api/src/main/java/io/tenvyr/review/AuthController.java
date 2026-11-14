package io.tenvyr.review;

import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.security.ActorResolver;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.UUID;

/**
 * Controller for authentication and actor resolution endpoints.
 * Provides anonymous CSRF token retrieval and authenticated current actor resolution.
 */
@RestController
@RequestMapping("/api/v1")
public class AuthController {

    private final ActorResolver actorResolver;

    public AuthController(ActorResolver actorResolver) {
        this.actorResolver = actorResolver;
    }

    @GetMapping("/auth/csrf")
    public ResponseEntity<Map<String, String>> csrf(CsrfToken csrfToken) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(Map.of(
                        "headerName", csrfToken.getHeaderName(),
                        "parameterName", csrfToken.getParameterName(),
                        "token", csrfToken.getToken()
                ));
    }

    @GetMapping("/me")
    public ResponseEntity<Actor> me(Authentication authentication) {
        Actor actor = actorResolver.current(authentication);
        return ResponseEntity.ok(actor);
    }

    @ExceptionHandler(AuthenticationException.class)
    public ResponseEntity<Map<String, String>> handleAuthenticationException(AuthenticationException ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of(
                        "code", "UNAUTHORIZED",
                        "message", "Authentication required",
                        "requestId", UUID.randomUUID().toString()
                ));
    }
}
