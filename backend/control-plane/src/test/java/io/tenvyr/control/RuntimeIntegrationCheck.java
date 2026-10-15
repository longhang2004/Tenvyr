package io.tenvyr.control;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import io.tenvyr.worker.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

/** Real coordinator/approval restart, Git workspace and audited operator-command acceptance. */
public final class RuntimeIntegrationCheck {
    private static int checks,port;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    private static JsonNode api(String path,JsonNode body)throws Exception {return api(path,body,0);}
    private static JsonNode api(String path,JsonNode body,int expectedStatus)throws Exception {
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).timeout(Duration.ofSeconds(8));
        if(body!=null)request.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(Json.stringify(body)));
        var response=HttpClient.newHttpClient().send(request.build(),HttpResponse.BodyHandlers.ofString());
        check(expectedStatus==0?response.statusCode()<300:response.statusCode()==expectedStatus,"operator API "+path+": "+response.body());return Json.parse(response.body());
    }
    private static void git(Path cwd,String... args)throws Exception {List<String> command=new ArrayList<>(List.of("git"));command.addAll(List.of(args));Process process=new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true).start();String output=new String(process.getInputStream().readAllBytes());if(!process.waitFor(10,TimeUnit.SECONDS)||process.exitValue()!=0)throw new AssertionError("Git fixture failed: "+output);}
    private static ObjectNode config(){return Json.object("schemaVersion",1,"planner",Json.object("kind","agent","name","planner"),"verifier",Json.object("kind","agent","name","verifier"),"allowedWorkers",Json.array(Json.object("kind","agent","name","worker")),"allowedExecutors",Json.array("agent:planner","agent:worker","agent:verifier"),"maxIterations",3,"maxWorkersPerIteration",2,"maxTotalWorkers",4,"loopDeadlineMs",60000);}
    private static ObjectNode run(Db db,String id,String expected)throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);ObjectNode row;
        do{row=db.one("SELECT * FROM coordination_runs WHERE id=?",id);if(row!=null&&(row.path("phase").asText().equals(expected)||Set.of("ACCEPTED","FAILED","CANCELLED","LIMIT_REACHED").contains(row.path("phase").asText())))break;Thread.sleep(50);}while(System.nanoTime()<deadline);
        check(row!=null&&row.path("phase").asText().equals(expected),"coordinator reaches "+expected+": "+row);return row;
    }
    public static void main(String[] args)throws Exception {
        try(IntegrationDatabase fixture=new IntegrationDatabase()){
            try(ServerSocket reserve=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){port=reserve.getLocalPort();}
            AtomicReference<String> decision=new AtomicReference<>("ACCEPT");
            WorkerConfig workerConfig=new WorkerConfig();workerConfig.agentName="*";workerConfig.bearerToken="token";workerConfig.callbackKeys=Map.of("key","secret");workerConfig.allowedOrigins=List.of("http://127.0.0.1:"+port);workerConfig.allowInsecureHttp=true;
            try(Worker worker=new Worker(workerConfig,(context,input)->{
                String agent=context.invocation.path("target").path("agent").asText();
                if(agent.equals("planner"))return Json.object("schemaVersion",1,"iterationNumber",input.get("iterationNumber"),"baseRevision",input.get("planRevision"),"reason","bounded test plan","tasks",Json.array(Json.object("taskId","work-"+input.path("iterationNumber").asInt(),"agent","worker","input",Json.object("task","check"),"required",true,"reason","verify execution")));
                if(agent.equals("verifier"))return Json.object("schemaVersion",1,"iterationId",input.path("context").get("iterationId"),"iterationNumber",input.path("context").get("iterationNumber"),"action",decision.get(),"reason","checked durable worker evidence","evidenceRefs",Json.array());
                return Json.object("answer","done");
            })){
                worker.start("127.0.0.1",0);
                Map<String,String> env=new HashMap<>(Map.of("ORCHESTRATOR_PORT",Integer.toString(port),"HTTP_AGENT_ALLOW_INSECURE","true","HTTP_AGENT_CALLBACK_BASE_URL","http://127.0.0.1:"+port,"TOKEN","token","SECRET","secret","GATEWAY_URL","http://127.0.0.1:1"));
                ObjectNode transports=Json.object();for(String agent:List.of("planner","worker","verifier"))transports.set(agent,Json.object("kind","http","submitUrl","http://127.0.0.1:"+worker.port()+"/v1/runs","outboundAuthentication",Json.object("type","bearer","tokenEnv","TOKEN"),"callbackAuthentication",Json.object("keyId","key","secretEnv","SECRET"),"requestTimeoutMs",3000,"maxResponseBytes",65536));env.put("AGENT_TRANSPORT_CONFIG",Json.stringify(transports));
                Main control=new Main(fixture.db,env);
                try{
                    control.start();
                    var command=Json.object("idempotencyKey","coordinator-one","name","team","goal","exercise the real coordinator","config",config());
                    JsonNode receipt=api("/workbench/commands/start-team-run",command);String id=receipt.path("result").path("runId").asText();
                    check(!id.isEmpty(),"coordinator command returns durable run identity: "+receipt);run(fixture.db,id,"ACCEPTED");
                    check(api("/workbench/commands/start-team-run",command).path("outcome").asText().equals("duplicate"),"operator command replay is idempotent");
                    check(fixture.db.one("SELECT count(*) n FROM step_attempts a JOIN coordination_runs r ON r.\"executionId\"=a.\"executionId\" WHERE r.id=?",id).path("n").asInt()==3,"planner/worker/verifier each execute once");
                    decision.set("WAIT_FOR_HUMAN");command.put("idempotencyKey","coordinator-wait");receipt=api("/workbench/commands/start-team-run",command);String waiting=receipt.path("result").path("runId").asText();run(fixture.db,waiting,"WAITING_FOR_HUMAN");
                    control.close();control=new Main(fixture.db,env);control.start();Thread.sleep(1100);
                    check(fixture.db.one("SELECT phase FROM coordination_runs WHERE id=?",waiting).path("phase").asText().equals("WAITING_FOR_HUMAN"),"restart cannot bypass a human wait");
                    api("/workbench/commands/waits/"+waiting,Json.object("idempotencyKey","deny-wait","approve",false));run(fixture.db,waiting,"FAILED");
                    Path workspace=Files.createTempDirectory("tenvyr-runtime-workspace-").toRealPath();
                    try{
                        git(workspace,"init","--initial-branch=main");Files.writeString(workspace.resolve("README.md"),"fixture\n");git(workspace,"add","README.md");git(workspace,"-c","user.name=Tenvyr test","-c","user.email=test@example.invalid","commit","-m","fixture");
                        JsonNode created=api("/workbench/commands/create-workspace",Json.object("idempotencyKey","workspace-create","name","fixture","path",workspace.toString()));check(created.path("outcome").asText().equals("executed"),"workspace creation persists advisory-lock transaction");
                        decision.set("ACCEPT");command.put("idempotencyKey","isolated-team");command.put("executionIsolation","git-worktree");command.set("workspace",Json.object("workspaceId",created.path("result").get("workspaceId")));
                        JsonNode isolated=api("/workbench/commands/start-team-run",command);String isolatedRun=isolated.path("result").path("runId").asText(),sourceExecution=isolated.path("result").path("executionId").asText();run(fixture.db,isolatedRun,"ACCEPTED");
                        ObjectNode sourceLease=fixture.db.one("SELECT * FROM workspace_executions WHERE \"ownerRunId\"=?",isolatedRun);Path worktree=Path.of(sourceLease.path("executionPath").asText());
                        check(!worktree.equals(workspace)&&Files.exists(worktree.resolve("README.md"))&&sourceLease.path("state").asText().equals("PRESERVED"),"terminal run preserves a real isolated Git worktree");
                        Files.writeString(worktree.resolve("preserved-work.txt"),"must survive continuation\n");
                        JsonNode continued=api("/workbench/commands/executions/"+sourceExecution+"/continue",Json.object("idempotencyKey","continue-isolated","config",config()));String nextRun=continued.path("result").path("runId").asText();run(fixture.db,nextRun,"ACCEPTED");
                        ObjectNode destination=fixture.db.one("SELECT * FROM workspace_executions WHERE \"ownerRunId\"=?",nextRun);
                        check(!destination.get("id").equals(sourceLease.get("id"))&&destination.get("executionPath").equals(sourceLease.get("executionPath")),"handoff transfers the path under a new authoritative lease");
                        check(fixture.db.one("SELECT state FROM workspace_executions WHERE id=?",sourceLease.get("id")).path("state").asText().equals("TRANSFERRED")&&Files.readString(worktree.resolve("preserved-work.txt")).contains("must survive"),"handoff never drops preserved user work");
                        api("/workbench/commands/executions/"+sourceExecution+"/continue",Json.object("idempotencyKey","continue-race","config",config()),400);
                        check(fixture.db.one("SELECT count(*) n FROM coordination_runs WHERE workspace->>'path'=?",workspace.toString()).path("n").asInt()==2,"second continuation cannot acquire the transferred lease");
                        String release="/workbench/commands/workspaces/"+destination.path("id").asText()+"/release";
                        api(release,Json.object("idempotencyKey","release-dirty"),400);
                        check(Files.exists(worktree.resolve("preserved-work.txt")),"dirty-worktree release refuses without data loss");
                        Files.delete(worktree.resolve("preserved-work.txt"));api(release,Json.object("idempotencyKey","release-clean"));
                        check(!Files.exists(worktree)&&fixture.db.one("SELECT state FROM workspace_executions WHERE id=?",destination.get("id")).path("state").asText().equals("REMOVED"),"explicit clean release removes Git worktree and persists receipt");
                    } finally {
                        for(ObjectNode lease:fixture.db.query("SELECT DISTINCT \"executionPath\" FROM workspace_executions WHERE \"sourcePath\"=?",workspace.toString())){Path owned=Path.of(lease.path("executionPath").asText());if(!owned.equals(workspace)&&Files.exists(owned))git(workspace,"worktree","remove","--force",owned.toString());}
                        try(var paths=Files.walk(workspace)){for(Path path:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(path);}
                    }
                }finally{control.close();}
            }
        }
        System.out.println("RuntimeIntegrationCheck: "+checks+" real coordinator/operator/restart checks passed");
    }
}
