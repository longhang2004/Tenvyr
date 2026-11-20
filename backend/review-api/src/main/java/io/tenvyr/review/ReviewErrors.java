package io.tenvyr.review;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.TransientDataAccessException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.sql.SQLException;
import java.sql.SQLTransientException;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Mapped errors, exceptions, and centralized exception advice for the review API surface.
 * Emits strictly bounded JSON responses {code, message, requestId} with safe stable text.
 * Strictly avoids leaking SQL, stack traces, raw code, passwords, or provider secrets.
 */
public final class ReviewErrors {

    private ReviewErrors() {}

    public static Map<String, String> error(String code, String message) {
        return Map.of(
                "code", code,
                "message", message,
                "requestId", UUID.randomUUID().toString()
        );
    }

    public static ResponseEntity<Map<String, String>> response(HttpStatus status, String code, String message) {
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .body(error(code, message));
    }

    public static class NotFoundException extends RuntimeException {
        public NotFoundException(String message) {
            super(message);
        }
    }

    public static class IdempotencyConflictException extends RuntimeException {
        public IdempotencyConflictException(String message) {
            super(message);
        }
    }

    public static class ReportNotReadyException extends RuntimeException {
        public ReportNotReadyException(String message) {
            super(message);
        }
    }

    public static class ReviewReportInvalidException extends RuntimeException {
        public ReviewReportInvalidException(String message) {
            super(message);
        }
    }

    public static class DatabaseUnavailableException extends RuntimeException {
        public DatabaseUnavailableException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public static class PayloadTooLargeException extends RuntimeException {
        public PayloadTooLargeException(String message) {
            super(message);
        }
    }

    /**
     * Checks if a SQLException represents a lock timeout, statement timeout, deadlock,
     * serialization failure, or transient connection issue.
     */
    public static boolean isTransientSqlState(SQLException ex) {
        if (ex == null) {
            return false;
        }
        if (ex instanceof SQLTransientException) {
            return true;
        }
        String sqlState = ex.getSQLState();
        if (sqlState != null) {
            // 55P03: lock_not_available
            // 57014: query_canceled (Postgres statement_timeout / lock_timeout)
            // 40001: serialization_failure
            // 40P01: deadlock_detected
            // 08000, 08003, 08006: connection failure
            if ("55P03".equals(sqlState) || "57014".equals(sqlState) ||
                    "40001".equals(sqlState) || "40P01".equals(sqlState) ||
                    sqlState.startsWith("08")) {
                return true;
            }
        }
        String msg = ex.getMessage();
        if (msg != null) {
            String lower = msg.toLowerCase(Locale.ROOT);
            return lower.contains("lock timeout") || lower.contains("statement timeout")
                    || lower.contains("deadlock") || lower.contains("canceling statement due to lock timeout")
                    || lower.contains("connection is not available") || lower.contains("request timed out after");
        }
        return false;
    }

    /**
     * Shared cause predicate reused across service and advice to recognize transient database failures.
     */
    public static boolean isTransient(Throwable t) {
        Throwable curr = t;
        while (curr != null) {
            if (curr instanceof SQLTransientException) {
                return true;
            }
            if (curr instanceof SQLException sqlEx && isTransientSqlState(sqlEx)) {
                return true;
            }
            String msg = curr.getMessage();
            if (msg != null) {
                String lower = msg.toLowerCase(Locale.ROOT);
                if (lower.contains("connection is not available") || lower.contains("request timed out after")
                        || lower.contains("lock timeout") || lower.contains("statement timeout")
                        || lower.contains("deadlock")) {
                    return true;
                }
            }
            if (curr.getCause() == curr) {
                break;
            }
            curr = curr.getCause();
        }
        return false;
    }

    @RestControllerAdvice
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public static class ReviewControllerAdvice {

        private static ResponseEntity<Map<String, String>> serviceUnavailableResponse() {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header(HttpHeaders.RETRY_AFTER, "1")
                    .body(error("DATABASE_UNAVAILABLE", "Database temporarily unavailable"));
        }

        @ExceptionHandler(NotFoundException.class)
        public ResponseEntity<Map<String, String>> handleNotFound(NotFoundException ex) {
            return response(HttpStatus.NOT_FOUND, "NOT_FOUND", ex.getMessage());
        }

        @ExceptionHandler(IdempotencyConflictException.class)
        public ResponseEntity<Map<String, String>> handleIdempotencyConflict(IdempotencyConflictException ex) {
            return response(HttpStatus.CONFLICT, "IDEMPOTENCY_CONFLICT", ex.getMessage());
        }

        @ExceptionHandler(ReportNotReadyException.class)
        public ResponseEntity<Map<String, String>> handleReportNotReady(ReportNotReadyException ex) {
            return response(HttpStatus.CONFLICT, "REPORT_NOT_READY", ex.getMessage());
        }

        @ExceptionHandler(ReviewReportInvalidException.class)
        public ResponseEntity<Map<String, String>> handleReviewReportInvalid(ReviewReportInvalidException ex) {
            return response(HttpStatus.CONFLICT, "REVIEW_REPORT_INVALID", ex.getMessage());
        }

        @ExceptionHandler({
                IllegalArgumentException.class,
                com.fasterxml.jackson.core.JsonProcessingException.class,
                HttpMessageNotReadableException.class,
                MethodArgumentNotValidException.class,
                MethodArgumentTypeMismatchException.class,
                MissingRequestHeaderException.class
        })
        public ResponseEntity<Map<String, String>> handleBadRequest(Exception ex) {
            return response(HttpStatus.BAD_REQUEST, "BAD_REQUEST", "Invalid request payload or parameters");
        }

        @ExceptionHandler(PayloadTooLargeException.class)
        public ResponseEntity<Map<String, String>> handlePayloadTooLarge(PayloadTooLargeException ex) {
            return response(HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", ex.getMessage());
        }

        @ExceptionHandler(AccessDeniedException.class)
        public ResponseEntity<Map<String, String>> handleAccessDenied(AccessDeniedException ex) {
            return response(HttpStatus.FORBIDDEN, "FORBIDDEN", "Access denied");
        }

        @ExceptionHandler(AuthenticationException.class)
        public ResponseEntity<Map<String, String>> handleAuthentication(AuthenticationException ex) {
            return response(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "Authentication required");
        }

        @ExceptionHandler({
                DatabaseUnavailableException.class,
                TransientDataAccessException.class
        })
        public ResponseEntity<Map<String, String>> handleDatabaseUnavailable(Exception ex) {
            return serviceUnavailableResponse();
        }

        @ExceptionHandler(DataAccessException.class)
        public ResponseEntity<Map<String, String>> handleDataAccessException(DataAccessException ex) {
            if (isTransient(ex)) {
                return serviceUnavailableResponse();
            }
            return response(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Internal server error");
        }

        @ExceptionHandler(Exception.class)
        public ResponseEntity<Map<String, String>> handleGeneralException(Exception ex) {
            if (isTransient(ex)) {
                return serviceUnavailableResponse();
            }
            return response(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Internal server error");
        }
    }
}
