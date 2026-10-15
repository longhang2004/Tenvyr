package io.tenvyr.control.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import io.tenvyr.control.engine.EngineRuntime;
import java.sql.Connection;

public final class RuntimeFacade implements EngineRuntime {
    private final RuntimeConnectionService connections;private final WorkspaceExecutionService workspaces;private final RuntimeCoordinationService coordination;
    public RuntimeFacade(RuntimeConnectionService connections,WorkspaceExecutionService workspaces,RuntimeCoordinationService coordination){this.connections=connections;this.workspaces=workspaces;this.coordination=coordination;}
    public ObjectNode resolveExecutor(Connection c,ObjectNode step,ObjectNode descriptor){return Executors.resolve(Db.on(c),connections,step,descriptor);}
    public JsonNode workspaceMetadata(Connection c,String execution){Db db=Db.on(c);ObjectNode run=db.one("SELECT * FROM coordination_runs WHERE \"executionId\"=?",execution);ObjectNode metadata=Json.object();if(run!=null){JsonNode identity=workspaces.executionWorkspaceIdentityForRun(db,Json.text(run,"id"));if(identity!=null)metadata.set("executionWorkspace",identity);}return metadata;}
    public boolean reconcileCoordination(String execution){return coordination.reconcileCoordination(execution);}
    public boolean completionHeld(String execution){return coordination.isCompletionHeld(execution);}
    public boolean isVerifierStep(String execution,String step){return coordination.isVerifierStep(execution,step);}
    public JsonNode buildVerifierInput(String execution,String step){return coordination.buildVerifierInput(execution,step);}
}
