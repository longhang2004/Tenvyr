package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.*;

final class EngineFacts {
  static final Set<String> TERMINAL_ATTEMPT=Set.of("SUCCESS","FAILED","TIMED_OUT","CANCELLED"),TERMINAL_STEP=Set.of("COMPLETED","FAILED","SKIPPED","CANCELLED"),TERMINAL_EXECUTION=Set.of("COMPLETED","FAILED","CANCELLED");
  static final String ATTEMPT_TERMINAL_SQL="('SUCCESS','FAILED','TIMED_OUT','CANCELLED')", EXECUTION_TERMINAL_SQL="('COMPLETED','FAILED','CANCELLED')";
  static Instant instant(JsonNode row,String key){return row==null||!row.hasNonNull(key)?null:Instant.parse(row.path(key).asText());}
  static ObjectNode step(JsonNode plan,String id){for(JsonNode step:plan.path("steps"))if(step.path("id").asText().equals(id))return (ObjectNode)step;return null;}
  static boolean dependenciesResolved(JsonNode step,List<ObjectNode> logical,JsonNode plan){for(JsonNode d:step.path("dependsOn")){ObjectNode dependency=logical.stream().filter(s->s.path("stepId").asText().equals(d.asText())).findFirst().orElse(null);if(dependency==null)return false;String status=dependency.path("status").asText();if(status.equals("COMPLETED")||status.equals("SKIPPED"))continue;ObjectNode config=step(plan,d.asText());if(!status.equals("FAILED")||config==null||!config.path("onFailure").asText().equals("continue"))return false;}return true;}
  static int maxAttempts(JsonNode step){return 1+Math.max(0,step.path("retries").asInt());}
  static String message(Throwable e){return e.getMessage()==null?e.getClass().getSimpleName():e.getMessage();}
}
