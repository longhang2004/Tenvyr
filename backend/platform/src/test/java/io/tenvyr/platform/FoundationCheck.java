package io.tenvyr.platform;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.domain.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.lang.reflect.*;
import java.sql.*;
import javax.sql.DataSource;
import java.util.concurrent.atomic.*;

/** No test framework: run with java -ea ... FoundationCheck <repository root>. */
public final class FoundationCheck {
    private static int checks=0;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void rejects(Runnable work,String message){try{work.run();throw new AssertionError("Accepted "+message);}catch(IllegalArgumentException expected){checks++;}}
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args.length==0?".":args[0]),fixtures=root.resolve("contracts/conformance");
        for(String kind:List.of("run-request","run-accepted","results","json-numbers"))for(String validity:List.of("valid","invalid"))try(var files=Files.list(fixtures.resolve(kind).resolve(validity))){for(Path file:files.filter(p->p.toString().endsWith(".json")).toList()){
            JsonNode value=Json.parse(Files.readString(file));Runnable parse=()->{switch(kind){case "run-request"->Protocol.httpRequest(value);case "run-accepted"->Protocol.httpAccepted(value);case "results"->Protocol.result(value);default->{if(value.has("invocation"))Protocol.httpRequest(value);else Protocol.result(value);}}};
            if(validity.equals("valid")||file.getFileName().toString().equals("invocation-mismatch.json")){parse.run();checks++;}else rejects(parse,file.toString());
        }}
        rejects(()->Json.parse(" "),"empty JSON");rejects(()->Json.parse("{} {}"),"trailing JSON");check(Json.parse("{\"k\":1,\"k\":2}").path("k").asInt()==2,"JSON.parse duplicate key parity");
        JsonNode request=Json.parse(Files.readString(fixtures.resolve("run-request/valid/minimal.json")));ObjectNode invocation=(ObjectNode)request.path("invocation").deepCopy();
        invocation.set("input",Json.object("nested",Double.POSITIVE_INFINITY));rejects(()->Protocol.invocation(invocation),"nonfinite nested number");invocation.set("input",Json.object("nested",9007199254740992L));rejects(()->Protocol.invocation(invocation),"unsafe nested number");invocation.set("input",NullNode.instance);Protocol.invocation(invocation);checks++;
        ObjectNode defaults=Json.object("invocationId","attempt:1","executionId","execution","stepExecutionId","step","stepId","review","agent","reviewer","attempt",1,"traceId","execution","correlationId","attempt:1","createdAt","2026-07-26T00:00:00.000Z");
        ObjectNode normalized=Protocol.normalizeInvocation(Json.object("input",Json.object("source","x"),"timeout","2s"),defaults);check(Json.text(normalized,"deadlineAt").equals("2026-07-26T00:00:02.000Z"),"legacy deadline");check(Json.text(normalized,"invocationId").equals("attempt:1"),"legacy deterministic identity");rejects(()->Protocol.normalizeInvocation(Json.object("executionId","alien","input",0),defaults),"legacy context mismatch");
        ObjectNode result=Protocol.normalizeResult(Json.object("status","FAILED","stepId","review","error","broken","data",Json.object("a",1)),Json.object("invocationId","attempt:1","executionId","execution","stepExecutionId","step","completedAt","2026-07-26T00:00:02.000Z"));check(Json.text(result.path("error"),"code").equals("LEGACY_AGENT_FAILURE"),"legacy error");
        ObjectNode patch=ExecutionState.validateStatePatch(Json.object("set",Json.object("a",Json.object("z",1,"y",2)),"delete",Json.array("b")));check(ExecutionState.applyStatePatch(Json.object("a",Json.object("y",2,"z",1)),patch).path("changed").asBoolean()==false,"semantic noop");check(ExecutionState.applyStatePatch(Json.object("b",4),patch).path("changed").asBoolean(),"effective mutation");rejects(()->ExecutionState.validateStatePatch(Json.object("set",Json.object("__proto__",1))),"dangerous state key");rejects(()->ExecutionState.validateStatePatch(Json.object("delete",Json.array("a","a"))),"duplicate deletion");
        JsonNode deep=Json.value("leaf");for(int i=0;i<5000;i++)deep=Json.array(deep);check(ExecutionState.jsonValueUtf8Size(deep)==10006,"iterative deep size");
        check(Approval.approvalExpiry(Instant.EPOCH,1).equals(Instant.ofEpochMilli(1)),"approval expiry");rejects(()->Approval.assertApprovalTransition("APPROVED","DENIED"),"approval terminal transition");
        check(Workspace.parseAcceptanceEvidence(Json.object("extra",1))==null,"acceptance evidence actual source ignores extra keys");check(WorkspaceExecution.executionWorkspaceIdentityFromRow(Json.object("state","FAILED","executionPath","/tmp"))==null,"workspace failed identity");rejects(()->WorkspaceExecution.parseExecutionWorkspaceIdentity(Json.object("schemaVersion",1,"path","/tmp","mode","shared","workspaceExecutionId","x","sourceWorkspaceId","x","extra",1)),"workspace closed identity");
        check(TransportIdentity.boundedKafkaScope("x".repeat(256)).equals("kafka-sha256:"+Json.sha256("x".repeat(256))),"bounded transport hashing");check(Entities.tables().size()==36,"entity inventory");check(Migrator.ledger().size()==27,"migration inventory");
        Path goldens=args.length>1?Path.of(args[1]):root.resolve("backend/platform/src/test/resources/node-canonical-goldens.json");
        JsonNode vectors=Json.parse(Files.readString(goldens));int failures=0;
        for(JsonNode vector:vectors){String actual=Json.canonical(vector.get("value")),expected=vector.path("canonical").asText();if(!actual.equals(expected)||!Json.hash(vector.get("value")).equals(vector.path("hash").asText())){failures++;if(failures<=12)System.err.println("Canonical/hash mismatch "+vector.path("name").asText()+": expected "+expected+" actual "+actual);}else checks++;}
        check(failures==0,"canonical Node golden failures: "+failures);
        checkDataSourceSeam();
        System.out.println("FoundationCheck: "+checks+" checks passed");
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

    private static void checkDataSourceSeam() {
        Method fromDs;
        try {
            fromDs = Db.class.getMethod("fromDataSource", DataSource.class);
        } catch (NoSuchMethodException e) {
            throw new AssertionError("T00 failing check: Db.fromDataSource(javax.sql.DataSource) missing", e);
        }
        check(Modifier.isStatic(fromDs.getModifiers()), "Db.fromDataSource must be static");
        check(Db.class.isAssignableFrom(fromDs.getReturnType()), "Db.fromDataSource must return Db");

        AtomicBoolean dsClosed = new AtomicBoolean(false);
        AtomicInteger borrowedCount = new AtomicInteger(0);
        AtomicInteger returnedCount = new AtomicInteger(0);
        AtomicInteger utcSetCount = new AtomicInteger(0);
        AtomicInteger pooledCommitCount = new AtomicInteger(0);
        AtomicInteger pooledRollbackCount = new AtomicInteger(0);

        InvocationHandler connHandler = (proxy, method, margs) -> {
            String name = method.getName();
            if (name.equals("close")) { returnedCount.incrementAndGet(); return null; }
            if (name.equals("createStatement")) {
                InvocationHandler stmtHandler = (sProxy, sMethod, sArgs) -> {
                    if (sMethod.getName().equals("execute") && sArgs != null && sArgs.length > 0) {
                        String sql = String.valueOf(sArgs[0]);
                        if (sql.contains("TIME ZONE 'UTC'") || sql.contains("TIME ZONE UTC") || sql.contains("TIMEZONE 'UTC'")) {
                            utcSetCount.incrementAndGet();
                        }
                    }
                    if (sMethod.getName().equals("close")) return null;
                    return defaultValue(sMethod.getReturnType());
                };
                return Proxy.newProxyInstance(Db.class.getClassLoader(), new Class<?>[]{Statement.class}, stmtHandler);
            }
            if (name.equals("prepareStatement")) {
                String sql = margs != null && margs.length > 0 ? String.valueOf(margs[0]) : "";
                InvocationHandler psHandler = (pProxy, pMethod, pArgs) -> {
                    if (pMethod.getName().equals("close")) return null;
                    if (pMethod.getName().equals("execute")) {
                        if (sql.contains("FAIL")) throw new SQLException("simulated SQL failure");
                        return true;
                    }
                    if (pMethod.getName().equals("getUpdateCount")) return 1;
                    if (pMethod.getName().equals("executeQuery")) {
                        if (sql.contains("FAIL")) throw new SQLException("simulated SQL failure");
                        InvocationHandler rsHandler = (rProxy, rMethod, rArgs) -> {
                            if (rMethod.getName().equals("next")) return false;
                            if (rMethod.getName().equals("close")) return null;
                            if (rMethod.getName().equals("getMetaData")) {
                                InvocationHandler mdHandler = (mProxy, mMethod, mArgs2) -> {
                                    if (mMethod.getName().equals("getColumnCount")) return 0;
                                    return defaultValue(mMethod.getReturnType());
                                };
                                return Proxy.newProxyInstance(Db.class.getClassLoader(), new Class<?>[]{ResultSetMetaData.class}, mdHandler);
                            }
                            return defaultValue(rMethod.getReturnType());
                        };
                        return Proxy.newProxyInstance(Db.class.getClassLoader(), new Class<?>[]{ResultSet.class}, rsHandler);
                    }
                    return defaultValue(pMethod.getReturnType());
                };
                return Proxy.newProxyInstance(Db.class.getClassLoader(), new Class<?>[]{PreparedStatement.class}, psHandler);
            }
            if (name.equals("setAutoCommit")) return null;
            if (name.equals("commit")) { pooledCommitCount.incrementAndGet(); return null; }
            if (name.equals("rollback")) { pooledRollbackCount.incrementAndGet(); return null; }
            if (name.equals("isClosed")) return false;
            return defaultValue(method.getReturnType());
        };

        Connection proxyConn = (Connection) Proxy.newProxyInstance(
            Db.class.getClassLoader(),
            new Class<?>[]{Connection.class},
            connHandler
        );

        InvocationHandler dsHandler = (proxy, method, margs) -> {
            if (method.getName().equals("getConnection")) {
                borrowedCount.incrementAndGet();
                return proxyConn;
            }
            if (method.getName().equals("close")) {
                dsClosed.set(true);
                return null;
            }
            return defaultValue(method.getReturnType());
        };

        DataSource proxyDs = (DataSource) Proxy.newProxyInstance(
            Db.class.getClassLoader(),
            new Class<?>[]{DataSource.class, AutoCloseable.class},
            dsHandler
        );

        Db pooledDb;
        try {
            pooledDb = (Db) fromDs.invoke(null, proxyDs);
        } catch (Exception e) {
            throw new AssertionError("Db.fromDataSource invocation failed", e);
        }

        pooledDb.close();
        check(!dsClosed.get(), "closing Db must not close caller-owned DataSource");

        int prevBorrowed = borrowedCount.get();
        int prevReturned = returnedCount.get();
        pooledDb.execute("SELECT 1");
        check(borrowedCount.get() == prevBorrowed + 1, "pooled execute must borrow connection from DataSource");
        check(returnedCount.get() == prevReturned + 1, "pooled execute must return connection to pool (close it)");
        check(utcSetCount.get() > 0, "pooled borrow must initialize UTC session timezone");

        prevBorrowed = borrowedCount.get();
        prevReturned = returnedCount.get();
        pooledDb.transaction(tx -> "success");
        check(borrowedCount.get() == prevBorrowed + 1, "pooled transaction must borrow connection");
        check(returnedCount.get() == prevReturned + 1, "pooled transaction must return connection on success");
        check(pooledCommitCount.get() == 1, "pooled transaction must commit on success");
        check(pooledRollbackCount.get() == 0, "pooled transaction must not rollback on success");

        // Pooled execute failure: connection must be returned to pool
        prevBorrowed = borrowedCount.get();
        prevReturned = returnedCount.get();
        try {
            pooledDb.execute("FAIL SQL");
            throw new AssertionError("pooled execute should throw on SQL error");
        } catch (Db.Failure expected) {
            checks++;
        }
        check(borrowedCount.get() == prevBorrowed + 1, "failed pooled execute must borrow connection");
        check(returnedCount.get() == prevReturned + 1, "failed pooled execute must return connection to pool");

        // Pooled transaction failure: connection must be returned to pool
        prevBorrowed = borrowedCount.get();
        prevReturned = returnedCount.get();
        try {
            pooledDb.transaction(tx -> { throw new IllegalStateException("simulated failure inside pooled transaction"); });
            throw new AssertionError("pooled transaction should throw on work failure");
        } catch (IllegalStateException expected) {
            checks++;
        }
        check(borrowedCount.get() == prevBorrowed + 1, "failed pooled transaction must borrow connection");
        check(returnedCount.get() == prevReturned + 1, "failed pooled transaction must return connection to pool");
        check(pooledCommitCount.get() == 1, "failed pooled transaction must not commit");
        check(pooledRollbackCount.get() == 1, "failed pooled transaction must rollback");

        // UTC initialization failure: connection must be closed immediately and not leaked
        AtomicBoolean utcFailConnClosed = new AtomicBoolean(false);
        AtomicBoolean closeShouldThrow = new AtomicBoolean(false);
        InvocationHandler utcFailConnHandler = (proxy, method, margs) -> {
            String name = method.getName();
            if (name.equals("close")) {
                utcFailConnClosed.set(true);
                if (closeShouldThrow.get()) throw new SQLException("simulated close error");
                return null;
            }
            if (name.equals("createStatement")) {
                InvocationHandler stmtHandler = (sProxy, sMethod, sArgs) -> {
                    if (sMethod.getName().equals("execute")) throw new SQLException("simulated UTC init error");
                    if (sMethod.getName().equals("close")) return null;
                    return defaultValue(sMethod.getReturnType());
                };
                return Proxy.newProxyInstance(Db.class.getClassLoader(), new Class<?>[]{Statement.class}, stmtHandler);
            }
            if (name.equals("isClosed")) return utcFailConnClosed.get();
            return defaultValue(method.getReturnType());
        };
        Connection utcFailConn = (Connection) Proxy.newProxyInstance(
            Db.class.getClassLoader(), new Class<?>[]{Connection.class}, utcFailConnHandler);
        DataSource utcFailDs = (DataSource) Proxy.newProxyInstance(
            Db.class.getClassLoader(), new Class<?>[]{DataSource.class},
            (proxy, method, margs) -> method.getName().equals("getConnection") ? utcFailConn : defaultValue(method.getReturnType()));
        Db utcFailDb = Db.fromDataSource(utcFailDs);
        try {
            utcFailDb.execute("SELECT 1");
            throw new AssertionError("execute on failing UTC initialization must throw");
        } catch (Db.Failure expected) {
            checks++;
        }
        check(utcFailConnClosed.get(), "connection must be closed when UTC initialization fails");

        // UTC failure when Connection.close also throws: primary UTC exception retained as cause, close error suppressed
        utcFailConnClosed.set(false);
        closeShouldThrow.set(true);
        try {
            utcFailDb.execute("SELECT 1");
            throw new AssertionError("execute on failing UTC initialization with failing close must throw");
        } catch (Db.Failure expected) {
            Throwable cause = expected.getCause();
            check(cause instanceof SQLException && "simulated UTC init error".equals(cause.getMessage()),
                "Db.Failure must retain original UTC initialization exception as cause");
            check(cause.getSuppressed().length == 1 && "simulated close error".equals(cause.getSuppressed()[0].getMessage()),
                "close error must be added as suppressed exception on the primary UTC cause");
            checks++;
        }
        check(utcFailConnClosed.get(), "close was invoked even when close throws");

        AtomicBoolean callerConnClosed = new AtomicBoolean(false);
        AtomicBoolean callerConnCommitted = new AtomicBoolean(false);
        AtomicBoolean callerConnRolledBack = new AtomicBoolean(false);

        InvocationHandler callerConnHandler = (proxy, method, margs) -> {
            String name = method.getName();
            if (name.equals("close")) { callerConnClosed.set(true); return null; }
            if (name.equals("commit")) { callerConnCommitted.set(true); return null; }
            if (name.equals("rollback")) { callerConnRolledBack.set(true); return null; }
            if (name.equals("isClosed")) return callerConnClosed.get();
            return defaultValue(method.getReturnType());
        };

        Connection callerConn = (Connection) Proxy.newProxyInstance(
            Db.class.getClassLoader(),
            new Class<?>[]{Connection.class},
            callerConnHandler
        );

        Db callerDb = Db.on(callerConn);
        try {
            callerDb.transaction(tx -> {
                throw new IllegalStateException("simulated failure inside caller-owned transaction");
            });
            throw new AssertionError("Transaction should have thrown");
        } catch (IllegalStateException expected) {
            checks++;
        }

        check(!callerConnClosed.get(), "borrowed connection must NOT be closed by Db.on transaction rollback");
        check(!callerConnCommitted.get(), "borrowed connection must NOT be committed by Db.on transaction");
        check(!callerConnRolledBack.get(), "borrowed connection must NOT be rolled back by Db.on (caller owns rollback)");
    }
}
