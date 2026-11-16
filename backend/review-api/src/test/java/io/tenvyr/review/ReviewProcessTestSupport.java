package io.tenvyr.review;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.agents.AgentProcessor;
import io.tenvyr.agents.ReviewReportContract;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import io.tenvyr.worker.Worker;
import io.tenvyr.worker.WorkerConfig;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.web.servlet.context.ServletWebServerInitializedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import javax.sql.DataSource;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Dedicated process-level test harness for T08 recovery, crash, and shutdown tests.
 * Manages child JVM lifecycle, bounded log capture, deterministic DB barriers,
 * and test-profile scoped Spring configurations.
 */
public final class ReviewProcessTestSupport {

    private ReviewProcessTestSupport() {}

    public static void validateDisposableDatabaseUrl(String raw) {
        ReviewCallbackIT.validateDisposableDatabaseUrl(raw);
    }

    public static int findFreePort() {
        try (ServerSocket ss = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return ss.getLocalPort();
        } catch (IOException e) {
            throw new RuntimeException("Failed to find free loopback port", e);
        }
    }

    public static String findJavaBinary() {
        String javaHome = System.getProperty("java.home");
        Path binJava = Path.of(javaHome, "bin", "java");
        if (Files.exists(binJava)) {
            return binJava.toAbsolutePath().toString();
        }
        Path binJavaExe = Path.of(javaHome, "bin", "java.exe");
        if (Files.exists(binJavaExe)) {
            return binJavaExe.toAbsolutePath().toString();
        }
        return ProcessHandle.current().info().command().orElse("java");
    }

    /**
     * Managed child JVM process tracking stdout/stderr into bounded diagnostic log files,
     * maintaining line-based phase markers, and ensuring clean termination on close.
     */
    public static class ManagedProcess implements AutoCloseable {
        private final String name;
        private final Process process;
        private final Path logFile;
        private final BlockingQueue<String> lines = new LinkedBlockingQueue<>();
        private final Thread logThread;
        private final AtomicBoolean closed = new AtomicBoolean(false);
        private volatile int detectedPort = -1;

        public ManagedProcess(String name, Process process, Path logFile) {
            this.name = name;
            this.process = process;
            this.logFile = logFile;

            this.logThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
                     BufferedWriter writer = Files.newBufferedWriter(logFile, StandardCharsets.UTF_8)) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        String sanitized = sanitize(line);
                        writer.write(sanitized);
                        writer.newLine();
                        writer.flush();
                        lines.offer(line);

