package io.tenvyr.review;

import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.platform.Db;
import io.tenvyr.platform.Migrator;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;

/**
 * SmartLifecycle coordinator for base migrations and control plane runtime.
 * Starts runtime before web admission and drains runtime after web admission stops.
 */
@Component("engineLifecycle")
public class EngineLifecycle implements SmartLifecycle {

    private final ControlPlaneRuntime engineRuntime;
    private final DataSource dataSource;
    private volatile boolean running;

    @Autowired
    public EngineLifecycle(ControlPlaneRuntime engineRuntime, DataSource dataSource) {
        this.engineRuntime = engineRuntime;
        this.dataSource = dataSource;
    }

    @Override
    public synchronized void start() {
        if (running) {
            return;
        }
        try {
            Db db = Db.fromDataSource(dataSource);
            Migrator.migrate(db);
            engineRuntime.startAfterMigrations();
            running = true;
        } catch (Exception e) {
            try {
                engineRuntime.close();
            } catch (Exception cleanup) {
                e.addSuppressed(cleanup);
            }
            throw new RuntimeException("Failed to start engine lifecycle", e);
        }
    }

    @Override
    public synchronized void stop() {
        if (!running) {
            return;
        }
        running = false;
        try {
            engineRuntime.close();
        } catch (Exception e) {
            throw new RuntimeException("Failed to cleanly stop engine runtime", e);
        }
    }

    @Override
    public void stop(Runnable callback) {
        try {
            stop();
        } finally {
            callback.run();
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        // Must start before web admission (WebServerStartStopLifecycle: Integer.MAX_VALUE - 2048)
        // and drain after web admission shuts down
        return 100;
    }

    @Override
    public boolean isAutoStartup() {
        return true;
    }
}
