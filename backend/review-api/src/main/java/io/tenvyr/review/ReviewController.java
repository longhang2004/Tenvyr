package io.tenvyr.review;

import io.tenvyr.review.domain.ReviewTypes.Actor;
import io.tenvyr.review.domain.ReviewTypes.CreateReview;
import io.tenvyr.review.domain.ReviewTypes.Page;
import io.tenvyr.review.domain.ReviewTypes.ReviewDetail;
import io.tenvyr.review.domain.ReviewTypes.ReviewReport;
import io.tenvyr.review.domain.ReviewTypes.ReviewSummary;
import io.tenvyr.review.domain.ReviewTypes.Submission;
import io.tenvyr.review.security.ActorResolver;
import org.springframework.http.HttpHeaders;
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
 */
@RestController
@RequestMapping("/api/v1/reviews")
public class ReviewController {

    private final ReviewService reviewService;
    private final ActorResolver actorResolver;

    public ReviewController(ReviewService reviewService, ActorResolver actorResolver) {
        this.reviewService = reviewService;
        this.actorResolver = actorResolver;
    }

    @PostMapping
    public ResponseEntity<Submission> submit(
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKeyHeader,
            @RequestBody(required = false) String rawBody,
            Authentication authentication) throws Exception {

        Actor actor = actorResolver.current(authentication);
        UUID idempotencyKey = ReviewValidation.validateIdempotencyKey(idempotencyKeyHeader);
        CreateReview input = ReviewValidation.parseCreateReview(rawBody);

        Submission submission = reviewService.submit(actor, idempotencyKey, input);

        URI location = URI.create("/api/v1/reviews/" + submission.id());
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .location(location)
                .body(submission);
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
}
