package io.tenvyr.control;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import io.tenvyr.executorhost.HostConfig;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Real immutable connection/lease authority -> HTTP host -> Go -> native CLI -> signed callbacks/coordinator. */
public final class NativeRuntimeIntegrationCheck {
    private static int checks,port;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    private static JsonNode api(String path,JsonNode body)throws Exception {
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).timeout(Duration.ofSeconds(10));
        if(body!=null)request.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(Json.stringify(body)));
        var response=HttpClient.newHttpClient().send(request.build(),HttpResponse.BodyHandlers.ofString());check(response.statusCode()<300,"native API "+path+": "+response.body());return Json.parse(response.body());
    }
    public static void main(String[] args)throws Exception {
        check(System.getenv("UNCONFIGURED_PARENT_SECRET")!=null,"parent environment contains the isolation sentinel");
        Path repo=Path.of(args.length>0?args[0]:".").toAbsolutePath(),root=Files.createTempDirectory("tenvyr-native-authority-").toRealPath(),workspace=Files.createDirectory(root.resolve("source"));
        try(IntegrationDatabase fixture=new IntegrationDatabase()){
            int assignedHostPort;
            try(ServerSocket socket=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"));ServerSocket hostSocket=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){port=socket.getLocalPort();assignedHostPort=hostSocket.getLocalPort();}
            Map<String,String> hostEnv=Map.of("EXECUTOR_HOST_ALLOWED_ROOT",root.toString(),"EXECUTOR_HOST_STATE_DIR",root.resolve("state").toString(),"EXECUTOR_HOST_BEARER_TOKEN","native-token","HTTP_AGENT_CALLBACK_SECRET","native-secret","EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS","http://127.0.0.1:"+port,"EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE","true","EXECUTOR_HOST_PORT",Integer.toString(assignedHostPort),"EXECUTOR_HOST_LAUNCHER",repo.resolve("backend/executor-host/native/tenvyr-process-launcher").toString());
            try(io.tenvyr.executorhost.Main host=new io.tenvyr.executorhost.Main(HostConfig.parse(hostEnv),io.tenvyr.executorhost.Main.database(fixture.db))){
                int hostPort=host.start().get(0).address().getPort();
                Map<String,String> env=Map.of("ORCHESTRATOR_PORT",Integer.toString(port),"HTTP_AGENT_ALLOW_INSECURE","true","HTTP_AGENT_CALLBACK_BASE_URL","http://127.0.0.1:"+port,"EXECUTOR_HOST_BEARER_TOKEN","native-token","HTTP_AGENT_CALLBACK_SECRET","native-secret","LOCAL_EXECUTOR_HOST_URL","http://127.0.0.1:"+hostPort+"/v1/runs","GATEWAY_URL","http://127.0.0.1:1");
                try(Main control=new Main(fixture.db,env)){
                    control.start();String classpath=repo.resolve("backend/platform/target/classes")+java.io.File.pathSeparator+repo.resolve("backend/platform/target/dependency/*")+java.io.File.pathSeparator+repo.resolve("backend/executor-host/target/test-classes");
                    var arguments=Json.array("-cp",classpath,"io.tenvyr.executorhost.FakeProcess","team","literal;$(touch unauthorized)");
                    var probeArguments=Json.array("-cp",classpath,"io.tenvyr.executorhost.FakeProcess","probe");
                    for(String role:List.of("planner","worker","verifier")){
                        ObjectNode profile=Json.object("name",role,"runtimeKind","generic-cli","executorId","native:"+role,"version","fixture-1","credentialRefs",Json.array(),"declaredCapabilities",Json.object("invocation",Json.object("supported",true,"source","configured"),"structuredResult",Json.object("supported",true,"source","configured")),"cli",Json.object("command",Path.of(System.getProperty("java.home"),"bin","java").toString(),"args",arguments,"cwd",root.toString(),"envAllowlist",Json.object(),"probe",Json.object("args",probeArguments,"expectsVersion",true,"wallTimeMs",5000,"maxOutputBytes",4096)));
                        JsonNode created=api("/connections",Json.object("idempotencyKey","create-"+role,"connectionId","conn:"+role,"profile",profile));check(created.path("success").asBoolean(),"native immutable profile created");
                        JsonNode tested=api("/connections/conn:"+role+"/test",Json.object("idempotencyKey","probe-"+role));check(tested.path("data").path("result").path("receipt").path("state").asText().equals("AVAILABLE"),"actual fixed-argv connection probe: "+tested);
                    }
                    JsonNode created=api("/workbench/commands/create-workspace",Json.object("idempotencyKey","native-workspace","name","native source","path",workspace.toString()));
                    ObjectNode config=Json.object("schemaVersion",1,"planner",Json.object("kind","connection","name","conn:planner","agent","conn__planner"),"verifier",Json.object("kind","connection","name","conn:verifier","agent","conn__verifier"),"allowedWorkers",Json.array(Json.object("kind","connection","name","conn:worker","agent","conn__worker")),"allowedExecutors",Json.array("native:planner","native:worker","native:verifier"),"maxIterations",1,"maxWorkersPerIteration",1,"maxTotalWorkers",1,"loopDeadlineMs",60000);
                    JsonNode receipt=api("/workbench/commands/start-team-run",Json.object("idempotencyKey","native-team","name","native team","goal","execute via authoritative native profiles","config",config,"workspace",Json.object("workspaceId",created.path("result").get("workspaceId"))));String runId=receipt.path("result").path("runId").asText();check(!runId.isEmpty(),"native coordinated run admitted");
                    long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(25);ObjectNode run;
                    do{run=fixture.db.one("SELECT * FROM coordination_runs WHERE id=?",runId);if(run!=null&&Set.of("ACCEPTED","FAILED","LIMIT_REACHED").contains(run.path("phase").asText()))break;Thread.sleep(50);}while(System.nanoTime()<deadline);
                    if(run!=null&&run.path("phase").asText().equals("FAILED"))for(ObjectNode failed:fixture.db.query("SELECT \"executorSnapshot\" FROM step_attempts WHERE \"executionId\"=?",run.get("executionId"))){JsonNode ref=failed.path("executorSnapshot").path("connection");ObjectNode stored=fixture.db.one("SELECT profile,capabilities,\"configHash\" FROM connection_revisions WHERE \"connectionId\"=? AND \"revisionNumber\"=?",ref.get("connectionId"),ref.get("revisionNumber"));System.err.println(Json.object("reference",ref,"storedHash",stored.get("configHash"),"computedHash",Json.hash(stored.get("profile")),"storedKind",stored.path("profile").get("runtimeKind"),"storedVersion",stored.path("profile").get("version"),"storedCapabilities",stored.get("capabilities")));}
                    check(run!=null&&run.path("phase").asText().equals("ACCEPTED"),"real native planner/worker/verifier complete: "+run+" attempts="+(run==null?"none":fixture.db.query("SELECT status,error,result FROM step_attempts WHERE \"executionId\"=?",run.get("executionId"))));
                    do{if(fixture.db.one("SELECT status FROM executions WHERE id=?",run.get("executionId")).path("status").asText().equals("COMPLETED"))break;Thread.sleep(50);}while(System.nanoTime()<deadline);
                    host.close(); // Drain final Worker events before comparing two point-in-time reads.
                    ControlIntegrationCheck.assertOriginalReadModels(fixture,run.path("executionId").asText(),repo);
                    var attempt=fixture.db.one("SELECT a.* FROM step_attempts a JOIN step_executions s ON s.id=a.\"logicalStepId\" WHERE a.\"executionId\"=? AND s.\"stepId\"='native-work'",run.get("executionId"));
                    check(attempt.path("result").path("cwd").asText().equals(workspace.toString()),"authoritative lease cwd overrides the configured profile cwd");
                    check(attempt.path("result").path("literal").asText().equals("literal;$(touch unauthorized)")&&!Files.exists(workspace.resolve("unauthorized")),"fixed native argv never enters a shell");
                    check(!attempt.path("result").path("inheritedSecret").asBoolean(),"unconfigured parent environment is absent");
                    check(attempt.path("executorSnapshot").path("connection").path("revisionNumber").asInt()==1,"attempt pins immutable database revision");
                    check(fixture.db.one("SELECT count(*) n FROM result_inbox").path("n").asInt()==3,"one signed terminal result for each native role");
                    check(fixture.db.one("SELECT state FROM workspace_executions WHERE \"ownerRunId\"=?",runId).path("state").asText().equals("PRESERVED"),"native workspace preserved after terminal decision");
                }
            }
        }finally{try(var paths=Files.walk(root)){for(Path path:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(path);}}
        System.out.println("NativeRuntimeIntegrationCheck: "+checks+" real database-authority/native-coordinator checks passed");
    }
}
