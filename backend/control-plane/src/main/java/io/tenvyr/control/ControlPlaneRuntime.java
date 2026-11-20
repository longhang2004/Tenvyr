package io.tenvyr.control;

import io.tenvyr.control.authority.AuthorityServices;
import io.tenvyr.control.engine.*;
import io.tenvyr.control.runtime.*;
import io.tenvyr.platform.*;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * Reusable control plane runtime composition.
 * Owns engine, adapters, recovery loop, and provider sessions.
 * Does not own HTTP admission, migration execution, or caller Db/DataSource lifecycle.
 */
public final class ControlPlaneRuntime implements AutoCloseable {
    private final PipelineService pipelines;
    private final ExecutionService executions;
    private final EngineService engine;
    private final HttpAgentAdapter callbacks;
    private final AgentEventService events;
    private final RuntimeRecoveryService recovery;
    private final AgentAdapterRouter adapters;
    private final ProviderDiscoveryService providers;
    private final WorkspaceExecutionService leases;
    private final ControlRoutes routes;
    private final AgentAdapter.Handlers handlers;
    private boolean started, closed;

    public ControlPlaneRuntime(Db db, Map<String, String> environment, Consumer<String> projection) {
        Objects.requireNonNull(db, "db");
        Objects.requireNonNull(environment, "environment");
        AgentTransportConfig transport = new AgentTransportConfig(environment);
        SupervisionService.parse(environment.get("ORCHESTRATOR_SUPERVISION_CONFIG"));
        AuthorityServices authority = new AuthorityServices(db, () -> environment.get("TENVYR_POLICY"));
        Conditions conditions = new Conditions();
        this.pipelines = new PipelineService(db, authority, conditions);
        RuntimeConnectionService connections = new RuntimeConnectionService(db);
        WorkspaceService workspaces = new WorkspaceService(db);
        this.leases = new WorkspaceExecutionService(db);
        RuntimeCoordinationService coordination = new RuntimeCoordinationService(db, authority.plans, authority.budget, connections, leases);
        RuntimeFacade runtimeFacade = new RuntimeFacade(connections, leases, coordination);
        this.executions = new ExecutionService(db, authority, runtimeFacade, transport, conditions);
        authority.bind(pipelines, executions, runtimeFacade, transport);
        ResultInboxService inbox = new ResultInboxService(db, authority);
        this.events = new AgentEventService(db);
        this.callbacks = new HttpAgentAdapter(transport);
        this.adapters = new AgentAdapterRouter(new KafkaAgentAdapter(transport, executions, environment), callbacks, transport);
        DispatchOutboxService outbox = new DispatchOutboxService(db, adapters, transport, authority);
        Consumer<String> effectiveProjection = projection != null ? projection : (s -> {});
        this.engine = new EngineService(pipelines, executions, inbox, events, outbox, runtimeFacade, effectiveProjection);
        this.recovery = new RuntimeRecoveryService(db, outbox, inbox, engine, new SupervisionService(db, inbox, engine, environment), authority);
        RuntimeOnboardingService onboarding = new RuntimeOnboardingService(environment);
        ModelSourceService sources = new ModelSourceService(db, new ModelDiscoveryService(environment));
        HandoffService handoffs = new HandoffService(db, executions, coordination, leases);
        this.providers = new ProviderDiscoveryService(connections, environment);
        WorkbenchCommandService commands = new WorkbenchCommandService(db, executions, coordination, authority.capsules, connections, workspaces, leases, handoffs, sources, providers, onboarding, environment);
        this.routes = new ControlRoutes(pipelines, executions, engine, events, callbacks, connections, workspaces, onboarding, sources, providers, commands, new WorkbenchProjectionService(db, connections, authority.capsules, authority.delegation), new AttentionService(db));
        this.handlers = engine;
    }

    public PipelineService pipelines() { return pipelines; }
    public ExecutionService executions() { return executions; }
    public EngineService engine() { return engine; }
    public HttpAgentAdapter callbacks() { return callbacks; }
    public AgentEventService events() { return events; }

    public void registerLegacyRoutes(Http http) {
        routes.register(http);
    }

    public synchronized void startAfterMigrations() throws Exception {
        if (closed) throw new IllegalStateException("Control plane runtime is closed");
        if (started) return;
        try {
            leases.reconcileWorkspaceExecutions();
            adapters.start(handlers);
            recovery.start();
            started = true;
        } catch (Exception | Error failure) {
            try { close(); } catch (Exception cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    @Override
    public synchronized void close() throws Exception {
        if (closed) return;
        closed = true;
        Exception failure = null;
        for (AutoCloseable resource : new AutoCloseable[]{recovery, adapters, providers}) {
            if (resource != null) {
                try {
                    resource.close();
                } catch (Exception error) {
                    if (failure == null) failure = error; else failure.addSuppressed(error);
                }
            }
        }
        if (failure != null) throw failure;
    }
}
