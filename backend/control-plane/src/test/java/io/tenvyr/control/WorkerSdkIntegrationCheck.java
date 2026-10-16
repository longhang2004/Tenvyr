package io.tenvyr.control;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/** Runs the public Node/Python/Java/C++ SDKs as separate processes against the real Java API and PostgreSQL. */
public final class WorkerSdkIntegrationCheck {
    private static int checks;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    private static JsonNode api(int port,String path,JsonNode body)throws Exception {
        var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).timeout(Duration.ofSeconds(5));
        if(body!=null)builder.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(Json.stringify(body)));
        var response=HttpClient.newHttpClient().send(builder.build(),HttpResponse.BodyHandlers.ofString());JsonNode value=Json.parse(response.body());
        check(response.statusCode()<300&&value.path("success").asBoolean(),"SDK API "+path+": "+value);return value.path("data");
    }
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args.length>0?args[0]:".").toAbsolutePath();
        String javaExecutable=Path.of(System.getProperty("java.home"),"bin","java").toString();
        Map<String,List<String>> commands=new LinkedHashMap<>();
        commands.put("node",List.of("node","scripts/fixtures/backend-node-worker.mjs"));
        commands.put("python",List.of(System.getenv().getOrDefault("TENVYR_PYTHON_EXECUTABLE","python3.11"),"sdks/python-worker/tests/fixtures/orchestrator_loopback_worker.py"));
        commands.put("java",List.of(javaExecutable,"-cp","sdks/java-worker/target/test-classes:sdks/java-worker/target/classes:sdks/java-worker/target/dependency/*","com.tenvyr.worker.OrchestratorLoopbackWorker"));
        commands.put("cpp",List.of(root.resolve("sdks/cpp-worker/build/orchestrator_loopback_worker").toString()));
        for(var command:commands.entrySet()){
            try(IntegrationDatabase fixture=new IntegrationDatabase()){
                int port;try(ServerSocket socket=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){port=socket.getLocalPort();}
                Map<String,String> env=new HashMap<>(System.getenv());env.putAll(Map.of("TENVYR_WORKER_TOKEN","sdk-token","TENVYR_CALLBACK_KEY_ID","sdk-key","TENVYR_CALLBACK_SECRET","sdk-secret","TENVYR_CALLBACK_ORIGIN","http://127.0.0.1:"+port,"TENVYR_ALLOW_INSECURE_HTTP","true","TENVYR_WORKER_HOST","127.0.0.1","TENVYR_WORKER_PORT","0","PYTHONPATH",root.resolve("sdks/python-worker/src").toString()));
                Path errors=Files.createTempFile("tenvyr-sdk-"+command.getKey(),".log");
                ProcessBuilder builder=new ProcessBuilder(command.getValue()).directory(root.toFile()).redirectError(errors.toFile());builder.environment().putAll(env);Process worker=builder.start();
                ExecutorService reader=java.util.concurrent.Executors.newSingleThreadExecutor();
                try {
                    Future<ObjectNode> ready=reader.submit(()->{BufferedReader lines=new BufferedReader(new InputStreamReader(worker.getInputStream()));String line;while((line=lines.readLine())!=null){try{JsonNode value=Json.parse(line);if(value.path("event").asText().equals("tenvyr.worker.ready"))return (ObjectNode)value;}catch(IllegalArgumentException ignored){}}throw new IOException("Worker exited before ready");});
                    ObjectNode address;try{address=ready.get(20,TimeUnit.SECONDS);}catch(Exception failure){throw new AssertionError(command.getKey()+" SDK startup: "+Files.readString(errors),failure);}
                    Map<String,String> controlEnv=new HashMap<>(Map.of("ORCHESTRATOR_PORT",Integer.toString(port),"HTTP_AGENT_ALLOW_INSECURE","true","HTTP_AGENT_CALLBACK_BASE_URL","http://127.0.0.1:"+port,"SDK_TOKEN","sdk-token","SDK_SECRET","sdk-secret","GATEWAY_URL","http://127.0.0.1:1"));
                    controlEnv.put("AGENT_TRANSPORT_CONFIG",Json.stringify(Json.object("remote-echo-agent",Json.object("kind","http","submitUrl","http://127.0.0.1:"+address.path("port").asInt()+"/v1/runs","outboundAuthentication",Json.object("type","bearer","tokenEnv","SDK_TOKEN"),"callbackAuthentication",Json.object("keyId","sdk-key","secretEnv","SDK_SECRET"),"requestTimeoutMs",3000,"maxResponseBytes",65536))));
                    try(Main control=new Main(fixture.db,controlEnv)){
                        control.start();
                        for(String mode:List.of("echo","safe-boundaries","unsafe-output")){
                            JsonNode pipeline=api(port,"/pipelines",Json.object("name","sdk-"+command.getKey()+"-"+mode,"steps",Json.array(Json.object("id","echo","agent","remote-echo-agent","input",Json.object("mode",mode,"message","hello 世界")))));
                            JsonNode execution=api(port,"/executions",Json.object("pipelineId",pipeline.get("id")));String id=execution.path("id").asText();long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(12);
                            do{execution=api(port,"/executions/"+id,null);if(Set.of("COMPLETED","FAILED").contains(execution.path("status").asText()))break;Thread.sleep(30);}while(System.nanoTime()<deadline);
                            check(execution.path("status").asText().equals(mode.equals("unsafe-output")?"FAILED":"COMPLETED"),command.getKey()+" "+mode+" terminal behavior: "+execution);
                            if(mode.equals("echo"))check(execution.path("steps").path(0).path("output").path("echo").asText().equals("hello 世界"),command.getKey()+" Unicode echo");
                            if(mode.equals("safe-boundaries"))check(execution.path("steps").path(0).path("output").path("maximum").asLong()==9007199254740991L,command.getKey()+" safe integer boundary");
                            check(fixture.db.one("SELECT count(*) n FROM result_inbox i JOIN step_attempts a ON a.\"invocationId\"=i.\"invocationId\" WHERE a.\"executionId\"=?",id).path("n").asInt()==1,command.getKey()+" one signed terminal owner");
                        }
                    }
                } finally {
                    worker.destroy();if(!worker.waitFor(10,TimeUnit.SECONDS)){worker.destroyForcibly();worker.waitFor();throw new AssertionError(command.getKey()+" SDK graceful shutdown timed out");}
                    reader.shutdownNow();Files.deleteIfExists(errors);
                }
            }
            System.out.println("Worker SDK loopback PASS: "+command.getKey());
        }
        System.out.println("WorkerSdkIntegrationCheck: "+checks+" real public-SDK/PostgreSQL checks passed");
    }
}
