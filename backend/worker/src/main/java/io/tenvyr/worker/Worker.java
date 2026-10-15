package io.tenvyr.worker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.sun.net.httpserver.*;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Function;
import java.util.regex.Pattern;

/** The Java HTTP hosting runtime: FIFO admission, idempotency, cancellation and signed events/results. */
public final class Worker implements AutoCloseable {
    @FunctionalInterface public interface Agent { Object execute(Context context,JsonNode input) throws Exception; }
    public record Success(JsonNode output,boolean hasOutput,JsonNode usage,JsonNode artifacts,JsonNode metadata) {}
    public static final class AgentFailure extends RuntimeException {
        public final ObjectNode failure;
        public AgentFailure(String code,String message,boolean retryable,JsonNode details){super(message);if(code==null||code.isBlank()||message==null||message.isBlank())throw new IllegalArgumentException("Failure code and message are required");failure=Json.object("code",code,"message",message,"retryable",retryable);if(details!=null){try{finite(details);failure.set("details",details.deepCopy());}catch(RuntimeException e){failure.removeAll();failure.put("code","AGENT_OUTPUT_INVALID").put("message","Agent output validation failed").put("retryable",false);}}}
    }
    public final class Context {
        public final ObjectNode invocation;
        public final String runId;
        public final Cancellation signal;
        private final Emitter emitter;
        private Context(Run run,Cancellation signal){this.invocation=run.invocation.deepCopy();this.runId=run.id;this.signal=signal;this.emitter=run.emitter;}
        public Success success(JsonNode output){return new Success(output,true,null,null,null);}
        public Success success(){return new Success(null,false,null,null,null);}
        public Success success(JsonNode output,JsonNode usage,JsonNode artifacts,JsonNode metadata){return new Success(output,true,usage,artifacts,metadata);}
        public Object fail(String code,String message,boolean retryable){throw new AgentFailure(code,message,retryable,null);}
        public Object fail(String code,String message,boolean retryable,JsonNode details){throw new AgentFailure(code,message,retryable,details);}
        public void progress(JsonNode payload){event("progress",payload);}
        public void log(String message){event("log",Json.object("message",message));}
        public void log(JsonNode payload){event("log",payload);}
        public void artifact(JsonNode payload){event("artifact",payload);}
        public void event(String type,JsonNode payload){if(!Set.of("progress","log","artifact").contains(type))throw new IllegalArgumentException("Agent events of type "+type+" are reserved for the Worker runtime");if(!signal.isCancelled())emitter.emit(type,payload);}
    }
    private final WorkerConfig config;
    private final Agent agent;
    private final Function<JsonNode,JsonNode> inputParser,outputParser;
    private final Object lock=new Object();
    private final LinkedHashMap<String,Run> store=new LinkedHashMap<>();
    private final ArrayDeque<Run> queue=new ArrayDeque<>();
    private final Set<Cancellation> executions=new HashSet<>();
    private final Set<CompletableFuture<Void>> callbacks=new HashSet<>();
    private final Cancellation shutdown=new Cancellation();
    private final ExecutorService httpPool=daemonPool("tenvyr-worker-http"),workPool=daemonPool("tenvyr-worker-run"),handlerPool=daemonPool("tenvyr-agent"),callbackPool=daemonPool("tenvyr-worker-callback");
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(r->daemon(r,"tenvyr-worker-timer"));
    private HttpServer server;
    private volatile String state="created";
    private int active;
    private CompletableFuture<Void> stopFuture;
    public Worker(WorkerConfig config,Agent agent){this(config,agent,null,null);}
    public Worker(WorkerConfig config,Agent agent,Function<JsonNode,JsonNode> inputParser,Function<JsonNode,JsonNode> outputParser){this.config=Objects.requireNonNull(config).freeze();this.agent=Objects.requireNonNull(agent);this.inputParser=inputParser;this.outputParser=outputParser;}
    public String state(){return state;}
    public InetSocketAddress start(String host,int port) throws IOException { synchronized(lock) {
        if(state.equals("running"))return server.getAddress();if(!state.equals("created"))throw new IllegalStateException("Tenvyr Worker cannot start from "+state+" state");state="starting";
        try{server=HttpServer.create(new InetSocketAddress(host,port),0);server.createContext("/",this::handle);server.setExecutor(httpPool);server.start();state="running";timer.scheduleAtFixedRate(()->{synchronized(lock){cleanup(System.currentTimeMillis());}},Math.min(config.idempotencyTtlMs,60_000),Math.min(config.idempotencyTtlMs,60_000),TimeUnit.MILLISECONDS);return server.getAddress();}catch(IOException|RuntimeException e){state="failed";if(server!=null)server.stop(0);throw e;}
    }}
    public int port(){if(server==null)throw new IllegalStateException("Not started");return server.getAddress().getPort();}
    private void handle(HttpExchange exchange) throws IOException {
        try {
            String path=exchange.getRequestURI().getPath(),method=exchange.getRequestMethod();
            if(method.equals("GET")&&path.equals("/health/live")){respond(exchange,200,Json.object("status","ok"));return;}
            if(method.equals("GET")&&path.equals("/health/ready")){respond(exchange,state.equals("running")?200:503,Json.object("status",state.equals("running")?"ok":"unavailable"));return;}
            if(!method.equals("POST")||!path.equals("/v1/runs")){throw new RequestError(404,"NOT_FOUND","Route not found");}
            if(!state.equals("running"))throw new RequestError(503,"WORKER_NOT_READY","Worker is not accepting runs");
            String contentType=single(exchange.getRequestHeaders(),"Content-Type");if(contentType==null||!Pattern.compile("^application/json(?:\\s*;|$)",Pattern.CASE_INSENSITIVE).matcher(contentType).find())throw new RequestError(415,"UNSUPPORTED_MEDIA_TYPE","Content-Type must be application/json");
            String auth=single(exchange.getRequestHeaders(),"Authorization");if(auth==null||!auth.matches("(?i)Bearer [^\\s]+")||!MessageDigest.isEqual(auth.substring(7).getBytes(StandardCharsets.UTF_8),config.bearerToken.getBytes(StandardCharsets.UTF_8))){exchange.getResponseHeaders().set("WWW-Authenticate","Bearer");throw new RequestError(401,"UNAUTHORIZED","Bearer authentication failed");}
            // Never read/drain an unauthenticated body; close the exchange after its error response.
            byte[] body;String declared=single(exchange.getRequestHeaders(),"Content-Length");if(declared!=null){try{if(Long.parseLong(declared)>config.maxRequestBytes)throw new RequestError(413,"REQUEST_TOO_LARGE","Request body exceeded the configured limit");}catch(NumberFormatException e){throw new RequestError(400,"INVALID_REQUEST","Invalid Content-Length");}}
            try(InputStream input=exchange.getRequestBody()){body=input.readNBytes(config.maxRequestBytes+1);}if(body.length>config.maxRequestBytes)throw new RequestError(413,"REQUEST_TOO_LARGE","Request body exceeded the configured limit");
            JsonNode parsed;try{parsed=Json.MAPPER.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(body);}catch(Exception e){throw new RequestError(400,"INVALID_JSON","Request body must be valid JSON");}
            ObjectNode request;try{request=Protocol.httpRequest(parsed);}catch(Exception e){throw new RequestError(400,"INVALID_REQUEST","Request does not match HttpAgentRunRequestV1");}
            ObjectNode invocation=(ObjectNode)request.get("invocation");String invocationId=invocation.path("invocationId").asText();
            if(!config.agentName.equals("*")&&!config.agentName.equals(invocation.path("target").path("agent").asText()))throw new RequestError(404,"AGENT_NOT_FOUND","Target agent is not hosted by this Worker");
            String key=single(exchange.getRequestHeaders(),"Idempotency-Key");if(key==null||!key.equals(invocationId))throw new RequestError(400,"INVALID_IDEMPOTENCY_KEY","Idempotency-Key must equal invocationId");
            String keyId=request.path("resultDelivery").path("authentication").path("keyId").asText();if(!config.callbackKeys.containsKey(keyId))throw new RequestError(400,"UNKNOWN_CALLBACK_KEY","Callback key ID is not configured");
            URI callback;try{callback=config.callback(request.path("resultDelivery").path("callbackUrl").asText());}catch(Exception e){throw new RequestError(400,"CALLBACK_TARGET_REJECTED","Callback URL is not allowed");}
            String fingerprint=Json.sha256(key+"\n"+canonical(request));Run run;boolean created=false;
            synchronized(lock){long now=System.currentTimeMillis();cleanup(now);run=store.get(invocationId);if(run!=null){if(!run.fingerprint.equals(fingerprint))throw new RequestError(409,"IDEMPOTENCY_CONFLICT","Invocation ID was already used by another request");}else{
                if(!state.equals("running"))throw new RequestError(503,"WORKER_NOT_READY","Worker is not accepting runs");
                if(active+queue.size()>=config.concurrency+config.maxQueuedRuns)throw new RequestError(429,"QUEUE_FULL","Worker run queue is full");
                if(store.size()>=config.idempotencyMaxEntries)throw new RequestError(429,"IDEMPOTENCY_CAPACITY_FULL","Worker idempotency capacity is full");
                run=new Run(invocation,fingerprint,callback,keyId);store.put(invocationId,run);queue.add(run);created=true;
            }}
            respond(exchange,202,Protocol.httpAccepted(Json.object("schemaVersion","1","invocationId",invocationId,"runId",run.id,"status","accepted","acceptedAt",run.acceptedAt)));
            if(created){run.emitter.safe("accepted",Json.object("acceptedAt",run.acceptedAt));synchronized(lock){drain();}}
        }catch(RequestError e){respond(exchange,e.status,Json.object("error",Json.object("code",e.code,"message",e.getMessage())));}catch(Exception e){respond(exchange,500,Json.object("error",Json.object("code","INTERNAL_ERROR","message","Worker could not process the request")));}finally{exchange.close();}
    }
    private void drain(){while(state.equals("running")&&active<config.concurrency&&!queue.isEmpty()){Run run=queue.removeFirst();active++;run.state="running";workPool.execute(()->{try{execute(run);}finally{synchronized(lock){active--;drain();lock.notifyAll();}}});}}
    private void execute(Run run){Cancellation signal=new Cancellation();synchronized(lock){executions.add(signal);if(shutdown.isCancelled())signal.cancel();}ScheduledFuture<?> heartbeat=config.eventsEnabled?timer.scheduleAtFixedRate(()->run.emitter.safe("heartbeat",Json.object()),config.heartbeatIntervalMs,config.heartbeatIntervalMs,TimeUnit.MILLISECONDS):null;
        ObjectNode result;try{result=executeAgent(run,signal);}finally{if(heartbeat!=null)heartbeat.cancel(false);synchronized(lock){executions.remove(signal);}}
        final ObjectNode terminal=result;track(()->{deliverResult(run,terminal);emitTerminal(run,terminal);});
    }
    private ObjectNode executeAgent(Run run,Cancellation signal){String startedAt=now();JsonNode input;
        try{input=inputParser==null?run.invocation.get("input"):inputParser.apply(run.invocation.get("input"));}catch(Exception e){return failure(run,"failed",startedAt,"AGENT_INPUT_INVALID","Agent input validation failed",false,null);}
        CompletableFuture<Object> outcome=new CompletableFuture<>();if(!signal.isCancelled())handlerPool.execute(()->{try{Object value=agent.execute(new Context(run,signal),input);if(value instanceof CompletionStage<?> stage)stage.whenComplete((v,e)->{if(e!=null)outcome.completeExceptionally(e);else outcome.complete(v);});else outcome.complete(value);}catch(Throwable e){outcome.completeExceptionally(e);}});
        CompletableFuture<Object> race=new CompletableFuture<>();outcome.whenComplete((v,e)->{if(e!=null)race.completeExceptionally(e);else race.complete(v);});ScheduledFuture<?> timeout=timer.schedule(()->{if(race.completeExceptionally(new TimeoutException()))signal.cancel();},config.timeoutMs,TimeUnit.MILLISECONDS);
        try(AutoCloseable registration=signal.onCancel(()->race.completeExceptionally(new CancellationException()))){
            Object value=race.get();Success success=value instanceof Success s?s:null;boolean hasOutput=success==null?value!=null:success.hasOutput;
            try{JsonNode candidate=success==null?jsonValue(value):success.output;ObjectNode result=base(run,"succeeded");result.put("startedAt",startedAt);if(hasOutput){JsonNode output=outputParser==null?candidate:outputParser.apply(candidate);finite(output);result.set("output",output==null?Json.value(null):output);}if(success!=null){if(success.usage!=null)result.set("usage",success.usage);if(success.artifacts!=null)result.set("artifacts",success.artifacts);if(success.metadata!=null)result.set("metadata",success.metadata);}return Protocol.result(result);}catch(Exception e){return failure(run,"failed",startedAt,"AGENT_OUTPUT_INVALID","Agent output validation failed",false,null);}
        }catch(Exception e){Throwable cause=e instanceof ExecutionException?e.getCause():e;if(cause instanceof TimeoutException)return failure(run,"timed_out",startedAt,"AGENT_EXECUTION_TIMEOUT","Agent execution exceeded its configured timeout",true,null);if(cause instanceof CancellationException)return failure(run,"cancelled",startedAt,"WORKER_SHUTDOWN","Worker shutdown cancelled the execution",true,null);if(cause instanceof AgentFailure failure){try{ObjectNode result=base(run,"failed");result.put("startedAt",startedAt);result.set("error",failure.failure);return Protocol.result(result);}catch(Exception invalid){return failure(run,"failed",startedAt,"AGENT_OUTPUT_INVALID","Agent output validation failed",false,null);}}return failure(run,"failed",startedAt,"AGENT_EXECUTION_FAILED","Agent execution failed",false,null);}finally{timeout.cancel(false);}
    }
    private ObjectNode base(Run run,String status){return Json.object("schemaVersion","1","invocationId",run.invocation.get("invocationId"),"executionId",run.invocation.get("executionId"),"stepExecutionId",run.invocation.get("stepExecutionId"),"status",status,"completedAt",now());}
    private ObjectNode failure(Run run,String status,String started,String code,String message,boolean retryable,JsonNode details){ObjectNode result=base(run,status),error=Json.object("code",code,"message",message,"retryable",retryable);if(started!=null)result.put("startedAt",started);if(details!=null)error.set("details",details);result.set("error",error);return Protocol.result(result);}
    private void deliverResult(Run run,ObjectNode result){synchronized(lock){run.state="callback_pending";}CallbackDelivery.Outcome outcome=deliver(run,bytes(result));synchronized(lock){run.state=outcome.delivered()?"delivered":"callback_failed";run.updated=System.currentTimeMillis();}}
    private CallbackDelivery.Outcome deliver(Run run,byte[] bytes){CallbackDelivery.Outcome outcome=CallbackDelivery.deliver(run.callback,run.keyId,config.callbackKeys.get(run.keyId),bytes,config,shutdown);if(!outcome.delivered()&&config.onCallbackDeliveryFailed!=null&&!shutdown.isCancelled()){CompletableFuture<Void> hook=CompletableFuture.runAsync(()->config.onCallbackDeliveryFailed.accept(outcome),handlerPool);try(AutoCloseable registration=shutdown.onCancel(()->hook.cancel(true))){hook.get();}catch(Exception ignored){}}return outcome;}
    private void emitTerminal(Run run,ObjectNode result){String status=result.path("status").asText();ObjectNode payload=Json.object("status",status);if(!status.equals("succeeded")){JsonNode error=result.get("error");if(error!=null)for(String key:List.of("code","message","retryable"))payload.set(key,error.get(key));}run.emitter.safe(status.equals("succeeded")?"completed":"failed",payload);}
    private void track(Runnable action){CompletableFuture<Void> future=new CompletableFuture<>();synchronized(lock){callbacks.add(future);}callbackPool.execute(()->{try{action.run();future.complete(null);}catch(Throwable e){future.completeExceptionally(e);}finally{synchronized(lock){callbacks.remove(future);lock.notifyAll();}}});}
    public CompletableFuture<Void> stop(long graceMs){synchronized(lock){if(stopFuture!=null)return stopFuture;stopFuture=new CompletableFuture<>();if(state.equals("created")||state.equals("failed")||state.equals("stopped")){state="stopped";shutdownExecutors();stopFuture.complete(null);return stopFuture;}state="stopping";List<Run> cancelled=new ArrayList<>(queue);queue.clear();for(Run run:cancelled)track(()->{ObjectNode result=failure(run,"cancelled",null,"WORKER_SHUTDOWN","Worker shutdown cancelled the execution",true,null);deliverResult(run,result);emitTerminal(run,result);});}
        Thread thread=daemon(()->{try{long deadline=System.nanoTime()+Math.max(0,graceMs)*1_000_000L;synchronized(lock){while(active>0||!callbacks.isEmpty()){long left=deadline-System.nanoTime();if(left<=0)break;lock.wait(Math.max(1,left/1_000_000L));}if(active>0||!callbacks.isEmpty()){shutdown.cancel();for(Cancellation execution:new ArrayList<>(executions))execution.cancel();}while(active>0||!callbacks.isEmpty())lock.wait();}if(server!=null)server.stop(0);shutdownExecutors();state="stopped";stopFuture.complete(null);}catch(Throwable e){stopFuture.completeExceptionally(e);}},"tenvyr-worker-shutdown");thread.start();return stopFuture;
    }
    public CompletableFuture<Void> stop(){return stop(config.shutdownGraceMs);}
    @Override public void close(){stop().join();}
    private void shutdownExecutors(){timer.shutdownNow();httpPool.shutdownNow();workPool.shutdown();handlerPool.shutdown();callbackPool.shutdown();}
    private void cleanup(long now){store.values().removeIf(run->(run.state.equals("delivered")||run.state.equals("callback_failed"))&&run.updated+config.idempotencyTtlMs<=now);}
    private final class Run {final ObjectNode invocation;final String fingerprint,id=UUID.randomUUID().toString(),acceptedAt=now(),keyId;final URI callback;final Emitter emitter;String state="queued";long updated=System.currentTimeMillis();Run(ObjectNode invocation,String fingerprint,URI callback,String keyId){this.invocation=invocation.deepCopy();this.fingerprint=fingerprint;this.callback=callback;this.keyId=keyId;emitter=new Emitter(this);}}
    private final class Emitter {final Run run;long sequence;Emitter(Run run){this.run=run;}synchronized void emit(String type,JsonNode payload){if(!config.eventsEnabled)return;Json.requireObject(payload,"Agent event payload");finite(payload);long next=sequence++;String id=run.invocation.path("invocationId").asText()+":"+next;if(next>Integer.MAX_VALUE||id.length()>255)throw new IllegalArgumentException("Generated Agent event identity exceeds bounds");ObjectNode event=Json.object("schemaVersion","1","eventId",id,"invocationId",run.invocation.get("invocationId"),"executionId",run.invocation.get("executionId"),"stepExecutionId",run.invocation.get("stepExecutionId"),"sequence",next,"type",type,"occurredAt",now(),"payload",payload.deepCopy(),"trace",run.invocation.get("trace"),"metadata",Json.object("runId",run.id));Protocol.event(event);if(canonical(event).getBytes(StandardCharsets.UTF_8).length>65_536)throw new IllegalArgumentException("Agent event canonical body exceeds 65536-byte limit");byte[] raw=bytes(event);track(()->deliver(run,raw));}void safe(String type,JsonNode payload){try{emit(type,payload);}catch(RuntimeException ignored){}}}
    public static void finite(JsonNode value){if(value==null)return;if(value.isNumber()){double n=value.doubleValue();if(!Double.isFinite(n)||n==Math.rint(n)&&Math.abs(n)>9_007_199_254_740_991d)throw new IllegalArgumentException("JSON requires finite numbers and safe integers");}else if(value.isContainerNode())value.forEach(Worker::finite);else if(!(value.isNull()||value.isBoolean()||value.isTextual()))throw new IllegalArgumentException("JSON-compatible values required");}
    private static JsonNode jsonValue(Object value){jsonValue(value,Collections.newSetFromMap(new IdentityHashMap<>()));return Json.value(value);}
    private static void jsonValue(Object value,Set<Object> seen){if(value==null||value instanceof String||value instanceof Boolean||value instanceof Number||value instanceof JsonNode)return;if(value instanceof Map<?,?> map){if(!seen.add(value))throw new IllegalArgumentException("Circular JSON output");for(var entry:map.entrySet()){if(!(entry.getKey() instanceof String))throw new IllegalArgumentException("JSON object keys must be strings");jsonValue(entry.getValue(),seen);}seen.remove(value);return;}if(value instanceof List<?> list){if(!seen.add(value))throw new IllegalArgumentException("Circular JSON output");for(Object item:list)jsonValue(item,seen);seen.remove(value);return;}throw new IllegalArgumentException("Output must contain JSON values");}
    /** Worker fingerprint uses UTF-16 lexical keys, as the TypeScript SDK does. */
    public static String canonical(JsonNode value){finite(value);if(value==null||!value.isContainerNode())return Json.stringify(value);if(value.isArray()){StringJoiner out=new StringJoiner(",","[","]");value.forEach(v->out.add(canonical(v)));return out.toString();}List<String> keys=Json.keys(value);Collections.sort(keys);StringJoiner out=new StringJoiner(",","{","}");keys.forEach(key->out.add(Json.quote(key)+":"+canonical(value.get(key))));return out.toString();}
    private static byte[] bytes(JsonNode value){return Json.stringify(value).getBytes(StandardCharsets.UTF_8);}
    private static String now(){return Protocol.jsInstant(Instant.now());}
    private static String single(Headers headers,String key){List<String> values=headers.get(key);return values==null||values.size()!=1?null:values.get(0);}
    private static void respond(HttpExchange exchange,int status,JsonNode body)throws IOException{byte[] bytes=bytes(body);exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");exchange.sendResponseHeaders(status,bytes.length);try(OutputStream output=exchange.getResponseBody()){output.write(bytes);}}
    private static Thread daemon(Runnable action,String name){Thread t=new Thread(action,name);t.setDaemon(true);return t;}
    private static ExecutorService daemonPool(String name){return Executors.newCachedThreadPool(r->daemon(r,name));}
    private static final class RequestError extends RuntimeException{final int status;final String code;RequestError(int status,String code,String message){super(message);this.status=status;this.code=code;}}
}
