package io.tenvyr.worker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Json;
import java.net.URI;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Dependency-free conformance checks; every fixture comes from the retained protocol suite. */
public final class WorkerCheck {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void rejects(Runnable operation){try{operation.run();throw new AssertionError("Expected rejection");}catch(IllegalArgumentException expected){}}
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args.length>0?args[0]:".");
        for(JsonNode vector:Json.parse(Files.readString(root.resolve("contracts/conformance/callback-signatures/vectors.json"))))check(CallbackDelivery.signature(vector.path("secret").asText(),vector.path("timestamp").asText(),vector.path("deliveryId").asText(),vector.path("rawBodyUtf8").asText().getBytes(StandardCharsets.UTF_8)).equals(vector.path("expectedSignature").asText()),"HMAC fixture "+vector.path("name").asText());
        check(CallbackDelivery.KEY_ID.equals("X-AgentWeave-Key-Id")&&CallbackDelivery.TIMESTAMP.equals("X-AgentWeave-Timestamp")&&CallbackDelivery.DELIVERY_ID.equals("X-AgentWeave-Delivery-Id")&&CallbackDelivery.SIGNATURE.equals("X-AgentWeave-Signature"),"Exact v1 headers");
        for(JsonNode vector:Json.parse(Files.readString(root.resolve("contracts/conformance/protocol/retry-after-cases.json")))){Long result=CallbackDelivery.retryAfter(vector.path("value").isNull()?null:vector.path("value").asText(),(long)(vector.path("maximumSeconds").asDouble()*1000));JsonNode expected=vector.path("expected");check("header-delay".equals(expected.path("kind").asText())?Objects.equals(result,(long)(expected.path("seconds").asDouble()*1000)):result==null,"Retry-After fixture "+vector.path("name").asText());}
        JsonNode special=Json.parse("{\"__proto__\":{\"constructor\":{\"prototype\":true}},\"2\":3,\"1\":4}");check(Worker.canonical(special).equals("{\"1\":4,\"2\":3,\"__proto__\":{\"constructor\":{\"prototype\":true}}}"),"Special JSON keys retained");
        check(Worker.canonical(Json.parse("{\"b\":[null,false,1.25],\"a\":1}")).equals(Worker.canonical(Json.parse("{\"a\":1,\"b\":[null,false,1.25]}"))),"Canonical insertion order independence");
        check(Worker.canonical(Json.parse("{\"é\":1,\"é\":2}")).equals(Worker.canonical(Json.parse("{\"é\":2,\"é\":1}"))),"UTF16 fingerprint order for distinct NFC/NFD keys");
        for(String text:List.of("9007199254740992","-9007199254740992","{\"a\":[9007199254740993]}"))rejects(()->Worker.finite(Json.parse(text)));rejects(()->Worker.finite(Json.value(Double.NaN)));
        WorkerConfig config=new WorkerConfig();config.agentName="echo-agent";config.bearerToken="token";config.callbackKeys=Map.of("key","secret");config.allowedOrigins=List.of("https://example.test");WorkerConfig frozen=config.freeze();config.callbackKeys=Map.of();check(frozen.callbackKeys.size()==1,"Configuration frozen");check(frozen.callback("https://example.test/path").getHost().equals("example.test"),"Allowed exact origin");for(String target:List.of("http://example.test/path","https://example.test.evil/path","https://user@example.test/path","https://example.test/path?q=1","https://example.test/path#fragment"))rejects(()->frozen.callback(target));
        for(int i=0;i<100;i++){Cancellation cancellation=new Cancellation();CountDownLatch fired=new CountDownLatch(1);try(AutoCloseable listener=cancellation.onCancel(fired::countDown)){cancellation.cancel();check(fired.await(1,TimeUnit.SECONDS),"Cancellation listener");check(!cancellation.await(1000),"Cancelled retry sleep exits");} }
        try(Worker worker=new Worker(frozen,(ctx,input)->input)){worker.stop().get(1,TimeUnit.SECONDS);check(worker.state().equals("stopped"),"Created worker stop");try{worker.start("127.0.0.1",0);throw new AssertionError("One-shot lifecycle");}catch(IllegalStateException expected){}}
        executionChecks(root,frozen);
        System.out.println("Worker pure conformance checks passed");
    }
    // Exercise the real execution boundary without a socket; private reflection is confined to this check.
    static JsonNode execute(Path root,WorkerConfig config,Worker.Agent agent)throws Exception {
        try(Worker worker=new Worker(config,agent)){ObjectNode invocation=(ObjectNode)Json.parse(Files.readString(root.resolve("contracts/conformance/run-request/valid/minimal.json"))).get("invocation");Class<?> runClass=Class.forName("io.tenvyr.worker.Worker$Run");Constructor<?> constructor=runClass.getDeclaredConstructor(Worker.class,ObjectNode.class,String.class,URI.class,String.class);constructor.setAccessible(true);Object run=constructor.newInstance(worker,invocation,"fingerprint",URI.create("https://example.test/callback"),"key");Method execute=Worker.class.getDeclaredMethod("executeAgent",runClass,Cancellation.class);execute.setAccessible(true);return (JsonNode)execute.invoke(worker,run,new Cancellation());}
    }
    static void executionChecks(Path root,WorkerConfig config)throws Exception {
        JsonNode raw=execute(root,config,(ctx,input)->Json.object("output","raw","__proto__",Json.object("constructor",true)));check(raw.path("output").path("output").asText().equals("raw")&&raw.path("output").has("__proto__"),"Direct output remains raw with special keys");
        check(execute(root,config,(ctx,input)->ctx.success()).path("status").asText().equals("succeeded"),"Explicit no-output success");check(!execute(root,config,(ctx,input)->ctx.success()).has("output"),"No fabricated output");
        check(execute(root,config,(ctx,input)->ctx.success(Json.value(null))).has("output"),"Explicit null output retained");
        for(Worker.Agent invalid:List.<Worker.Agent>of((ctx,input)->Double.NaN,(ctx,input)->9007199254740992L,(ctx,input)->new Object(),(ctx,input)->ctx.success(Json.object(),Json.object("inputTokens",-1),null,null),(ctx,input)->ctx.success(Json.object(),null,null,Json.object("bad",9007199254740992L))))check(execute(root,config,invalid).path("error").path("code").asText().equals("AGENT_OUTPUT_INVALID"),"Unsafe/non-JSON result source rejected");
        Map<String,Object> circular=new HashMap<>();circular.put("self",circular);check(execute(root,config,(ctx,input)->circular).path("error").path("code").asText().equals("AGENT_OUTPUT_INVALID"),"Circular output rejected without losing terminal callback");
        check(execute(root,config,(ctx,input)->ctx.fail("EXPECTED","safe error",false)).path("error").path("code").asText().equals("EXPECTED"),"Structured explicit failure");check(execute(root,config,(ctx,input)->{throw new IllegalStateException("secret-stack-input");}).path("error").path("message").asText().equals("Agent execution failed"),"Unexpected errors sanitized");
        check(execute(root,config,(ctx,input)->ctx.fail("EXPECTED","safe",false,Json.object("bad",Double.NaN))).path("error").path("code").asText().equals("AGENT_OUTPUT_INVALID"),"Unsafe explicit error detail sanitized");
        check(execute(root,config,(ctx,input)->{ctx.event("completed",Json.object());return Json.object();}).path("error").path("code").asText().equals("AGENT_EXECUTION_FAILED"),"System event types reserved");
        WorkerConfig timeout=config.freeze();timeout.timeoutMs=30;java.util.concurrent.atomic.AtomicBoolean cancelled=new java.util.concurrent.atomic.AtomicBoolean();JsonNode timed=execute(root,timeout,(ctx,input)->{ctx.signal.onCancel(()->cancelled.set(true));return new CompletableFuture<>();});check(timed.path("status").asText().equals("timed_out")&&cancelled.get(),"Timeout cooperatively cancels a never-settling handler");
    }
}
