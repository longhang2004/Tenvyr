package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;

public interface EngineRuntime {
  ObjectNode resolveExecutor(Connection c, ObjectNode step, ObjectNode descriptor) throws Exception;
  JsonNode workspaceMetadata(Connection c, String executionId) throws Exception;
  boolean reconcileCoordination(String executionId) throws Exception;
  boolean completionHeld(String executionId) throws Exception;
  boolean isVerifierStep(String executionId, String stepId) throws Exception;
  JsonNode buildVerifierInput(String executionId, String stepId) throws Exception;
}
