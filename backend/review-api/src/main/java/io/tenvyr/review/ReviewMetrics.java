package io.tenvyr.review;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Actuator metrics provider for review operations.
 * Exposes:
 * - review.commands (Timer): low-cardinality latency and outcome metrics for mutations.
 *   Tags: command in ('SUBMIT', 'DECIDE', 'CANCEL'), outcome in ('success', 'replay', 'conflict', 'invalid', 'error').
 *   Pre-registers all fixed tag pairs at startup with baseline 0.0 count.
 * - review.backlog (Gauge): current count of reviews strictly in AWAITING_REVIEW status.
 *   Evaluates via read-only repository projections; performs zero database writes.
 */
@Component
public class ReviewMetrics {

    public static final String COMMANDS_METRIC = "review.commands";
    public static final String BACKLOG_METRIC = "review.backlog";

    public static final List<String> COMMANDS = List.of("SUBMIT", "DECIDE", "CANCEL");
    public static final List<String> OUTCOMES = List.of("success", "replay", "conflict", "invalid", "error");

    private final MeterRegistry meterRegistry;
    private final ReviewRepository reviewRepository;

    public ReviewMetrics(MeterRegistry meterRegistry, ReviewRepository reviewRepository) {
        this.meterRegistry = meterRegistry;
        this.reviewRepository = reviewRepository;

        // Pre-register all fixed command/outcome timer pairs at startup with baseline 0.0
        for (String cmd : COMMANDS) {
            for (String outcome : OUTCOMES) {
                Timer.builder(COMMANDS_METRIC)
                        .tag("command", cmd)
                        .tag("outcome", outcome)
                        .register(meterRegistry);
            }
        }

        // Register review.backlog gauge
        Gauge.builder(BACKLOG_METRIC, this, ReviewMetrics::countBacklog)
                .description("Current count of reviews awaiting reviewer decision")
                .register(meterRegistry);
    }

    public double countBacklog() {
        return reviewRepository.countAwaitingReview();
    }

    public Timer.Sample start() {
        return Timer.start(meterRegistry);
    }

    public void record(String command, String outcome, Timer.Sample sample) {
        if (sample != null) {
            sample.stop(meterRegistry.timer(COMMANDS_METRIC, "command", command, "outcome", outcome));
        }
    }
}
