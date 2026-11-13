package io.tenvyr.review;

import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.control.engine.AgentTransportConfig;
import io.tenvyr.platform.Db;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.EnumerablePropertySource;
import org.springframework.core.env.Environment;
import org.springframework.core.env.PropertySource;

import javax.sql.DataSource;
import java.util.HashMap;
import java.util.Map;

/**
 * Spring configuration for review engine runtime.
 */
@Configuration
public class EngineConfiguration {

    private final DataSource dataSource;
    private final Environment environment;

    public EngineConfiguration(DataSource dataSource, Environment environment) {
        this.dataSource = dataSource;
        this.environment = environment;
    }

    @Bean(destroyMethod = "close")
    public ControlPlaneRuntime engineRuntime() {
        Map<String, String> envMap = new HashMap<>(System.getenv());
        if (environment instanceof ConfigurableEnvironment ce) {
            for (PropertySource<?> ps : ce.getPropertySources()) {
                if (ps instanceof EnumerablePropertySource<?> eps) {
                    for (String name : eps.getPropertyNames()) {
                        try {
                            String val = environment.getProperty(name);
                            if (val != null) {
                                envMap.put(name, val);
                            }
                        } catch (Exception ignored) {
                            Object raw = ps.getProperty(name);
                            if (raw != null) {
                                envMap.put(name, String.valueOf(raw));
                            }
                        }
                    }
                }
            }
        }

        for (String key : new String[]{"KAFKA_BROKERS", "ORCHESTRATOR_EVENT_TOPICS", "ORCHESTRATOR_RESULT_TOPICS"}) {
            String val = envMap.get(key);
            if (val != null && !val.isBlank()) {
                throw new IllegalStateException("Kafka configuration is not supported in review mode: " + key);
            }
        }

        AgentTransportConfig transport = new AgentTransportConfig(envMap);
        if (transport.hasKafkaAgents()) {
            throw new IllegalStateException("Kafka agents are not supported in review mode");
        }
        if (transport.httpForAgent("code-reviewer") == null) {
            throw new IllegalStateException("code-reviewer agent must be configured with HTTP transport");
        }

        Db db = Db.fromDataSource(dataSource);
        return new ControlPlaneRuntime(db, envMap, msg -> {});
    }
}
