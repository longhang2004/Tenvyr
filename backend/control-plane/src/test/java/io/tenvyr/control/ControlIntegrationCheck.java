package io.tenvyr.control;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.*;
import io.tenvyr.worker.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import io.tenvyr.control.authority.AuthorityServices;
import io.tenvyr.control.runtime.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Real control composition, signed HTTP Worker and durable restart recovery. */
public final class ControlIntegrationCheck {
    private static final HttpClient CLIENT=HttpClient.newHttpClient();
    private static int checks,port;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    private static JsonNode request(String path,JsonNode body)throws Exception {
        var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).timeout(Duration.ofSeconds(5));
        if(body!=null)builder.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(Json.stringify(body)));
        var response=CLIENT.send(builder.build(),HttpResponse.BodyHandlers.ofString());
        check(response.statusCode()>=200&&response.statusCode()<300,"API status "+path+": "+response.statusCode());
        JsonNode result=Json.parse(response.body());if(path.endsWith("/capsule")){check(result.path("capsule").hasNonNull("contentHash"),"workbench capsule response");return result;}
        check(result.path("success").asBoolean(),"API success "+path+": "+result);return result.path("data");
    }
    private static JsonNode completed(String id)throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);JsonNode result;
        do{result=request("/executions/"+id,null);if(Set.of("COMPLETED","FAILED","CANCELLED").contains(result.path("status").asText()))return result;Thread.sleep(50);}while(System.nanoTime()<until);
        throw new AssertionError("Execution did not terminate: "+result);
    }
    static void assertOriginalReadModels(IntegrationDatabase fixture,String id,Path root)throws Exception {
        var authority=new AuthorityServices(fixture.db);
        var workbench=new WorkbenchProjectionService(fixture.db,new RuntimeConnectionService(fixture.db),authority.capsules,authority.delegation);
        Path proof=Files.createTempFile("tenvyr-read-model-oracle-",".json");
        try{
            Files.writeString(proof,Json.stringify(Json.object("capsule",authority.capsules.build(id),"capsuleSummary",workbench.capsuleFor(id),"connections",workbench.connectionCards(),"executions",workbench.executionSummaries(1),"projection",workbench.executionProjection(id),"attention",new AttentionService(fixture.db).attention())));
            ProcessBuilder oracle=new ProcessBuilder("node","scripts/backend-capsule-oracle.mjs").directory(root.toFile()).inheritIO();
            oracle.environment().putAll(Map.of("TZ","UTC","TENVYR_TEST_SCHEMA",fixture.schema(),"TENVYR_EXECUTION_ID",id,"TENVYR_JAVA_CAPSULE_PATH",proof.toString()));
            Process process=oracle.start();if(!process.waitFor(20,TimeUnit.SECONDS)){process.destroyForcibly();throw new AssertionError("Original read-model comparison timed out");}
            check(process.exitValue()==0,"capsule/hash and read-model parity against original production services");
        }finally{Files.deleteIfExists(proof);}
    }
    public static void main(String[] args)throws Exception {
        try(IntegrationDatabase fixture=new IntegrationDatabase()){
            try(ServerSocket reserve=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){port=reserve.getLocalPort();}
            WorkerConfig config=new WorkerConfig();config.agentName="echo-agent";config.bearerToken="test-token";config.callbackKeys=Map.of("test-key","test-secret");config.allowedOrigins=List.of("http://127.0.0.1:"+port);config.allowInsecureHttp=true;config.callbackInitialDelayMs=25;config.callbackMaxDelayMs=100;config.callbackRequestTimeoutMs=1000;config.eventsEnabled=true;
            AtomicInteger calls=new AtomicInteger();CompletableFuture<JsonNode> released=new CompletableFuture<>();CountDownLatch executing=new CountDownLatch(1);
            try(Worker worker=new Worker(config,(ctx,input)->{calls.incrementAndGet();if(input.path("hold").asBoolean()){executing.countDown();return released;}return input;})){
                worker.start("127.0.0.1",0);
                Map<String,String> env=new HashMap<>(Map.of("ORCHESTRATOR_PORT",Integer.toString(port),"HTTP_AGENT_ALLOW_INSECURE","true","HTTP_AGENT_CALLBACK_BASE_URL","http://127.0.0.1:"+port,"TEST_TOKEN","test-token","TEST_SECRET","test-secret","GATEWAY_URL","http://127.0.0.1:1"));
                env.put("AGENT_TRANSPORT_CONFIG",Json.stringify(Json.object("echo-agent",Json.object("kind","http","submitUrl","http://127.0.0.1:"+worker.port()+"/v1/runs","outboundAuthentication",Json.object("type","bearer","tokenEnv","TEST_TOKEN"),"callbackAuthentication",Json.object("keyId","test-key","secretEnv","TEST_SECRET"),"requestTimeoutMs",2000,"maxResponseBytes",65536))));
                Main control=new Main(fixture.db,env);
                try {
                    check(control.start()==port,"real composition starts");
                    check(fixture.db.query("SELECT * FROM migrations").size()==27,"exact migration inventory");
                    check(Migrator.migrate(fixture.db).isEmpty(),"existing migration ledger untouched");
                    check(request("/health",null).path("ready").asBoolean(),"complete migrated schema is ready");
                    var instant=java.time.Instant.parse("2026-10-15T01:02:03.123Z");
                    var timestamps=fixture.db.one("SELECT ?::timestamp AS plain,?::timestamptz AS zoned",instant,instant);
                    check(timestamps.path("plain").asText().equals(Protocol.jsInstant(instant))&&timestamps.path("zoned").asText().equals(Protocol.jsInstant(instant)),"JDBC timestamps preserve UTC milliseconds independently of host timezone");
                    for(String table:Entities.tables())check(fixture.db.one("SELECT to_regclass(?) AS name",table).hasNonNull("name"),"entity table exists: "+table);
                    var pipeline=request("/pipelines",Json.object("name","live-http","steps",Json.array(Json.object("id","echo","agent","echo-agent","input",Json.object("hello","world","__proto__",Json.object("safe",true))))));
                    var execution=request("/executions",Json.object("pipelineId",pipeline.get("id")));
                    String id=execution.path("id").asText();JsonNode terminal=completed(id);
                    check(terminal.path("status").asText().equals("COMPLETED"),"signed Worker callback completes execution");
                    check(terminal.path("steps").path(0).path("output").path("__proto__").path("safe").asBoolean(),"special JSON key survives HTTP and PostgreSQL");
                    check(fixture.db.one("SELECT count(*) n FROM agent_events WHERE \"executionId\"=?",id).path("n").asInt()>0,"real Worker events persisted");
                    var capsule=request("/workbench/executions/"+id+"/capsule",null);check(!capsule.isNull(),"workbench capsule reconstruction");
                    var held=request("/pipelines",Json.object("name","restart-http","steps",Json.array(Json.object("id","hold","agent","echo-agent","input",Json.object("hold",true)))));
                    var pending=request("/executions",Json.object("pipelineId",held.get("id")));String recovering=pending.path("id").asText();
                    check(executing.await(5,TimeUnit.SECONDS),"worker running before restart");
                    var attempt=fixture.db.one("SELECT id,\"invocationId\" FROM step_attempts WHERE \"executionId\"=?",recovering);
                    control.close();control=new Main(fixture.db,env);control.start();released.complete(Json.object("afterRestart",true));
                    check(completed(recovering).path("status").asText().equals("COMPLETED"),"callback applies after real control-plane restart");
                    check(fixture.db.one("SELECT count(*) n FROM step_attempts WHERE \"executionId\"=?",recovering).path("n").asInt()==1,"restart preserves one attempt");
                    check(fixture.db.one("SELECT count(*) n FROM result_inbox WHERE \"invocationId\"=?",attempt.get("invocationId")).path("n").asInt()==1,"one terminal inbox owner after restart");
                    check(calls.get()==2,"restart does not reexecute accepted work");
                    worker.stop().join(); // Drain final events before comparing point-in-time captures.
                    assertOriginalReadModels(fixture,id,Path.of(args.length>0?args[0]:"."));
                    Main closingControl=control;
                    var closer=java.util.concurrent.Executors.newSingleThreadExecutor();
                    java.util.concurrent.atomic.AtomicReference<Future<?>> closed=new java.util.concurrent.atomic.AtomicReference<>();
                    long attemptsTable=fixture.db.one("SELECT 'step_attempts'::regclass::oid AS id").path("id").asLong();
                    try{
                        fixture.db.transaction(tx->{
                            tx.execute("LOCK TABLE step_attempts IN ACCESS EXCLUSIVE MODE");
                            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
                            while(!fixture.db.exists("SELECT 1 FROM pg_locks WHERE relation=?::oid AND mode='AccessShareLock' AND NOT granted",attemptsTable)&&System.nanoTime()<deadline)Thread.sleep(25);
                            check(fixture.db.exists("SELECT 1 FROM pg_locks WHERE relation=?::oid AND mode='AccessShareLock' AND NOT granted",attemptsTable),"real recovery query is blocked before shutdown");
                            CountDownLatch started=new CountDownLatch(1);
                            closed.set(closer.submit(()->{started.countDown();closingControl.close();return null;}));
                            check(started.await(2,TimeUnit.SECONDS),"shutdown task started");
                            Thread.sleep(1500);
                            check(!closed.get().isDone(),"shutdown waits for the active database recovery transaction");
                            return null;
                        });
                        closed.get().get(10,TimeUnit.SECONDS);
                        check(true,"shutdown drains recovery before schema teardown");
                    }finally{closer.shutdownNow();}

                } finally {released.complete(Json.object());control.close();}
            }
        }
        System.out.println("ControlIntegrationCheck: "+checks+" real PostgreSQL/HTTP/restart checks passed");
    }
}
