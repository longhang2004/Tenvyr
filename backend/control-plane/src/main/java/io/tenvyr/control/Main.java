package io.tenvyr.control;

import io.tenvyr.control.engine.EngineService;
import io.tenvyr.platform.*;
import java.util.Map;

/** Owns the actual Java control plane, its adapters, recovery loop and management sessions. */
public final class Main implements AutoCloseable {
    private final Db db;
    private final Http http;
    private final ControlPlaneRuntime runtime;
    private boolean started,closed;

    public Main(Db db,Map<String,String> environment) {
        this.db=db;
        ControlPlaneRuntime r=null;
        Http h=null;
        try {
            r=new ControlPlaneRuntime(db,environment,EngineService.gatewayProjection(environment));
            h=new Http(environment.getOrDefault("ORCHESTRATOR_HOST","127.0.0.1"),Integer.parseInt(environment.getOrDefault("ORCHESTRATOR_PORT","3001")),environment.get("CORS_ORIGIN"));
            r.registerLegacyRoutes(h);
            this.runtime=r;
            this.http=h;
        } catch(Throwable failure) {
            if(h!=null) try { h.close(); } catch(Exception cleanup) { failure.addSuppressed(cleanup); }
            if(r!=null) try { r.close(); } catch(Exception cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    public synchronized int start() throws Exception {
        if(closed)throw new IllegalStateException("Control plane is closed");
        if(started)return http.port();
        try {
            Migrator.migrateFromEnv(db);
            runtime.startAfterMigrations();
            http.start();
            started=true;
            return http.port();
        } catch(Exception|Error failure) {try{close();}catch(Exception cleanup){failure.addSuppressed(cleanup);}throw failure;}
    }
    @Override public synchronized void close() throws Exception {
        if(closed)return;
        closed=true;
        Exception failure=null;
        for(AutoCloseable resource:new AutoCloseable[]{http,runtime,db})try{resource.close();}catch(Exception error){if(failure==null)failure=error;else failure.addSuppressed(error);}
        if(failure!=null)throw failure;
    }
    public static void main(String[] args) throws Exception {
        Main control=new Main(Db.fromEnv(),System.getenv());
        Runtime.getRuntime().addShutdownHook(new Thread(()->{try{control.close();}catch(Exception failure){System.err.println("Control plane shutdown failed: "+failure.getClass().getSimpleName());}},"tenvyr-control-shutdown"));
        System.out.println("Orchestrator listening on port "+control.start());
    }
}
