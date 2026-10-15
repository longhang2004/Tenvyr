package io.tenvyr.control;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.*;
import io.tenvyr.control.engine.*;
import io.tenvyr.control.runtime.*;
import java.time.Instant;
import java.util.*;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.constructor.SafeConstructor;

/** Existing operator API envelopes and status codes; services retain all authority. */
public final class ControlRoutes {
    private final PipelineService pipelines;private final ExecutionService executions;private final EngineService engine;private final AgentEventService events;private final HttpAgentAdapter callbacks;
    private final RuntimeConnectionService connections;private final WorkspaceService workspaces;private final RuntimeOnboardingService onboarding;private final ModelSourceService sources;private final ProviderDiscoveryService providers;private final WorkbenchCommandService commands;private final WorkbenchProjectionService projection;private final AttentionService attention;
    public ControlRoutes(PipelineService pipelines,ExecutionService executions,EngineService engine,AgentEventService events,HttpAgentAdapter callbacks,RuntimeConnectionService connections,WorkspaceService workspaces,RuntimeOnboardingService onboarding,ModelSourceService sources,ProviderDiscoveryService providers,WorkbenchCommandService commands,WorkbenchProjectionService projection,AttentionService attention){this.pipelines=pipelines;this.executions=executions;this.engine=engine;this.events=events;this.callbacks=callbacks;this.connections=connections;this.workspaces=workspaces;this.onboarding=onboarding;this.sources=sources;this.providers=providers;this.commands=commands;this.projection=projection;this.attention=attention;}
    public void register(Http http){
        http.route("GET","/",r->Http.json(200,envelope(Json.object("message","Welcome to Tenvyr Orchestrator API"))));
        http.route("GET","/health",r->{ObjectNode probe=executions.healthProbe();return Http.json(200,envelope(Json.object("status",probe.path("ready").asBoolean()?"UP":"DEGRADED","service","orchestrator","ready",probe.get("ready"),"reasonCode",probe.get("reasonCode"))));});
        http.route("POST","/pipelines",r->{try{return success(201,pipelines.create(pipelineInput(r.body())));}catch(Exception failure){return Http.json(201,Json.object("success",false,"error","Failed to create pipeline: "+failure.getMessage()));}});
        http.route("GET","/pipelines",r->success(200,pipelines.findAll()));
        http.route("GET","/pipelines/:id",r->{ObjectNode data=pipelines.findOne(r.path("id"));return data==null?nestError(404,"Pipeline not found"):success(200,data);});
        http.route("POST","/executions",r->{try{JsonNode body=r.body();return success(201,engine.startExecution(Json.text(body,"pipelineId"),body.hasNonNull("input")?body.get("input"):Json.object()));}catch(Exception failure){return Http.json(201,Json.object("success",false,"error","Failed to start execution: "+failure.getMessage()));}});
        http.route("GET","/executions",r->success(200,executions.listExecutions()));
        http.route("GET","/executions/:id",r->{ObjectNode data=executions.getExecution(r.path("id"));if(data==null)return nestError(404,"Execution not found");ArrayNode steps=Json.array();for(ObjectNode step:executions.getStepExecutions(r.path("id"))){step.set("attempts",Json.value(executions.getStepAttempts(step.path("id").asText())));steps.add(step);}data.set("steps",steps);return success(200,data);});
        http.route("GET","/executions/:id/events",r->{if(executions.getExecution(r.path("id"))==null)return nestError(404,"Execution not found");try{AgentEventService.Page page=events.list(r.path("id"),r.query("stepAttemptId"),r.query("type"),eventLimit(r.query("limit")),eventCursor(r.query("afterReceivedAt"),r.query("afterId")));return success(200,Json.object("events",page.events(),"next",page.next()==null?null:Json.object("receivedAt",page.next().receivedAt().toString(),"id",page.next().id())));}catch(IllegalArgumentException bad){return nestError(400,bad.getMessage());}});
        http.route("POST","/executions/:id/cancel",r->{try{return success(201,engine.cancelExecution(r.path("id")));}catch(Exception failure){return failure.getMessage()!=null&&failure.getMessage().contains("not found")?nestError(404,"Execution not found"):Http.json(201,Json.object("success",false,"error","Failed to cancel execution: "+failure.getMessage()));}});
        http.route("POST","/internal/agent-callbacks/http/:agent",r->{try{callbacks.handleCallback(r.path("agent"),r.header(HttpAgentAdapter.KEY_ID),r.header(HttpAgentAdapter.TIMESTAMP),r.header(HttpAgentAdapter.DELIVERY_ID),r.header(HttpAgentAdapter.SIGNATURE),r.rawBody(),r.exchange().getRemoteAddress().getAddress().getHostAddress(),null);return new Http.Response(204,new byte[0],"application/json");}catch(Exception rejected){return nestError(callbacks.callbackStatus(rejected),null);}});

        http.route("GET","/connections",r->success(200,connections.listConnections()));
        http.route("GET","/connections/templates",r->{ArrayNode templates=Json.array();for(String kind:RuntimeProfiles.KINDS)templates.add(RuntimeProfiles.template(kind));return success(200,templates);});
        http.route("POST","/connections",mapped(r->success(201,commands.createConnection(object(r.body()))),"connection"));
        http.route("PATCH","/connections/:connectionId",mapped(r->success(200,commands.reviseConnection(with(r,"connectionId"))),"connection"));
        http.route("GET","/connections/:connectionId",mapped(r->success(200,connections.connectionStatus(r.path("connectionId"))),"connection"));
        http.route("POST","/connections/:connectionId/test",mapped(r->success(201,commands.testConnection(with(r,"connectionId"))),"connection"));
        http.route("POST","/connections/:connectionId/revoke",mapped(r->success(201,commands.revokeConnection(with(r,"connectionId"))),"connection"));
        http.route("GET","/model-sources",r->success(200,sources.list()));
        http.route("POST","/model-sources",mapped(r->success(201,commands.createModelSource(object(r.body()))),"source"));
        http.route("PATCH","/model-sources/:sourceId",mapped(r->success(200,commands.updateModelSource(with(r,"sourceId"))),"source"));
        http.route("DELETE","/model-sources/:sourceId",mapped(r->success(200,commands.deleteModelSource(with(r,"sourceId"))),"source"));
        http.route("POST","/model-sources/:sourceId/test",mapped(r->success(201,commands.testModelSource(with(r,"sourceId"))),"source"));
        http.route("POST","/model-sources/:sourceId/refresh",mapped(r->success(201,commands.refreshModelSource(with(r,"sourceId"))),"source"));

        http.route("POST","/provider-discovery/discover",mapped(r->success(201,providers.discoverRuntimeProviders(Json.text(r.body(),"connectionId"))),"provider"));
        http.route("POST","/provider-discovery/refresh-models",mapped(r->{JsonNode b=r.body();return success(201,providers.refreshRuntimeModels(Json.text(b,"connectionId"),Json.text(b,"providerId")));},"provider"));
        http.route("POST","/provider-discovery/auth-methods",mapped(r->{JsonNode b=r.body();return success(201,providers.getRuntimeProviderAuthMethods(Json.text(b,"connectionId"),Json.text(b,"providerId")));},"provider"));
        http.route("GET","/provider-discovery/auth-flows/active",mapped(r->success(200,providers.getActiveAuthFlows(bound(r.query("connectionId"),255,""),bound(r.query("providerId"),255,null))),"provider"));
        http.route("POST","/provider-discovery/commands/test-target",mapped(r->success(201,commands.testRuntimeTarget(object(r.body()))),"provider"));
        http.route("POST","/provider-discovery/commands/oauth-begin",mapped(r->success(201,commands.openCodeOauthBegin(object(r.body()))),"provider"));
        http.route("POST","/provider-discovery/commands/oauth-complete",mapped(r->success(201,commands.openCodeOauthComplete(object(r.body()))),"provider"));
        http.route("POST","/provider-discovery/commands/oauth-cancel",mapped(r->success(201,providers.cancelAuthFlow(Json.text(r.body(),"authFlowId"))),"provider"));

        http.route("GET","/workbench/attention",r->Http.json(200,attention.attention()));
        http.route("GET","/workbench/onboarding/:runtimeKind",r->Http.json(200,RuntimeOnboardingService.kinds().contains(r.path("runtimeKind"))?Json.object("status",onboarding.status(r.path("runtimeKind"))):Json.object("error",Json.object("code","RUNTIME_NOT_SUPPORTED","message","onboarding supports "+String.join(", ",RuntimeOnboardingService.kinds())))));
        http.route("GET","/workbench/workspaces",r->{ArrayNode rows=Json.array();for(ObjectNode row:workspaces.list())rows.add(Json.object("workspaceId",row.get("id"),"name",row.get("name"),"path",row.get("path"),"snapshot",row.get("snapshot"),"updatedAt",row.get("updatedAt")));return Http.json(200,Json.object("workspaces",rows));});
        http.route("GET","/workbench/connections",r->Http.json(200,projection.connectionCards()));
        http.route("GET","/workbench/executions/:executionId/capsule",mapped(r->Http.json(200,Json.object("capsule",projection.capsuleFor(r.path("executionId")))),"projection"));
        http.route("GET","/workbench/executions",r->Http.json(200,projection.executionSummaries(positivePage(r.query("page")))));
        http.route("GET","/workbench/executions/:executionId",mapped(r->Http.json(200,projection.executionProjection(r.path("executionId"))),"projection"));
        http.route("POST","/workbench/commands/start-team-run",mapped(r->Http.json(201,commands.startTeamRun(object(r.body()))),"command"));
        http.route("POST","/workbench/commands/onboard-runtime",mapped(r->Http.json(201,commands.onboardRuntime(object(r.body()))),"command"));
        http.route("POST","/workbench/commands/create-workspace",mapped(r->Http.json(201,commands.createWorkspace(object(r.body()))),"command"));
        http.route("GET","/workbench/commands/team-templates",r->Http.json(200,Json.object("templates",commands.teamTemplates())));
        http.route("POST","/workbench/commands/waits/:runId",mapped(r->Http.json(201,commands.resolveWait(with(r,"runId"))),"command"));
        http.route("POST","/workbench/commands/executions/:executionId/cancel",mapped(r->Http.json(201,commands.cancelExecution(with(r,"executionId"))),"command"));
        http.route("POST","/workbench/commands/executions/:executionId/replay",mapped(r->Http.json(201,commands.replayExecution(with(r,"executionId"))),"command"));
        http.route("POST","/workbench/commands/executions/:executionId/continue",mapped(r->{ObjectNode b=object(r.body());b.put("sourceExecutionId",r.path("executionId"));return Http.json(201,commands.continueRun(b));},"command"));
        http.route("POST","/workbench/commands/compare",mapped(r->Http.json(201,commands.compareExecutions(object(r.body()))),"command"));
        http.route("POST","/workbench/commands/workspaces/:workspaceExecutionId/release",mapped(r->Http.json(201,commands.releaseExecutionWorkspace(with(r,"workspaceExecutionId"))),"command"));
        http.route("GET","/workbench/commands/audit",r->Http.json(200,commands.auditTrail(emptyToNull(r.query("action")),integerPrefix(r.query("limit"),50))));
    }
    private static String emptyToNull(String value){return value==null||value.isEmpty()?null:value;}
    private static String bound(String value,int max,String fallback){return value==null?fallback:value.substring(0,Math.min(max,value.length()));}
    private static ObjectNode object(JsonNode body){return Json.requireObject(body,"Request body").deepCopy();}
    private static ObjectNode with(Http.Request request,String name)throws Exception {ObjectNode body=object(request.body());body.put(name,request.path(name));return body;}
    private static Http.Handler mapped(Http.Handler action,String surface){return r->{try{return action.handle(r);}catch(RuntimeFailure error){return domainError(surface,error.code(),error.getMessage());}catch(AdapterError error){if(surface.equals("connection"))return nestError(400,error.getMessage());throw error;}catch(IllegalArgumentException error){if(surface.equals("provider"))return domainError(surface,"PROVIDER_DISCOVERY_FAILED",error.getMessage());return nestError(400,error.getMessage());}};}
    public static Http.Response domainError(String surface,String code,String message){if(surface.equals("projection"))return Http.json(200,Json.object("error",Json.object("code",code,"message",message)));if(surface.equals("provider")){int status=Set.of("CONNECTION_NOT_FOUND","CONNECTION_REVOKED").contains(code)?400:Set.of("RUNTIME_NOT_SUPPORTED","MODEL_NOT_SUPPORTED","INVALID_MODEL_ID","INVALID_OAUTH_URL","INVALID_METHOD_INDEX","AUTH_METHOD_INVALID","AUTH_METHOD_UNSUPPORTED","AUTH_METHOD_NOT_OAUTH","PROVIDER_NOT_AUTHENTICATED","AUTH_FLOW_NOT_FOUND","AUTH_FLOW_EXPIRED","AUTH_FLOW_LIMIT","AUTH_FLOW_CONFLICT","AUTH_FLOW_STALE","OPENCODE_SERVER_FAILED").contains(code)?422:code.equals("PROVIDER_DISCOVERY_FAILED")?500:400;return Http.json(status,Json.object("success",false,"error",Json.object("code",code,"message",message)));}return nestError((surface.equals("connection")&&code.equals("CONNECTION_NOT_FOUND")||surface.equals("source")&&code.equals("SOURCE_NOT_FOUND"))?404:400,message);}
    public static Http.Response nestError(int status,String message){String error=switch(status){case 400->"Bad Request";case 401->"Unauthorized";case 404->"Not Found";case 503->"Service Unavailable";default->"Internal Server Error";};return Http.json(status,Json.object("message",message==null?error:message,"error",error,"statusCode",status));}
    public static Http.Response success(int status,Object data){return Http.json(status,Json.object("success",true,"data",data));}
    public static ObjectNode envelope(Object data){return Json.object("success",true,"data",data,"error",null,"meta",Json.object("timestamp",Instant.now().toString()));}
    public static JsonNode pipelineInput(JsonNode body){JsonNode data=body;if(body.isTextual()||body.has("yamlString")){String text=body.isTextual()?body.asText():body.path("yamlString").asText();LoaderOptions options=new LoaderOptions();options.setCodePointLimit(1024*1024);options.setMaxAliasesForCollections(50);data=Json.value(new Yaml(new SafeConstructor(options)).load(text));}ObjectNode input=Json.requireObject(data,"Pipeline");return Json.object("name",input.get("name"),"version",input.hasNonNull("version")&&!input.path("version").asText().isEmpty()?input.get("version"):"1.0","description",input.hasNonNull("description")?input.get("description"):"","steps",input.hasNonNull("steps")?input.get("steps"):Json.array());}
    public static int eventLimit(String raw){if(raw==null)return 50;try{double n=Double.parseDouble(raw.trim().isEmpty()?"0":raw.trim());if(Double.isFinite(n)&&n==Math.floor(n))return (int)Math.min(200,Math.max(1,n));}catch(NumberFormatException ignored){}return 50;}
    public static AgentEventService.Cursor eventCursor(String received,String id){if((received==null)!=(id==null))throw new IllegalArgumentException("afterReceivedAt and afterId must be provided together");if(received==null)return null;try{return new AgentEventService.Cursor(Instant.parse(received),id);}catch(Exception invalid){throw new IllegalArgumentException("afterReceivedAt must be an ISO-8601 timestamp");}}
    public static int positivePage(String raw){int value=integerPrefix(raw,1);return value>0?value:1;}
    private static int integerPrefix(String raw,int fallback){if(raw==null)return fallback;java.util.regex.Matcher m=java.util.regex.Pattern.compile("^[+-]?[0-9]+").matcher(raw.stripLeading());if(!m.find())return fallback;try{return Integer.parseInt(m.group());}catch(NumberFormatException excessive){return fallback;}}
}
