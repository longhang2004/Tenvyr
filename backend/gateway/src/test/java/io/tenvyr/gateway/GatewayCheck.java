package io.tenvyr.gateway;

import com.sun.net.httpserver.HttpServer;
import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/** Runnable checks use real HTTP and WebSocket connections, including transport upgrade. */
public final class GatewayCheck {
    private static final HttpClient CLIENT=HttpClient.newHttpClient();
    private static String base;
    public static void main(String[] args)throws Exception {
        origins();directories();
        HttpServer orchestrator=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        orchestrator.createContext("/",exchange->{String uri=exchange.getRequestURI().toString();boolean rejected=uri.contains("rejected");String body=Json.stringify(rejected?Json.object("message",Json.array("bad field")):Json.object("success",true,"data",Json.object("path",uri,"method",exchange.getRequestMethod(),"body",new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8))));byte[] bytes=body.getBytes(StandardCharsets.UTF_8);exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(rejected?422:200,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();});orchestrator.start();
        try(Gateway gateway=new Gateway("http://127.0.0.1:"+orchestrator.getAddress().getPort(),null,200,160)) {
            base="http://127.0.0.1:"+gateway.start("127.0.0.1",0);
            routes();polling();websocket();upgrade();heartbeat();duplicatePolling();
        } finally {orchestrator.stop(0);}
        System.out.println("Gateway checks passed: 50 retained routes, filesystem, origins, Engine.IO polling/WebSocket/upgrade/heartbeat.");
    }
    private static void origins() {
        LocalOrigin defaults=new LocalOrigin(null);check(!defaults.enabled(),"HTTP CORS defaults off");
        for(String origin:new String[]{"http://localhost:4000","https://127.0.0.1:123","http://[::1]:4000"})check(defaults.socketAllowed(origin),"loopback accepted");
        for(String origin:new String[]{"https://evil.test","null","file://localhost/a","nonsense"})check(!defaults.socketAllowed(origin),"remote origin denied");
        check(defaults.socketAllowed(null),"non-browser clients");
        LocalOrigin explicit=new LocalOrigin(" https://one.test, http://localhost:4000 ");check(explicit.httpAllowed("https://one.test"),"allowlist HTTP");check(!explicit.socketAllowed("http://localhost:3000"),"exact allowlist");
        for(String raw:new String[]{"*","http://localhost,*",", "})try{new LocalOrigin(raw);throw new AssertionError("wildcard/empty rejected");}catch(IllegalArgumentException expected){}
    }
    private static void directories()throws Exception {
        Path dir=Files.createTempDirectory("gateway-fs"),home=dir.resolve("home");Files.createDirectories(home);Files.createDirectories(dir.resolve("Zoo"));Files.createDirectories(dir.resolve("alpha"));Files.createDirectories(dir.resolve(".hidden"));Files.writeString(dir.resolve("file"),"file");Files.createSymbolicLink(dir.resolve("link"),dir.resolve("alpha"));
        GatewayRoutes routes=new GatewayRoutes("http://127.0.0.1:1",(id,data)->{},dir,home);
        JsonNode output=Json.parse(routes.directories("").body());check(output.path("currentPath").asText().equals(dir.toString()),"default cwd");check(output.path("directories").equals(Json.array("alpha","home","Zoo")),"directories exclude hidden/files/symlinks and locale-sort");
        check(Json.parse(routes.directories("~").body()).path("currentPath").asText().equals(home.toString()),"home expansion");check(Json.parse(routes.directories("alpha/..").body()).path("currentPath").asText().equals(dir.toString()),"relative lexical path");check(routes.directories("file").status()==400,"non-directory");check(routes.directories("missing").status()==400,"missing path");
        check(Json.parse(routes.directories("/").body()).path("parentPath").isNull(),"root no parent");
        try(var paths=Files.walk(dir)){for(Path p:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(p);}
    }
    private static void routes()throws Exception {
        check(GatewayRoutes.ROUTES.size()==46,"all forwarded routes");
        for(GatewayRoutes.Route route:GatewayRoutes.ROUTES) {
            String path=route.pattern().replaceAll(":[A-Za-z]+","sample%20id");
            HttpResponse<String> response=request(route.method(),path+(route.queries().isEmpty()?"":"?"+route.queries().get(0)+"=one%20two&secret=never"),"{\"hello\":1}");
            JsonNode result=Json.parse(response.body());check(response.statusCode()==(route.method().equals("POST")?201:200),"route status: "+route.pattern());check(result.path("success").asBoolean(),"route forwarded: "+route.pattern());
            String upstream=result.path("data").path("path").asText();check(!upstream.contains("secret"),"bounded queries");
            check(result.path("data").path("body").asText().equals(route.body()?"{\"hello\":1}":""),"route body policy: "+route.pattern());
        }
        check(Json.parse(request("GET","/api/executions/rejected",null).body()).path("error").equals(Json.array("bad field")),"upstream error shape");
        check(request("GET","/workbench",null).body().toLowerCase(Locale.ROOT).contains("<!doctype html>"),"workbench HTML resource");
        check(Json.parse(request("GET","/health",null).body()).path("data").path("service").asText().equals("gateway"),"health");
        check(request("GET","/",null).statusCode()==200,"root");check(request("GET","/unknown",null).statusCode()==404,"unknown route");check(request("POST","/api/pipelines","{").statusCode()==400,"invalid JSON");
        HttpResponse<String> remote=CLIENT.send(HttpRequest.newBuilder(URI.create(base+"/socket.io/?EIO=4&transport=polling")).header("Origin","https://remote.test").build(),HttpResponse.BodyHandlers.ofString());check(remote.statusCode()==403,"socket remote-origin guard");
        check(request("GET","/socket.io/?EIO=3&transport=polling",null).statusCode()==400,"Engine protocol guard");
        check(request("GET","/socket.io/?EIO=4&transport=polling&sid=unknown",null).statusCode()==400,"unknown session guard");
    }
    private static String session()throws Exception {String packet=request("GET","/socket.io/?EIO=4&transport=polling",null).body();check(packet.startsWith("0"),"Engine open");JsonNode open=Json.parse(packet.substring(1));check(open.path("maxPayload").asInt()==1_000_000,"maxPayload");check(open.path("upgrades").equals(Json.array("websocket")),"upgrade advertisement");return open.path("sid").asText();}
    private static String pollingPath(String sid) {return "/socket.io/?EIO=4&transport=polling&sid="+sid;}
    private static void polling()throws Exception {
        String sid=session();check(request("POST",pollingPath(sid),"40").body().equals("ok"),"polling POST acknowledged");String connected=request("GET",pollingPath(sid),null).body();check(connected.startsWith("40{"),"Socket.IO connect");
        request("POST","/api/webhooks/execution-update","{\"executionId\":\"execution-test\"}");String update=request("GET",pollingPath(sid),null).body();check(update.startsWith("42["),"Socket.IO event envelope");event(update);
        request("POST",pollingPath(sid),"1");
    }
    private static void websocket()throws Exception {
        Frames frames=new Frames();WebSocket socket=CLIENT.newWebSocketBuilder().header("Origin","http://localhost:4000").buildAsync(URI.create(base.replace("http","ws")+"/socket.io/?EIO=4&transport=websocket"),frames).get(3,TimeUnit.SECONDS);
        check(frames.next().startsWith("0{"),"WebSocket Engine handshake");socket.sendText("40",true).join();check(frames.next().startsWith("40{"),"WebSocket namespace connect");request("POST","/api/webhooks/execution-update","{\"executionId\":\"execution-test\"}");event(frames.next());socket.sendClose(1000,"done").join();
    }
    private static void upgrade()throws Exception {
        String sid=session();request("POST",pollingPath(sid),"40");request("GET",pollingPath(sid),null);
        CompletableFuture<HttpResponse<String>> poll=CLIENT.sendAsync(HttpRequest.newBuilder(URI.create(base+pollingPath(sid))).build(),HttpResponse.BodyHandlers.ofString());
        Frames frames=new Frames();WebSocket socket=CLIENT.newWebSocketBuilder().buildAsync(URI.create(base.replace("http","ws")+"/socket.io/?EIO=4&transport=websocket&sid="+sid),frames).get(3,TimeUnit.SECONDS);
        socket.sendText("2probe",true).join();check(frames.next().equals("3probe"),"upgrade probe pong");check(poll.get(3,TimeUnit.SECONDS).body().equals("6"),"polling noop drains during upgrade");socket.sendText("5",true).join();request("POST","/api/webhooks/execution-update","{\"executionId\":\"execution-test\"}");event(frames.next());socket.sendClose(1000,"done").join();
    }
    private static void heartbeat()throws Exception {
        String sid=session();String ping=request("GET",pollingPath(sid),null).body();check(ping.equals("2"),"server heartbeat ping");request("POST",pollingPath(sid),"3");check(request("GET",pollingPath(sid),null).body().equals("2"),"pong schedules next ping");check(request("GET",pollingPath(sid),null).body().equals("1"),"missed pong closes session");check(request("GET",pollingPath(sid),null).statusCode()==400,"timed out session removed");
    }
    private static void duplicatePolling()throws Exception {
        String sid=session();CompletableFuture<HttpResponse<String>> first=CLIENT.sendAsync(HttpRequest.newBuilder(URI.create(base+pollingPath(sid))).build(),HttpResponse.BodyHandlers.ofString());Thread.sleep(20);check(request("GET",pollingPath(sid),null).statusCode()==400,"duplicate GET rejected");check(first.get(3,TimeUnit.SECONDS).body().equals("1"),"duplicate GET closes original session");
    }
    private static void event(String packet) {check(packet.startsWith("42"),"execution event packet");JsonNode array=Json.parse(packet.substring(2));check(array.get(0).asText().equals("execution-update"),"event name");JsonNode payload=array.get(1);check(payload.path("executionId").asText().equals("execution-test")&&payload.has("data")&&payload.has("timestamp"),"event shape");}
    private static HttpResponse<String> request(String method,String path,String body)throws Exception {HttpRequest.Builder request=HttpRequest.newBuilder(URI.create(base+path)).timeout(Duration.ofSeconds(3));if(body!=null)request.header("Content-Type","application/json");return CLIENT.send(request.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());}
    private static void check(boolean value,String label) {if(!value)throw new AssertionError(label);}
    private static final class Frames implements WebSocket.Listener {
        final BlockingQueue<String> frames=new LinkedBlockingQueue<>();final StringBuilder partial=new StringBuilder();
        @Override public void onOpen(WebSocket socket){socket.request(1);}
        @Override public CompletionStage<?> onText(WebSocket socket,CharSequence data,boolean last){partial.append(data);if(last){frames.add(partial.toString());partial.setLength(0);}socket.request(1);return null;}
        String next()throws InterruptedException {String packet=frames.poll(3,TimeUnit.SECONDS);if(packet==null)throw new AssertionError("Expected WebSocket frame");return packet;}
    }
}
