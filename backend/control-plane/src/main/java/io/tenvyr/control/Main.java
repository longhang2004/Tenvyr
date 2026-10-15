package io.tenvyr.control;

import io.tenvyr.control.authority.AuthorityServices;
import io.tenvyr.control.engine.*;
import io.tenvyr.control.runtime.*;
import io.tenvyr.platform.*;
import java.util.Map;

/** Owns the actual Java control plane, its adapters, recovery loop and management sessions. */
public final class Main implements AutoCloseable {
    private final Db db;
    private final Http http;
    private final AgentAdapterRouter adapters;
    private final ProviderDiscoveryService providers;
    private final RuntimeRecoveryService recovery;
    private final WorkspaceExecutionService leases;
    private boolean started,closed;

    public Main(Db db,Map<String,String> environment) {
        this.db=db;
        // Validate configuration and bind before starting any background work.
        AgentTransportConfig transport=new AgentTransportConfig(environment);
        SupervisionService.parse(environment.get("ORCHESTRATOR_SUPERVISION_CONFIG"));
        http=new Http(environment.getOrDefault("ORCHESTRATOR_HOST","127.0.0.1"),Integer.parseInt(environment.getOrDefault("ORCHESTRATOR_PORT","3001")),environment.get("CORS_ORIGIN"));
        AuthorityServices authority=new AuthorityServices(db,()->environment.get("TENVYR_POLICY"));
        Conditions conditions=new Conditions();
        PipelineService pipelines=new PipelineService(db,authority,conditions);
        RuntimeConnectionService connections=new RuntimeConnectionService(db);
        WorkspaceService workspaces=new WorkspaceService(db);
        leases=new WorkspaceExecutionService(db);
        RuntimeCoordinationService coordination=new RuntimeCoordinationService(db,authority.plans,authority.budget,connections,leases);
        RuntimeFacade runtime=new RuntimeFacade(connections,leases,coordination);
        ExecutionService executions=new ExecutionService(db,authority,runtime,transport,conditions);
        authority.bind(pipelines,executions,runtime,transport);
        ResultInboxService inbox=new ResultInboxService(db,authority);
        AgentEventService events=new AgentEventService(db);
        HttpAgentAdapter callbacks=new HttpAgentAdapter(transport);
        adapters=new AgentAdapterRouter(new KafkaAgentAdapter(transport,executions,environment),callbacks,transport);
        DispatchOutboxService outbox=new DispatchOutboxService(db,adapters,transport,authority);
        EngineService engine=new EngineService(pipelines,executions,inbox,events,outbox,runtime,EngineService.gatewayProjection(environment));
        recovery=new RuntimeRecoveryService(db,outbox,inbox,engine,new SupervisionService(db,inbox,engine,environment),authority);
        RuntimeOnboardingService onboarding=new RuntimeOnboardingService(environment);
        ModelSourceService sources=new ModelSourceService(db,new ModelDiscoveryService(environment));
        HandoffService handoffs=new HandoffService(db,executions,coordination,leases);
        providers=new ProviderDiscoveryService(connections,environment);
        WorkbenchCommandService commands=new WorkbenchCommandService(db,executions,coordination,authority.capsules,connections,workspaces,leases,handoffs,sources,providers,onboarding,environment);
        new ControlRoutes(pipelines,executions,engine,events,callbacks,connections,workspaces,onboarding,sources,providers,commands,new WorkbenchProjectionService(db,connections,authority.capsules,authority.delegation),new AttentionService(db)).register(http);
        handlers=engine;
    }
    private final AgentAdapter.Handlers handlers;

    public synchronized int start() throws Exception {
        if(closed)throw new IllegalStateException("Control plane is closed");
        if(started)return http.port();
        try {
            Migrator.migrateFromEnv(db);
            leases.reconcileWorkspaceExecutions();
            adapters.start(handlers);
            recovery.start();
            http.start();
            started=true;
            return http.port();
        } catch(Exception|Error failure) {try{close();}catch(Exception cleanup){failure.addSuppressed(cleanup);}throw failure;}
    }
    @Override public synchronized void close() throws Exception {
        if(closed)return;
        closed=true;
        http.close();
        recovery.close();
        try {adapters.close();} finally {providers.close();db.close();}
    }
    public static void main(String[] args) throws Exception {
        Main control=new Main(Db.fromEnv(),System.getenv());
        Runtime.getRuntime().addShutdownHook(new Thread(()->{try{control.close();}catch(Exception failure){System.err.println("Control plane shutdown failed: "+failure.getClass().getSimpleName());}},"tenvyr-control-shutdown"));
        System.out.println("Orchestrator listening on port "+control.start());
    }
}
