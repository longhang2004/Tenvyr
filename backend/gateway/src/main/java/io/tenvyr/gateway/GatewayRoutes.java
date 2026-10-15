package io.tenvyr.gateway;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.time.Duration;
import java.util.*;

/** Explicit public route contract; forwarding never carries arbitrary browser queries. */
public final class GatewayRoutes {
    public record Route(String method, String pattern, List<String> queries, boolean body, boolean encodeParameters) {}
    public record Response(int status, String contentType, String body) {
        static Response json(int status, JsonNode body) { return new Response(status, "application/json; charset=utf-8", Json.stringify(body)); }
    }
    @FunctionalInterface public interface Broadcast { void send(String executionId, JsonNode data); }
    private final String orchestrator;
    private final HttpClient client;
    private final Broadcast broadcast;
    private final Path cwd, home;
    public static final List<Route> ROUTES = routes();
    public GatewayRoutes(String orchestrator, Broadcast broadcast) { this(orchestrator, broadcast, Path.of(System.getenv().getOrDefault("TENVYR_FS_CWD",System.getProperty("user.dir"))), Path.of(System.getProperty("user.home"))); }
    public GatewayRoutes(String orchestrator, Broadcast broadcast, Path cwd, Path home) { this.orchestrator=orchestrator;this.broadcast=broadcast;this.cwd=cwd;this.home=home;client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NORMAL).build(); }
    public Response handle(String method, String rawPath, Map<String, List<String>> query, String rawBody) {
        String path = rawPath.endsWith("/") && rawPath.length()>1 ? rawPath.substring(0,rawPath.length()-1) : rawPath;
        if (method.equals("GET") && path.equals("/health")) return Response.json(200,envelope(Json.object("status","UP","service","gateway")));
        if (method.equals("GET") && path.equals("/")) return Response.json(200,envelope(Json.object("message","Welcome to Tenvyr Gateway API")));
        if (method.equals("GET") && path.equals("/workbench")) {
            try(var in=GatewayRoutes.class.getResourceAsStream("/workbench-page.html")) {
                if(in==null) throw new IllegalStateException("Workbench resource missing");
                return new Response(200,"text/html; charset=utf-8",new String(in.readAllBytes(),StandardCharsets.UTF_8));
            } catch(Exception e) { return Response.json(500,Json.object("statusCode",500,"message","Internal server error")); }
        }
        if (method.equals("GET") && path.equals("/api/fs/dirs")) return directories(first(query,"path"));
        if(method.equals("POST") && path.equals("/api/webhooks/execution-update")) {
            JsonNode body;
            try { body=parseBody(rawBody); } catch(RuntimeException e) { return invalidJson(); }
            String executionId = Json.text(body,"executionId","undefined");
            JsonNode updated = forward("GET","/executions/"+executionId,null);
            if(Json.bool(updated,"success",false)) broadcast.send(executionId,Json.get(updated,"data"));
            return Response.json(201,Json.object("success",true));
        }
        for(Route route:ROUTES) {
            if(!route.method.equals(method)) continue;
            String target=match(route,path);
            if(target==null)continue;
            StringJoiner params=new StringJoiner("&");
            for(String key:route.queries) { String value=first(query,key);if(value!=null && !value.isEmpty())params.add(form(key)+"="+(route.pattern.equals("/api/workbench/executions")||route.pattern.equals("/api/workbench/commands/audit")?component(value):form(value))); }
            if(params.length()>0)target+="?"+params;
            JsonNode body=null;
            if(route.body)try { body=parseBody(rawBody); } catch(RuntimeException e) { return invalidJson(); }
            return Response.json(method.equals("POST")?201:200,forward(method,target,body));
        }
        return Response.json(404,Json.object("message","Cannot "+method+" "+rawPath,"error","Not Found","statusCode",404));
    }
    public JsonNode forward(String method,String path,JsonNode body) {
        try {
            HttpRequest.Builder builder=HttpRequest.newBuilder(URI.create(orchestrator+path)).timeout(Duration.ofSeconds(30));
            if(body!=null)builder.header("Content-Type","application/json");
            HttpResponse<String> response=client.send(builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(Json.stringify(body))).build(),HttpResponse.BodyHandlers.ofString());
            JsonNode data=Json.parse(response.body());
            if(response.statusCode()<200 || response.statusCode()>=300) {
                JsonNode error=data.get("message"); if(!truthy(error))error=data.get("error");if(!truthy(error))error=Json.value("Orchestrator returned HTTP "+response.statusCode());
                return Json.object("success",false,"data",null,"error",error);
            }
            return data;
        } catch(Exception e) { if(e instanceof InterruptedException)Thread.currentThread().interrupt();return Json.object("success",false,"data",null,"error",e.getMessage()==null?e.toString():e.getMessage()); }
    }
    public Response directories(String target) {
        if(target==null || target.trim().isEmpty())target=cwd.toString();
        if(target.startsWith("~"))target=home.toString()+"/"+target.substring(1);
        try {
            Path resolved=cwd.resolve(target).normalize().toAbsolutePath();
            var attributes=Files.readAttributes(resolved,java.nio.file.attribute.BasicFileAttributes.class);
            if(!attributes.isDirectory())return Response.json(400,Json.object("error","Path is not a directory"));
            List<String> directories=new ArrayList<>();
            try(var entries=Files.list(resolved)) { entries.filter(p->Files.isDirectory(p,LinkOption.NOFOLLOW_LINKS) && !p.getFileName().toString().startsWith(".")).forEach(p->directories.add(p.getFileName().toString())); }
            directories.sort(Json::localeCompare);
            Path parent=resolved.getParent();
            return Response.json(200,Json.object("currentPath",resolved.toString(),"parentPath",parent==null?null:parent.toString(),"homePath",home.toString(),"directories",directories));
        } catch(Exception e) { return Response.json(400,Json.object("error",e.getMessage()==null?e.toString():e.getMessage())); }
    }
    private static boolean truthy(JsonNode n) { return n!=null&&!n.isNull()&&(!n.isTextual()||!n.textValue().isEmpty())&&(!n.isBoolean()||n.booleanValue())&&(!n.isNumber()||n.doubleValue()!=0); }
    private static JsonNode parseBody(String raw) { JsonNode body=raw==null||raw.isEmpty()?Json.object():Json.parse(raw);if(!body.isObject()&&!body.isArray())throw new IllegalArgumentException("Invalid JSON body");return body; }
    private static Response invalidJson() { return Response.json(400,Json.object("message","Invalid JSON","error","Bad Request","statusCode",400)); }
    private static ObjectNode envelope(JsonNode data) { return Json.object("success",true,"data",data,"error",null,"meta",Json.object("timestamp",Protocol.jsInstant(Instant.now()))); }
    static String first(Map<String,List<String>> query,String key) { List<String> values=query.get(key);return values==null||values.isEmpty()?null:values.get(0); }
    private static String form(String text) { return URLEncoder.encode(text,StandardCharsets.UTF_8); }
    private static String component(String text) { return form(text).replace("+","%20").replace("%21","!").replace("%27","'").replace("%28","(").replace("%29",")").replace("%7E","~"); }
    private static String match(Route route,String path) {
        String[] actual=path.split("/",-1), expected=route.pattern.split("/",-1);
        if(actual.length!=expected.length)return null;
        List<String> out=new ArrayList<>();
        for(int i=2;i<expected.length;i++) {
            String segment=URLDecoder.decode(actual[i].replace("+","%2B"),StandardCharsets.UTF_8);
            if(expected[i].startsWith(":")) { if(segment.isEmpty())return null;out.add(route.encodeParameters?component(segment):segment); }
            else { if(!expected[i].equals(segment))return null;out.add(segment); }
        }
        if(actual.length<2||!actual[1].equals("api"))return null;
        return "/"+String.join("/",out);
    }
    private static List<Route> routes() {
        List<Route> routes=new ArrayList<>();
        add(routes,"POST","pipelines");
        add(routes,"GET","connections","connections/templates","connections/:connectionId","workbench/connections","workbench/attention","workbench/onboarding/:runtimeKind");
        add(routes,"POST","connections");add(routes,"PATCH","connections/:connectionId");
        add(routes,"GET","model-sources");add(routes,"POST","model-sources","model-sources/:sourceId/test","model-sources/:sourceId/refresh");add(routes,"PATCH","model-sources/:sourceId");add(routes,"DELETE","model-sources/:sourceId");
        add(routes,"POST","provider-discovery/discover","provider-discovery/refresh-models","provider-discovery/auth-methods","provider-discovery/commands/test-target","provider-discovery/commands/oauth-begin","provider-discovery/commands/oauth-complete","provider-discovery/commands/oauth-cancel");
        routes.add(new Route("GET","/api/provider-discovery/auth-flows/active",List.of("connectionId","providerId"),false,true));
        add(routes,"GET","workbench/workspaces","workbench/commands/team-templates","workbench/executions/:executionId","workbench/executions/:executionId/capsule");
        routes.add(new Route("GET","/api/workbench/executions",List.of("page"),false,true));
        routes.add(new Route("GET","/api/workbench/commands/audit",List.of("action"),false,true));
        add(routes,"POST","workbench/commands/onboard-runtime","workbench/commands/create-workspace","workbench/commands/start-team-run","workbench/commands/waits/:runId","workbench/commands/executions/:executionId/cancel","workbench/commands/executions/:executionId/replay","workbench/commands/compare","workbench/commands/workspaces/:workspaceExecutionId/release","connections/:connectionId/test","connections/:connectionId/revoke");
        add(routes,"GET","pipelines","executions");add(routes,"POST","executions");
        routes.add(new Route("GET","/api/pipelines/:id",List.of(),false,false));routes.add(new Route("GET","/api/executions/:id",List.of(),false,false));
        routes.add(new Route("GET","/api/executions/:id/events",List.of("stepAttemptId","type","limit","afterReceivedAt","afterId"),false,false));
        routes.add(new Route("POST","/api/executions/:id/cancel",List.of(),false,false));
        return List.copyOf(routes);
    }
    private static void add(List<Route> routes,String method,String... paths) { for(String path:paths)routes.add(new Route(method,"/api/"+path,List.of(),!method.equals("GET"),true)); }
}
