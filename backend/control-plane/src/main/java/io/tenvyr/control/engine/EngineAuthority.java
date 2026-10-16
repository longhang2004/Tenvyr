package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.time.Instant;
import java.util.List;

/** Authority operations execute on the caller's JDBC transaction. No nested transaction may commit work early. */
public interface EngineAuthority {
  record ClaimContext(JsonNode context, List<String> artifactIds, JsonNode efficiency) {}
  JsonNode validatePipelineBudget(JsonNode value);
  JsonNode validateStepBudget(JsonNode value);
  JsonNode validateProjection(JsonNode value);
  JsonNode validateStateWrites(JsonNode value);
  ClaimContext projectContext(Connection c, ObjectNode execution, ObjectNode step, ObjectNode executor, ObjectNode revision) throws Exception;
  JsonNode evaluateDispatch(Connection c, ObjectNode proposal) throws Exception;
  void requestApproval(Connection c, ObjectNode proposal) throws Exception;
  void reserveBudget(Connection c, ObjectNode execution, ObjectNode revision, ObjectNode step, ObjectNode attempt) throws Exception;
  void releaseBudget(Connection c, String invocationId, String reason) throws Exception;
  void settleBudget(Connection c, String invocationId, JsonNode usage) throws Exception;
  JsonNode applyStateWrites(Connection c, ObjectNode execution, JsonNode mappings, JsonNode output) throws Exception;
  void proposePlan(Connection c, String executionId, JsonNode output, String source) throws Exception;
  void recordDelegation(Connection c, ObjectNode attempt, ObjectNode step, JsonNode observations) throws Exception;
  JsonNode completeEfficiency(JsonNode stored, ObjectNode result, ObjectNode attempt);
  void expireApprovals(Instant now) throws Exception;
  void expireDelegation(Instant now) throws Exception;
  void cancelOrphans(int limit) throws Exception;
}
