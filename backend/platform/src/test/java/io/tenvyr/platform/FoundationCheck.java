package io.tenvyr.platform;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.domain.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

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
        if(args.length>1){JsonNode vectors=Json.parse(Files.readString(Path.of(args[1])));int failures=0;for(JsonNode vector:vectors){String actual=Json.canonical(vector.get("value")),expected=vector.path("canonical").asText();if(!actual.equals(expected)){failures++;if(failures<=12)System.err.println("Canonical mismatch "+vector.path("name").asText()+": expected "+expected+" actual "+actual);}else checks++;}check(failures==0,"canonical Node golden failures: "+failures);}
        System.out.println("FoundationCheck: "+checks+" checks passed");
    }
}
