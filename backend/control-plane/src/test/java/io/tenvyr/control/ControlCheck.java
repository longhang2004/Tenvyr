package io.tenvyr.control;

import io.tenvyr.platform.*;
import io.tenvyr.control.authority.ExecutionCapsuleService;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.Map;
import java.net.*;
import com.fasterxml.jackson.databind.node.ObjectNode;

public final class ControlCheck {
    private static int checks;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args.length>0?args[0]:".");
        for(var vector:Json.parse(Files.readString(root.resolve("backend/control-plane/src/test/resources/node-capsule-hashes.json"))))check(ExecutionCapsuleService.contentHash((ObjectNode)vector.get("capsule")).equals(vector.path("hash").asText()),"original Node capsule Date/hash parity");
        var pipeline=ControlRoutes.pipelineInput(Json.object("yamlString","name: demo\nsteps:\n  - id: first\n    agent: reviewer\n"));
        check(pipeline.path("name").asText().equals("demo")&&pipeline.path("steps").size()==1,"safe YAML pipeline input");
        check(pipeline.path("version").asText().equals("1.0"),"pipeline version default");
        try{ControlRoutes.pipelineInput(Json.object("yamlString","!!java.net.URL [https://evil.test]"));throw new AssertionError("Unsafe YAML tag accepted");}catch(RuntimeException expected){checks++;}
        check(ControlRoutes.eventLimit("2.5")==50&&ControlRoutes.eventLimit("1000")==200&&ControlRoutes.eventLimit("0")==1,"bounded event pagination");
        try{ControlRoutes.eventCursor("2026-10-15T00:00:00Z",null);throw new AssertionError("Partial cursor accepted");}catch(IllegalArgumentException expected){checks++;}
        check(ControlRoutes.positivePage("-1")==1&&ControlRoutes.positivePage("2tail")==2,"legacy integer page parsing");
        var missing=ControlRoutes.domainError("connection","CONNECTION_NOT_FOUND","missing");
        check(missing.status()==404&&Json.parse(new String(missing.bytes(),StandardCharsets.UTF_8)).path("statusCode").asInt()==404,"legacy error envelope and status");
        var oauth=ControlRoutes.domainError("provider","AUTH_FLOW_EXPIRED","expired");
        check(oauth.status()==422,"provider domain status preserved");
        check(ControlRoutes.envelope(Json.object()).has("meta"),"operator response metadata");
        checkControlPlaneRuntimeSeam();
        checkConstructorFailureReleasesPort();
        System.out.println("ControlCheck: "+checks+" checks passed");
    }

    private static void checkConstructorFailureReleasesPort() throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        int port;
        try (ServerSocket reservation = new ServerSocket(0, 1, loopback)) {
            port = reservation.getLocalPort();
        }
        boolean rejected = false;
        try {
            new Main(new Db("jdbc:postgresql://127.0.0.1:1/unused_test", "unused", "unused"),
                Map.of("ORCHESTRATOR_PORT", Integer.toString(port), "AGENT_TRANSPORT_CONFIG", "{"));
        } catch (RuntimeException expected) {
            rejected = true;
            checks++;
        }
        check(rejected, "Invalid transport config was not rejected");
        try (ServerSocket rebound = new ServerSocket(port, 1, loopback)) {
            check(rebound.isBound(), "Constructor failure released the HTTP port");
            checks++;
        } catch (BindException leaked) {
            throw new AssertionError("Constructor leaked bound HTTP port after invalid configuration", leaked);
        }
    }

    private static void checkControlPlaneRuntimeSeam() {
        Class<?> runtimeClass;
        try {
            runtimeClass = Class.forName("io.tenvyr.control.ControlPlaneRuntime");
        } catch (ClassNotFoundException e) {
            throw new AssertionError("T00 failing check: io.tenvyr.control.ControlPlaneRuntime class missing", e);
        }
        check(AutoCloseable.class.isAssignableFrom(runtimeClass), "ControlPlaneRuntime must implement AutoCloseable");

        try {
            runtimeClass.getConstructor(Db.class, java.util.Map.class, java.util.function.Consumer.class);
            checks++;
        } catch (NoSuchMethodException e) {
            throw new AssertionError("ControlPlaneRuntime constructor (Db, Map, Consumer) missing", e);
        }

        for (String methodName : java.util.List.of("pipelines", "executions", "engine", "callbacks", "events", "startAfterMigrations", "close")) {
            try {
                runtimeClass.getMethod(methodName);
                checks++;
            } catch (NoSuchMethodException e) {
                throw new AssertionError("ControlPlaneRuntime." + methodName + "() missing", e);
            }
        }
        try {
            runtimeClass.getMethod("registerLegacyRoutes", io.tenvyr.platform.Http.class);
            checks++;
        } catch (NoSuchMethodException e) {
            throw new AssertionError("ControlPlaneRuntime.registerLegacyRoutes(Http) missing", e);
        }

        java.sql.Connection dummyConn = (java.sql.Connection) java.lang.reflect.Proxy.newProxyInstance(
            Db.class.getClassLoader(), new Class<?>[]{java.sql.Connection.class},
            (p, m, a) -> defaultValue(m.getReturnType()));
        Db dummyDb = Db.on(dummyConn);
        Map<String, String> env = Map.of("GATEWAY_URL", "http://127.0.0.1:1");
        try {
            ControlPlaneRuntime runtime = new ControlPlaneRuntime(dummyDb, env, msg -> {});
            check(runtime.pipelines() != null, "runtime.pipelines() non-null");
            check(runtime.executions() != null, "runtime.executions() non-null");
            check(runtime.engine() != null, "runtime.engine() non-null");
            check(runtime.callbacks() != null, "runtime.callbacks() non-null");
            check(runtime.events() != null, "runtime.events() non-null");

            // Close twice (must be idempotent)
            runtime.close();
            runtime.close();
            checks++;

            // Start after close (must be rejected)
            boolean startRejected = false;
            try {
                runtime.startAfterMigrations();
            } catch (IllegalStateException expected) {
                startRejected = true;
                checks++;
            }
            check(startRejected, "startAfterMigrations() must be rejected after close");
        } catch (Exception e) {
            throw new AssertionError("ControlPlaneRuntime pure instantiation/close failed", e);
        }
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) return null;
        if (type == boolean.class) return Boolean.FALSE;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == double.class) return 0.0;
        if (type == float.class) return 0.0f;
        if (type == byte.class) return (byte) 0;
        if (type == short.class) return (short) 0;
        if (type == char.class) return '\0';
        return null;
    }
}
