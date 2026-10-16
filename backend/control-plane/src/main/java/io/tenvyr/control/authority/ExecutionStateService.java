package io.tenvyr.control.authority;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import io.tenvyr.platform.domain.ExecutionState;
import java.time.Instant;
import java.util.List;

public final class ExecutionStateService {
    private final Db db;
    public ExecutionStateService(Db db){this.db=db;}
    public ObjectNode read(String id){ObjectNode e=db.one("SELECT * FROM executions WHERE id=?::uuid",id);return e==null?null:Json.object("executionId",id,"state",e.hasNonNull("executionState")?e.get("executionState").deepCopy():Json.object(),"version",e.get("executionStateVersion"),"updatedAt",Json.get(e,"executionStateUpdatedAt"));}
    public ObjectNode mutate(String id,int expected,JsonNode input){JsonNode patch=ExecutionState.validateStatePatch(input);return db.transaction(t->{ObjectNode e=t.one("SELECT * FROM executions WHERE id=?::uuid FOR UPDATE",id);if(e==null)return Json.object("disposition","missing");if(List.of("COMPLETED","FAILED","CANCELLED").contains(Json.text(e,"status")))return Json.object("disposition","terminal","status",e.get("status"));int v=Json.integer(e,"executionStateVersion",0);if(v!=expected)return Json.object("disposition","conflict","version",v);ObjectNode result=ExecutionState.applyStatePatch(e.hasNonNull("executionState")?e.get("executionState"):Json.object(),patch);if(!result.path("changed").asBoolean())return Json.object("disposition","noop","version",v,"state",result.get("state"));JsonNode state=result.get("state");ExecutionState.validateState(state);t.execute("UPDATE executions SET \"executionState\"=?,\"executionStateVersion\"=?,\"executionStateUpdatedAt\"=?,\"rowVersion\"=\"rowVersion\"+1,\"updatedAt\"=now() WHERE id=?::uuid",state,v+1,Instant.now(),id);return Json.object("disposition","applied","version",v+1,"state",state.deepCopy());});}
}
