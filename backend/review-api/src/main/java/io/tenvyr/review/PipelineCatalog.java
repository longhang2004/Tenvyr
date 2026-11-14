package io.tenvyr.review;

import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.control.authority.AuthorityServices;
import io.tenvyr.control.engine.Conditions;
import io.tenvyr.control.engine.PipelineService;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Json;

import java.sql.Connection;
import java.sql.SQLException;

/**
 * Concrete catalog managing the fixed internal review pipeline and PostgreSQL version binding.
 * Executes on the caller-owned Connection within an advisory transaction lock.
 */
public final class PipelineCatalog {

    public static final String PIPELINE_NAME = "review-request-v1";
    public static final String PIPELINE_VERSION = "1";
    public static final String STEP_ID = "review";
    public static final String STEP_AGENT = "code-reviewer";
    public static final int STEP_RETRIES = 2;
    public static final String STEP_ON_FAILURE = "retry";
    public static final String STEP_TIMEOUT = "30s";

    private static final long CATALOG_ADVISORY_LOCK = 1722270000002L;

    private PipelineCatalog() {}

    /**
     * Builds the immutable fixed definition for review-request-v1.
     */
    public static ObjectNode definition() {
        ObjectNode step = Json.object(
                "id", STEP_ID,
                "agent", STEP_AGENT,
                "input", Json.object(
                        "code", "{{ pipeline.input.code }}",
                        "language", "{{ pipeline.input.language }}"
                ),
                "retries", STEP_RETRIES,
                "onFailure", STEP_ON_FAILURE,
                "timeout", STEP_TIMEOUT
        );
        return Json.object(
                "name", PIPELINE_NAME,
                "version", PIPELINE_VERSION,
                "steps", Json.array(step)
        );
    }

    /**
     * Ensures that the fixed internal pipeline exists and is bound to version 1 in tenvyr_review.pipeline_bindings.
     * Uses PostgreSQL advisory transaction lock on the supplied connection to prevent duplicate creation races.
     * Requires an active caller transaction (autoCommit false).
     * Validates hashes and schemaVersion against tamper or drift.
     * Does NOT commit, rollback, or close the supplied connection.
     *
     * @param connection caller-owned database connection with autoCommit false
     * @return pipeline ObjectNode
     */
    public static ObjectNode ensure(Connection connection) {
        if (connection == null) {
            throw new IllegalArgumentException("Connection must not be null");
        }
        try {
            if (connection.getAutoCommit()) {
                throw new IllegalStateException("Caller transaction required: autoCommit must be false");
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Failed to verify connection transaction status", e);
        }

        Db tx = Db.on(connection);
        tx.query("SELECT pg_advisory_xact_lock(?)", CATALOG_ADVISORY_LOCK);

        AuthorityServices authority = new AuthorityServices(tx);
        Conditions conditions = new Conditions();
        PipelineService service = new PipelineService(tx, authority, conditions);

        ObjectNode def = definition();
        ObjectNode normalized = service.validate(def);
        String expectedDefinitionHash = Json.hash(normalized);

        ObjectNode binding = tx.one(
                "SELECT version, pipeline_id AS \"pipelineId\", definition_hash AS \"definitionHash\" " +
                        "FROM tenvyr_review.pipeline_bindings WHERE version = 1"
        );

        if (binding != null) {
            String storedHash = binding.path("definitionHash").asText().trim();
            if (!storedHash.equals(expectedDefinitionHash)) {
                throw new IllegalStateException("Pipeline definition hash drift detected in pipeline_bindings version 1: expected "
                        + expectedDefinitionHash + " but found " + storedHash);
            }
            String pipelineId = binding.path("pipelineId").asText();
            ObjectNode existing = tx.one("SELECT * FROM pipelines WHERE id = ?::uuid", pipelineId);
            if (existing == null) {
                throw new IllegalStateException("Bound pipeline " + pipelineId + " not found in pipelines table");
            }
            int schemaVersion = existing.path("schemaVersion").asInt(-1);
            if (schemaVersion != 1) {
                throw new IllegalStateException("Invalid pipeline schemaVersion: " + schemaVersion);
            }
            String existingContentHash = existing.path("contentHash").asText().trim();
            if (!existingContentHash.equals(expectedDefinitionHash)) {
                throw new IllegalStateException("Pipeline contentHash drift detected: expected "
                        + expectedDefinitionHash + " but found " + existingContentHash);
            }
            String validatedExistingHash = Json.hash(service.validate(existing));
            if (!validatedExistingHash.equals(expectedDefinitionHash)) {
                throw new IllegalStateException("Pipeline definition drift detected in validated existing pipeline: expected "
                        + expectedDefinitionHash + " but found " + validatedExistingHash);
            }
            return existing;
        }

        ObjectNode created = service.create(def);
        String pipelineId = created.path("id").asText();
        tx.execute(
                "INSERT INTO tenvyr_review.pipeline_bindings (version, pipeline_id, definition_hash) VALUES (1, ?::uuid, ?)",
                pipelineId, expectedDefinitionHash
        );

        return created;
    }
}
