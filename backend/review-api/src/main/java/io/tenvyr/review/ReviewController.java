package io.tenvyr.review;

import io.micrometer.core.instrument.Timer;
import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.domain.ReviewTypes.AuditEntry;
import io.tenvyr.review.domain.ReviewTypes.CreateReview;
import io.tenvyr.review.domain.ReviewTypes.DecisionCommand;
import io.tenvyr.review.domain.ReviewTypes.DecisionView;
import io.tenvyr.review.domain.ReviewTypes.Page;
import io.tenvyr.review.domain.ReviewTypes.ReviewDetail;
import io.tenvyr.review.domain.ReviewTypes.ReviewReport;
import io.tenvyr.review.domain.ReviewTypes.ReviewSummary;
import io.tenvyr.review.domain.ReviewTypes.Submission;
import io.tenvyr.review.security.ActorResolver;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.util.UUID;

/**
 * Controller exposing T04 review workflow endpoints.
 * Handles review submission (POST /api/v1/reviews), keyset listing (GET /api/v1/reviews),
 * detail reading (GET /api/v1/reviews/{id}), and report projection (GET /api/v1/reviews/{id}/report).
 * Resolves current Actor from authentication via ActorResolver on every request.
 * Measures review.commands metrics latency and outcome on mutations.
 */
@RestController
@RequestMapping("/api/v1/reviews")
public class ReviewController {

    private final ReviewService reviewService;
    private final ReviewDecisionService reviewDecisionService;
    private final ActorResolver actorResolver;
    private final ReviewMetrics reviewMetrics;

    public ReviewController(
            ReviewService reviewService,
            ReviewDecisionService reviewDecisionService,
            ActorResolver actorResolver,
            ReviewMetrics reviewMetrics) {
        this.reviewService = reviewService;
        this.reviewDecisionService = reviewDecisionService;
        this.actorResolver = actorResolver;
        this.reviewMetrics = reviewMetrics;
    }

    @PostMapping
    public ResponseEntity<Submission> submit(
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKeyHeader,
            @RequestBody(required = false) String rawBody,
            Authentication authentication) throws Exception {

        Timer.Sample sample = reviewMetrics.start();
        try {
            Actor actor = actorResolver.current(authentication);
            UUID idempotencyKey = ReviewValidation.validateIdempotencyKey(idempotencyKeyHeader);
            CreateReview input = ReviewValidation.parseCreateReview(rawBody);

            ReviewService.SubmissionOutcome outcome = reviewService.submitWithOutcome(actor, idempotencyKey, input);
            reviewMetrics.record("SUBMIT", outcome.replay() ? "replay" : "success", sample);

            URI location = URI.create("/api/v1/reviews/" + outcome.submission().id());
            return ResponseEntity.status(HttpStatus.ACCEPTED)
                    .location(location)
                    .body(outcome.submission());
        } catch (ReviewErrors.IdempotencyConflictException e) {
            reviewMetrics.record("SUBMIT", "conflict", sample);
            throw e;
        } catch (IllegalArgumentException | com.fasterxml.jackson.core.JsonProcessingException e) {
            reviewMetrics.record("SUBMIT", "invalid", sample);
            throw e;
        } catch (Exception e) {
            reviewMetrics.record("SUBMIT", "error", sample);
            throw e;
        }
    }

    @GetMapping
    public ResponseEntity<Page<ReviewSummary>> list(
            @RequestParam(name = "limit", required = false) Integer limit,
            @RequestParam(name = "after", required = false) String after,
            Authentication authentication) {

        Actor actor = actorResolver.current(authentication);
        int parsedLimit = limit != null ? limit : 20;
        Page<ReviewSummary> page = reviewService.list(actor, parsedLimit, after);
        return ResponseEntity.ok(page);
    }

    @GetMapping("/{id}")
    public ResponseEntity<ReviewDetail> get(
            @PathVariable("id") UUID id,
            Authentication authentication) {

        Actor actor = actorResolver.current(authentication);
        ReviewDetail detail = reviewService.get(actor, id);
        return ResponseEntity.ok(detail);
    }

    @GetMapping("/{id}/report")
    public ResponseEntity<ReviewReport> report(
            @PathVariable("id") UUID id,
            Authentication authentication) {

        Actor actor = actorResolver.current(authentication);
        ReviewReport report = reviewService.report(actor, id);
        return ResponseEntity.ok(report);
    }

    @PostMapping("/{id}/decisions")
    public ResponseEntity<DecisionView> decide(
            @PathVariable("id") UUID id,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKeyHeader,
            @RequestBody(required = false) String rawBody,
            Authentication authentication) throws Exception {

        Timer.Sample sample = reviewMetrics.start();
        try {
            Actor actor = actorResolver.current(authentication);
            UUID idempotencyKey = ReviewValidation.validateIdempotencyKey(idempotencyKeyHeader);
            DecisionCommand command = ReviewValidation.parseDecisionCommand(rawBody);

            ReviewDecisionService.DecisionResult result = reviewDecisionService.decide(actor, id, idempotencyKey, command);
            reviewMetrics.record("DECIDE", result.replay() ? "replay" : "success", sample);

            if (result.replay()) {
                return ResponseEntity.ok(result.decision());
            }

            URI location = URI.create("/api/v1/reviews/" + id + "/decisions/" + result.decision().id());
            return ResponseEntity.status(HttpStatus.CREATED)
                    .location(location)
                    .body(result.decision());
        } catch (ReviewErrors.IdempotencyConflictException e) {
            reviewMetrics.record("DECIDE", "conflict", sample);
            throw e;
        } catch (IllegalArgumentException | com.fasterxml.jackson.core.JsonProcessingException e) {
            reviewMetrics.record("DECIDE", "invalid", sample);
            throw e;
        } catch (Exception e) {
            reviewMetrics.record("DECIDE", "error", sample);
            throw e;
        }
    }

    @PostMapping("/{id}/cancel")
    public ResponseEntity<ReviewDetail> cancel(
            @PathVariable("id") UUID id,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKeyHeader,
            Authentication authentication) {

        Timer.Sample sample = reviewMetrics.start();
        try {
            Actor actor = actorResolver.current(authentication);
            UUID idempotencyKey = ReviewValidation.validateIdempotencyKey(idempotencyKeyHeader);

            ReviewDecisionService.CancelResult result = reviewDecisionService.cancelWithResult(actor, id, idempotencyKey);
            reviewMetrics.record("CANCEL", result.replay() ? "replay" : "success", sample);
            return ResponseEntity.ok(result.detail());
        } catch (ReviewErrors.IdempotencyConflictException e) {
            reviewMetrics.record("CANCEL", "conflict", sample);
            throw e;
        } catch (IllegalArgumentException e) {
            reviewMetrics.record("CANCEL", "invalid", sample);
            throw e;
        } catch (Exception e) {
            reviewMetrics.record("CANCEL", "error", sample);
            throw e;
        }
    }

    @GetMapping("/{id}/audit")
    public ResponseEntity<Page<AuditEntry>> audit(
            @PathVariable("id") UUID id,
            @RequestParam(name = "limit", required = false) Integer limit,
            @RequestParam(name = "after", required = false) String after,
            Authentication authentication) {

        Actor actor = actorResolver.current(authentication);
        int parsedLimit = limit != null ? limit : 20;
        Page<AuditEntry> page = reviewDecisionService.audit(actor, id, parsedLimit, after);
        return ResponseEntity.ok(page);
    }
}