                        if (line.startsWith("[API_READY:port=")) {
                            try {
                                int p = Integer.parseInt(line.substring("[API_READY:port=".length(), line.indexOf(']')));
                                detectedPort = p;
                            } catch (Exception ignored) {}
                        } else if (line.startsWith("[WORKER_READY:port=")) {
                            try {
                                int p = Integer.parseInt(line.substring("[WORKER_READY:port=".length(), line.indexOf(']')));
                                detectedPort = p;
                            } catch (Exception ignored) {}
                        }
                    }
                } catch (IOException ignored) {}
            }, "managed-proc-log-" + name);
            this.logThread.setDaemon(true);
            this.logThread.start();
        }

        private static String sanitize(String input) {
            if (input == null) return "";
            return input
                    .replaceAll("(?i)(password=)[^&\\s]+", "$1[REDACTED]")
                    .replaceAll("(?i)(password_hash\\s*=\\s*')[^']+'", "$1[REDACTED]'")
                    .replaceAll("(?i)(TEST_SECRET=)[^\\s]+", "$1[REDACTED]")
                    .replaceAll("(?i)(TEST_TOKEN=)[^\\s]+", "$1[REDACTED]");
        }

        public String name() { return name; }
        public Process process() { return process; }
        public Path logFile() { return logFile; }
        public int port() { return detectedPort; }

        public String waitForMarker(String prefix, Duration timeout) throws InterruptedException, TimeoutException {
            long deadline = System.currentTimeMillis() + timeout.toMillis();
            while (System.currentTimeMillis() < deadline) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) break;
                String line = lines.poll(Math.min(remaining, 100), TimeUnit.MILLISECONDS);
                if (line != null && line.startsWith(prefix)) {
                    return line;
                }
                if (!process.isAlive() && lines.isEmpty()) {
                    throw new IllegalStateException("Process " + name + " died prematurely with exit code " + process.exitValue()
                            + "; see log at " + logFile);
                }
            }
            throw new TimeoutException("Timed out waiting for marker prefix '" + prefix + "' from " + name
                    + "; see log at " + logFile);
        }

        public boolean isAlive() { return process.isAlive(); }

        public void destroy() { process.destroy(); }

        public void destroyForcibly() { process.destroyForcibly(); }

        public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
            return process.waitFor(timeout, unit);
        }

        public int exitValue() { return process.exitValue(); }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                if (process.isAlive()) {
                    process.destroy();
                    try {
                        if (!process.waitFor(2, TimeUnit.SECONDS)) {
                            process.destroyForcibly();
                            process.waitFor(2, TimeUnit.SECONDS);
                        }
                    } catch (InterruptedException e) {
                        process.destroyForcibly();
                        Thread.currentThread().interrupt();
                    }
                }
            }
        }
    }

    /**
     * Entry point for child API server process.
     * Profile 'test-process' activates TestProcessConfiguration for deterministic DB barriers.
     */
    public static final class ApiProcessMain {
        public static void main(String[] args) {
            SpringApplication app = new SpringApplication(ReviewApplication.class, TestProcessConfiguration.class);
            app.setAdditionalProfiles("test-process");
            app.addListeners((ApplicationListener<ServletWebServerInitializedEvent>) event -> {
                int port = event.getWebServer().getPort();
                System.out.println("[API_READY:port=" + port + "]");
                System.out.flush();
            });
            app.run(args);
        }
    }

    /**
     * Entry point for child Worker process.
     * Starts pure Worker runtime with code-reviewer agent and bounded HTTP transport.
     */
    public static final class WorkerProcessMain {
        public static void main(String[] args) throws Exception {
            Map<String, String> env = System.getenv();
            String portStr = env.getOrDefault("PORT", "0");
            int port = Integer.parseInt(portStr);

            String bearerToken = env.getOrDefault("TENVYR_REVIEW_WORKER_BEARER_TOKEN", ReviewTestSupport.TEST_TOKEN);
            String keysRaw = env.getOrDefault("TENVYR_REVIEW_WORKER_CALLBACK_KEYS",
                    "{\"" + ReviewTestSupport.TEST_KEY_ID + "\":\"" + ReviewTestSupport.TEST_SECRET + "\"}");
            String originsRaw = env.getOrDefault("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS", "[\"http://127.0.0.1\"]");
            String mode = env.getOrDefault("TENVYR_REVIEW_WORKER_MODE", "MOCK");
            String runnerUrl = env.get("TENVYR_REVIEW_WORKER_RUNNER_URL");

            WorkerConfig config = new WorkerConfig();
            config.agentName = "code-reviewer";
            config.concurrency = 2;
            config.maxQueuedRuns = 16;
            config.maxRequestBytes = 1_048_576;
            config.maxResponseBytes = 65_536;
            config.allowInsecureHttp = true;
            config.bearerToken = bearerToken;

            JsonNode keysNode = Json.parse(keysRaw);
            Map<String, String> keys = new HashMap<>();
            keysNode.fields().forEachRemaining(e -> keys.put(e.getKey(), e.getValue().asText()));
            config.callbackKeys = Map.copyOf(keys);

            JsonNode originsNode = Json.parse(originsRaw);
            List<String> origins = new ArrayList<>();
            originsNode.elements().forEachRemaining(e -> origins.add(e.asText()));
            config.allowedOrigins = List.copyOf(origins);

            AgentProcessor.Runner runner;
            if ("RUNNER".equals(mode)) {
                runner = AgentProcessor.httpRunner(runnerUrl, 1_048_576);
            } else {
                runner = (prompt, context, timeout) -> Json.object(
                        "success", true,
                        "data", Json.object(
                                "output", Json.stringify(Json.object(
                                        "score", 100,
                                        "findings", Json.array("Demonstration fixture: no source code or security analysis was performed.")
                                )),
                                "metadata", Json.object(
                                        "provider", "mock",
                                        "model", "demo-fixture",
                                        "mode", "MOCK",
                                        "usageSource", "unavailable",
                                        "fallbackUsed", false
                                )
                        )
                );
            }

            Path skillsPath = Path.of(System.getenv().getOrDefault("TENVYR_SKILLS_DIR", "skills"));
            AgentProcessor processor = new AgentProcessor("code-reviewer", skillsPath, runner);

            Worker.Agent agent = (context, input) -> {
                ObjectNode result = processor.process(context.invocation);
                String status = result.path("status").asText();
                if ("succeeded".equals(status)) {
                    JsonNode output = result.get("output");
                    ReviewReportContract.requireOutput(output);
                    return context.success(output, result.get("usage"), null, result.get("metadata"));
                } else if ("timed_out".equals(status)) {
                    boolean retryable = result.path("error").path("retryable").asBoolean(true);
                    String message = result.path("error").path("message").asText("Agent execution timed out");
                    return context.fail("AGENT_TIMED_OUT", message, retryable);
                } else {
                    boolean retryable = result.path("error").path("retryable").asBoolean(false);
                    String code = result.path("error").path("code").asText("AGENT_EXECUTION_FAILED");
                    String message = result.path("error").path("message").asText("Agent execution failed");
                    return context.fail(code, message, retryable);
                }
            };

            Worker worker = new Worker(config, agent);
            worker.start("127.0.0.1", port);
            int actualPort = worker.port();
            System.out.println("[WORKER_READY:port=" + actualPort + "]");
            System.out.println("ReviewWorker listening on http://127.0.0.1:" + actualPort);
            System.out.flush();

            Runtime.getRuntime().addShutdownHook(new Thread(worker::close));
            // Keep main alive until terminated
            Thread.sleep(Long.MAX_VALUE);
        }
    }

    /**
     * Explicit test configuration scoped to profile 'test-process'.
     * Never component-scanned into normal integration test contexts.
     */
    @Profile("test-process")
    @Configuration(proxyBeanMethods = false)
    public static class TestProcessConfiguration {

        @Bean
        public ReviewService.PostMaterializationObserver testPostMaterializationObserver(
                Environment env, DataSource dataSource) {
            return (connection, executionId) -> {
                // Pre-commit barrier check (Test 1): register BEFORE_COMMIT synchronization
                // to verify that materialized execution, steps, request, and SUBMIT audit are written
                // on the SAME connection before blocking on parent PG barrier.
                String preCommitLockStr = env.getProperty("test.barrier.pre-commit.lock-key");
                if (preCommitLockStr != null && !preCommitLockStr.isBlank()) {
                    long lockKey = Long.parseLong(preCommitLockStr.trim());
                    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                        @Override
                        public void beforeCommit(boolean readOnly) {
                            try {
                                int execCount = 0;
                                try (PreparedStatement ps = connection.prepareStatement("SELECT count(*) FROM executions WHERE id = ?")) {
                                    ps.setObject(1, executionId);
                                    try (ResultSet rs = ps.executeQuery()) {
                                        if (rs.next()) execCount = rs.getInt(1);
                                    }
                                }

                                int stepCount = 0;
                                try (PreparedStatement ps = connection.prepareStatement("SELECT count(*) FROM step_executions WHERE \"executionId\" = ?")) {
                                    ps.setObject(1, executionId);
                                    try (ResultSet rs = ps.executeQuery()) {
                                        if (rs.next()) stepCount = rs.getInt(1);
                                    }
                                }

                                UUID requestId = null;
                                try (PreparedStatement ps = connection.prepareStatement("SELECT id FROM tenvyr_review.requests WHERE execution_id = ?")) {
                                    ps.setObject(1, executionId);
                                    try (ResultSet rs = ps.executeQuery()) {
                                        if (rs.next()) requestId = rs.getObject("id", UUID.class);
                                    }
                                }

                                int auditCount = 0;
                                if (requestId != null) {
                                    try (PreparedStatement ps = connection.prepareStatement(
                                            "SELECT count(*) FROM tenvyr_review.audit WHERE request_id = ? AND action = 'SUBMIT'")) {
                                        ps.setObject(1, requestId);
                                        try (ResultSet rs = ps.executeQuery()) {
                                            if (rs.next()) auditCount = rs.getInt(1);
                                        }
                                    }
                                }

                                System.out.println("[PHASE:BEFORE_COMMIT_CONFIRMED:executionId=" + executionId
                                        + ":requestId=" + requestId
                                        + ":execCount=" + execCount
                                        + ":stepCount=" + stepCount
                                        + ":auditCount=" + auditCount + "]");
                                System.out.flush();

                                // Block on transaction advisory lock held by parent test connection
                                try (PreparedStatement ps = connection.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {
                                    ps.setLong(1, lockKey);
                                    ps.execute();
                                }
                            } catch (SQLException e) {
                                throw new RuntimeException("Error in pre-commit DB barrier", e);
                            }
                        }
                    });
                }

                // In-flight barrier lock check (for Test 4 SIGTERM drain test)
                String inflightLockStr = env.getProperty("test.barrier.inflight.lock-key");
                if (inflightLockStr != null && !inflightLockStr.isBlank()) {
                    long lockKey = Long.parseLong(inflightLockStr.trim());
                    System.out.println("[PHASE:INFLIGHT_HELD]");
                    System.out.flush();
                    try (PreparedStatement ps = connection.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {
                        ps.setLong(1, lockKey);
                        ps.execute();
                    }
                }
            };
        }

        @Bean
        public Filter testPostCommitBarrierFilter(Environment env, DataSource dataSource) {
            return new OncePerRequestFilter() {
                @Override
                protected void doFilterInternal(
                        HttpServletRequest request,
                        HttpServletResponse response,
                        FilterChain filterChain) throws ServletException, IOException {

                    filterChain.doFilter(request, response);

                    String postCommitLockStr = env.getProperty("test.barrier.post-commit.lock-key");
                    if (postCommitLockStr != null && !postCommitLockStr.isBlank()
                            && "POST".equalsIgnoreCase(request.getMethod())
                            && request.getRequestURI().endsWith("/api/v1/reviews")) {
                        long lockKey = Long.parseLong(postCommitLockStr.trim());
                        System.out.println("[PHASE:AFTER_COMMIT_BEFORE_RESPONSE]");
                        System.out.flush();

                        try (Connection conn = dataSource.getConnection();
                             PreparedStatement ps = conn.prepareStatement("SELECT pg_advisory_lock(?)")) {
                            ps.setLong(1, lockKey);
                            ps.execute();
                        } catch (SQLException ignored) {}
                    }
                }
            };
        }
    }

    public static ManagedProcess launchApiProcess(
            String name,
            int port,
            String dbUrl,
            String user,
            String pass,
            int workerPort,
            Map<String, String> extraProperties) throws Exception {

        Path logDir = Path.of("target", "test-process-logs");
        Files.createDirectories(logDir);
        Path logFile = logDir.resolve(name + "-" + System.currentTimeMillis() + ".log");

        String javaBin = findJavaBinary();
        String classpath = System.getProperty("java.class.path");

        List<String> cmd = new ArrayList<>();
        cmd.add(javaBin);
        cmd.add("-cp");
        cmd.add(classpath);

        // Server and DataSource properties (credentials passed via env, not -D CLI args)
        cmd.add("-Dserver.port=" + port);
        cmd.add("-Dserver.shutdown=graceful");
        cmd.add("-Dspring.lifecycle.timeout-per-shutdown-phase=30s");
        cmd.add("-Dspring.datasource.url=" + dbUrl);
        cmd.add("-Dspring.datasource.username=" + user);
        cmd.add("-Dspring.datasource.hikari.maximum-pool-size=10");
        cmd.add("-Dspring.datasource.hikari.connection-timeout=2000");

        // Engine & Transport properties
        cmd.add("-DHTTP_AGENT_ALLOW_INSECURE=true");
        cmd.add("-DHTTP_AGENT_CALLBACK_BASE_URL=http://127.0.0.1:" + (port == 0 ? 8080 : port));
        cmd.add("-DTEST_SECRET=" + ReviewTestSupport.TEST_SECRET);
        cmd.add("-DTEST_TOKEN=" + ReviewTestSupport.TEST_TOKEN);

        String transportConfig = Json.stringify(Json.object(
                ReviewTestSupport.TEST_AGENT, Json.object(
                        "kind", "http",
                        "submitUrl", "http://127.0.0.1:" + workerPort + "/v1/runs",
                        "outboundAuthentication", Json.object("type", "bearer", "tokenEnv", "TEST_TOKEN"),
                        "callbackAuthentication", Json.object("keyId", ReviewTestSupport.TEST_KEY_ID, "secretEnv", "TEST_SECRET"),
                        "requestTimeoutMs", 2000,
                        "maxResponseBytes", 65536
                )
        ));
        cmd.add("-DAGENT_TRANSPORT_CONFIG=" + transportConfig);
        cmd.add("-Dspring.profiles.active=test-process");

        if (extraProperties != null) {
            for (Map.Entry<String, String> entry : extraProperties.entrySet()) {
                cmd.add("-D" + entry.getKey() + "=" + entry.getValue());
            }
        }

        cmd.add("io.tenvyr.review.ReviewProcessTestSupport$ApiProcessMain");

        ProcessBuilder pb = new ProcessBuilder(cmd);
        // Expose credentials via process environment, not command-line arguments
        if (pass != null) {
            pb.environment().put("SPRING_DATASOURCE_PASSWORD", pass);
            pb.environment().put("PGPASSWORD", pass);
        }
        pb.redirectErrorStream(true);
        Process process = pb.start();

        ManagedProcess mp = new ManagedProcess(name, process, logFile);
        try {
            mp.waitForMarker("[API_READY:port=", Duration.ofSeconds(90));
            return mp;
        } catch (Throwable t) {
            mp.close();
            throw t;
        }
    }

    public static ManagedProcess launchWorkerProcess(
            String name,
            int workerPort,
            int apiPort,
            String mode,
            String runnerUrl) throws Exception {

        Path logDir = Path.of("target", "test-process-logs");
        Files.createDirectories(logDir);
        Path logFile = logDir.resolve(name + "-" + System.currentTimeMillis() + ".log");

        String javaBin = findJavaBinary();
        String classpath = System.getProperty("java.class.path");

        List<String> cmd = new ArrayList<>();
        cmd.add(javaBin);
        cmd.add("-cp");
        cmd.add(classpath);
        cmd.add("io.tenvyr.review.ReviewProcessTestSupport$WorkerProcessMain");

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().put("PORT", String.valueOf(workerPort));
        pb.environment().put("TENVYR_REVIEW_WORKER_BEARER_TOKEN", ReviewTestSupport.TEST_TOKEN);
        pb.environment().put("TENVYR_REVIEW_WORKER_CALLBACK_KEYS",
                "{\"" + ReviewTestSupport.TEST_KEY_ID + "\":\"" + ReviewTestSupport.TEST_SECRET + "\"}");
        pb.environment().put("TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS", "[\"http://127.0.0.1:" + apiPort + "\"]");
        pb.environment().put("TENVYR_REVIEW_WORKER_ALLOW_INSECURE_HTTP", "true");
        pb.environment().put("TENVYR_REVIEW_WORKER_MODE", mode != null ? mode : "MOCK");
        if (runnerUrl != null) {
            pb.environment().put("TENVYR_REVIEW_WORKER_RUNNER_URL", runnerUrl);
        }
        pb.redirectErrorStream(true);
        Process process = pb.start();

        ManagedProcess mp = new ManagedProcess(name, process, logFile);
        try {
            mp.waitForMarker("[WORKER_READY:port=", Duration.ofSeconds(90));
            return mp;
        } catch (Throwable t) {
            mp.close();
            throw t;
        }
    }

    public static void awaitAdvisoryLockBlocked(DataSource ds, Duration timeout) throws Exception {
        long deadline = System.currentTimeMillis() + timeout.toMillis();
        while (System.currentTimeMillis() < deadline) {
            try (Connection conn = ds.getConnection();
                 PreparedStatement ps = conn.prepareStatement(
                         "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted LIMIT 1")) {
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        return;
                    }
                }
            }
            Thread.sleep(25);
        }
        throw new TimeoutException("Timed out waiting for advisory lock contention in PostgreSQL pg_locks");
    }
}
