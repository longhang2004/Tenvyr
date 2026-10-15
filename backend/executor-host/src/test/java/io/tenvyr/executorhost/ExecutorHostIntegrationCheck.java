package io.tenvyr.executorhost;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import io.tenvyr.platform.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Real HTTP Worker -> Java supervisor -> Go session launcher -> native process -> signed callback. */
public final class ExecutorHostIntegrationCheck {
    private static int checks;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    public static void main(String[] args)throws Exception {
        Path repo=Path.of(args.length>0?args[0]:".").toAbsolutePath(),root=Files.createTempDirectory("tenvyr-host-http-").toRealPath();
        Files.createDirectories(root.resolve("state"));
        List<ObjectNode> results=new CopyOnWriteArrayList<>();
        HttpServer callback=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        callback.createContext("/callback",exchange->{try{
            byte[] raw=exchange.getRequestBody().readAllBytes();String timestamp=exchange.getRequestHeaders().getFirst("X-AgentWeave-Timestamp"),id=exchange.getRequestHeaders().getFirst("X-AgentWeave-Delivery-Id");
            Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec("secret".getBytes(StandardCharsets.UTF_8),"HmacSHA256"));mac.update((timestamp+"."+id+".").getBytes(StandardCharsets.UTF_8));
            check(("v1="+HexFormat.of().formatHex(mac.doFinal(raw))).equals(exchange.getRequestHeaders().getFirst("X-AgentWeave-Signature")),"independent raw-body HMAC");
            ObjectNode value=(ObjectNode)Json.parse(new String(raw,StandardCharsets.UTF_8));if(value.has("status"))results.add(Protocol.result(value));
            exchange.sendResponseHeaders(204,-1);
        }catch(Exception failure){exchange.sendResponseHeaders(500,-1);}finally{exchange.close();}});callback.start();
        String origin="http://127.0.0.1:"+callback.getAddress().getPort();
        String classpath=String.join(java.io.File.pathSeparator,Arrays.stream(System.getProperty("java.class.path").split(java.io.File.pathSeparator)).map(p->Path.of(p).toAbsolutePath().normalize().toString()).toList());
        HostConfig.Profile profile=new HostConfig.Profile("echo-agent",Path.of(System.getProperty("java.home"),"bin","java").toString(),List.of("-cp",classpath,FakeProcess.class.getName(),"echo"),root,Map.of(),Map.of(),3000,65536,65536,0,"TOKEN",null,null,"generic-cli",true,null,false);
        HostConfig config=new HostConfig(List.of(profile),root,root.resolve("state"),List.of(origin),Map.of("key","secret"),true,0,"TOKEN",repo.resolve("backend/executor-host/native/tenvyr-process-launcher"),Map.of("TOKEN","token"));
        Main.Authority unused=new Main.Authority(){public ObjectNode revision(String id,int revision){throw new AssertionError("Static profile queried revision");}public ObjectNode workspace(String id){throw new AssertionError("No workspace member");}public ObjectNode executionWorkspace(String id,String execution){throw new AssertionError("No workspace member");}};
        try(Main host=new Main(config,unused)){
            int port=host.start().get(0).address().getPort();
            ObjectNode request=(ObjectNode)Json.parse(Files.readString(repo.resolve("contracts/conformance/run-request/valid/minimal.json")));
            ((ObjectNode)request.path("invocation")).set("input",Json.object("opaque","native-http","__proto__",Json.object("kept",true)));
            request.set("resultDelivery",Json.object("mode","callback","callbackUrl",origin+"/callback","authentication",Json.object("scheme","hmac-sha256","keyId","key")));
            HttpClient client=HttpClient.newHttpClient();
            for(int repeat=0;repeat<2;repeat++){
                var response=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/v1/runs")).timeout(Duration.ofSeconds(5)).header("Authorization","Bearer token").header("Content-Type","application/json").header("Idempotency-Key",request.path("invocation").path("invocationId").asText()).POST(HttpRequest.BodyPublishers.ofString(Json.stringify(request))).build(),HttpResponse.BodyHandlers.ofString());
                check(response.statusCode()==202,"native host admits/replays canonical request");
            }
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while(results.isEmpty()&&System.nanoTime()<deadline)Thread.sleep(20);
            check(results.size()==1,"one native terminal callback");ObjectNode result=results.get(0);
            check(result.path("status").asText().equals("succeeded"),"native process succeeds: "+result);
            check(result.path("output").path("input").path("opaque").asText().equals("native-http"),"opaque invocation reaches real process stdin");
            check(result.path("output").path("input").path("__proto__").path("kept").asBoolean(),"native JSON special keys preserved");
        } finally {callback.stop(0);try(var paths=Files.walk(root)){for(Path p:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(p);}}
        System.out.println("ExecutorHostIntegrationCheck: "+checks+" real HTTP/native-process checks passed");
    }
}
