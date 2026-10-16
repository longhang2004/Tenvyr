package io.tenvyr.executorhost;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import io.tenvyr.worker.*;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;

/** Local execution composition root. Database revisions are the dynamic bridge's only authority. */
public final class Main implements AutoCloseable {
    public record Started(String agent,InetSocketAddress address,Worker worker){}
    public interface Authority {
        ObjectNode revision(String connectionId,int revisionNumber);
        ObjectNode workspace(String workspaceId);
        ObjectNode executionWorkspace(String workspaceExecutionId,String executionId);
    }
    public static Authority database(Db db){return new Authority(){
        public ObjectNode revision(String id,int revision){return db.one("SELECT profile,\"configHash\",capabilities FROM connection_revisions WHERE \"connectionId\"=? AND \"revisionNumber\"=?",id,revision);}
        public ObjectNode workspace(String id){return db.one("SELECT path,snapshot FROM workspaces WHERE id=?",id);}
        public ObjectNode executionWorkspace(String id,String execution){return db.one("SELECT w.* FROM workspace_executions w JOIN coordination_runs r ON r.id=w.\"ownerRunId\" WHERE w.id=? AND r.\"executionId\"=?",id,execution);}
    };}
    private final HostConfig config;private final Authority authority;private final List<Started> started=new ArrayList<>();
    public Main(HostConfig config,Authority authority){this.config=config;this.authority=authority;}
    public List<Started> start()throws IOException,InterruptedException {
        RunState.sweep(config.stateDir(),config.launcher());
        try{if(config.agents().isEmpty())startWorker(null);else for(HostConfig.Profile profile:config.agents())startWorker(profile);return List.copyOf(started);}catch(IOException|RuntimeException e){close();throw e;}
    }
    private void startWorker(HostConfig.Profile profile)throws IOException {
        WorkerConfig workerConfig=new WorkerConfig();workerConfig.agentName=profile==null?"*":profile.agent();workerConfig.bearerToken=config.environment().get(profile==null?config.bearerTokenEnv():profile.bearerTokenEnv());workerConfig.callbackKeys=config.callbackKeys();workerConfig.allowedOrigins=config.callbackOrigins();workerConfig.allowInsecureHttp=config.insecure();workerConfig.timeoutMs=profile==null?310000:profile.wallTimeMs()+10000;workerConfig.concurrency=profile==null?4:1;workerConfig.maxQueuedRuns=profile==null?16:4;workerConfig.eventsEnabled=true;workerConfig.heartbeatIntervalMs=profile==null?15000:Math.min(60000,Math.max(1000,profile.wallTimeMs()/3));
        Worker worker=new Worker(workerConfig,(context,input)->execute(context,profile));int port=profile==null?config.port():profile.port();InetSocketAddress address=worker.start("127.0.0.1",port);started.add(new Started(workerConfig.agentName,address,worker));System.out.println("Local executor host listening agent="+workerConfig.agentName+" port="+address.getPort());
    }
    Object execute(Worker.Context context,HostConfig.Profile fixed)throws Exception {
        ObjectNode invocation=context.invocation;HostConfig.Profile profile=fixed;
        if(profile==null){JsonNode reference=invocation.get("connection");if(reference==null)return context.fail("EXECUTOR_HOST_CONNECTION_REQUIRED","Dynamic local executor bridge requires an immutable connection reference",false);
            ObjectNode revision;try{revision=authority.revision(reference.path("connectionId").asText(),reference.path("revisionNumber").asInt());}catch(RuntimeException e){return context.fail("EXECUTOR_HOST_DATABASE_ERROR","Failed to query immutable connection revision",true);}
            if(revision==null)return context.fail("EXECUTOR_HOST_CONNECTION_NOT_FOUND","Immutable connection revision not found",false);
            String hash=Json.text(revision,"configHash");JsonNode snapshot=revision.get("profile");ObjectNode supported=Json.object();
            if(snapshot!=null)snapshot.path("declaredCapabilities").fields().forEachRemaining(e->{if(e.getValue().path("supported").asBoolean())supported.set(e.getKey(),e.getValue());});
            // Wire v1 carries only id/revision/hash; kind/version/capabilities come from the hash-bound database profile.
            if(!Objects.equals(hash,Json.text(reference,"configHash"))||snapshot==null||!Json.hash(snapshot).equals(hash)||!Objects.equals(revision.get("capabilities"),supported))return context.fail("EXECUTOR_HOST_CONNECTION_MISMATCH","Frozen connection snapshot does not match the invocation reference",false);
            if(!snapshot.path("cli").hasNonNull("command"))return context.fail("EXECUTOR_HOST_CLI_NOT_CONFIGURED","Connection does not declare a CLI profile",false);
            try{profile=config.revisionProfile(invocation.path("target").path("agent").asText(),snapshot,reference.path("connectionId").asText(),hash);}catch(RuntimeException e){return context.fail("EXECUTOR_HOST_CLI_NOT_CONFIGURED","Immutable connection CLI profile is invalid on this host",false);}
        }
        String binding=HostConfig.bindingError(profile,invocation);if(binding!=null)return context.fail("EXECUTOR_HOST_CONNECTION_MISMATCH",binding,false);
        Path cwd;
        try{HostConfig.WorkspaceMember member=HostConfig.workspace(invocation);List<Path> additional=new ArrayList<>();if(member!=null){ObjectNode lease=authority.executionWorkspace(member.workspaceExecutionId(),invocation.path("executionId").asText());if(lease==null||!"IN_USE".equals(Json.text(lease,"state"))||!member.sourceWorkspaceId().equals(Json.text(lease,"sourceWorkspaceId"))||!member.mode().equals(Json.text(lease,"mode"))||!member.path().equals(Json.text(lease,"executionPath"))||!Objects.equals(member.baseHeadSha(),Json.text(lease,"baseHeadSha")))throw HostConfig.invalid("Execution workspace does not match its authoritative database lease");if(member.mode().equals("shared")){ObjectNode workspace=authority.workspace(member.sourceWorkspaceId());if(workspace!=null&&member.sourceWorkspaceId().equals(Json.text(workspace.path("snapshot"),"workspaceId"))&&Objects.equals(Json.text(workspace,"path"),Json.text(workspace.path("snapshot"),"path"))&&Objects.equals(Json.text(lease,"sourcePath"),Json.text(workspace,"path")))additional.add(HostConfig.directory(Json.text(workspace,"path")));}}
            cwd=HostConfig.executionCwd(profile,invocation,config.allowedRoot(),additional);
        }catch(RuntimeException e){return context.fail("EXECUTOR_HOST_WORKSPACE_PATH_INVALID","Execution workspace authority or local path validation failed",false);}
        HostConfig.Profile selected=profile;String stateKey=fixed==null?"run-"+Json.sha256(invocation.path("invocationId").asText()):profile.agent();String startedAt=Protocol.jsInstant(Instant.now());
        try{Supervisor.Outcome outcome=Supervisor.supervise(config.launcher(),profile,config.resolvedEnvironment(profile),invocation,Json.text(invocation,"requestedModelId"),context.signal,Json.text(invocation,"deadlineAt"),cwd,pid->{try{String processStart=ProcessHandle.of(pid).flatMap(p->p.info().startInstant()).map(Protocol::jsInstant).orElse(startedAt);RunState.write(config.stateDir(),stateKey,new RunState.State(invocation.path("invocationId").asText(),pid,processStart,Protocol.jsInstant(Instant.now().plusMillis(selected.wallTimeMs()))));}catch(IOException e){throw new IllegalStateException("Cannot persist process supervision state",e);}});NativeOutput.Result result=NativeOutput.adapt(outcome,profile);if(result.success())return context.success(result.output());return context.fail(result.code(),result.message(),result.retryable());}
        finally{RunState.clear(config.stateDir(),stateKey);}
    }
    @Override public void close(){for(Started item:started)item.worker.stop().join();started.clear();}
    public static void main(String[] args)throws Exception {Db db=Db.fromEnv();Main host=new Main(HostConfig.fromEnv(),database(db));Runtime.getRuntime().addShutdownHook(new Thread(()->{host.close();db.close();},"tenvyr-executor-host-shutdown"));host.start();}
}
