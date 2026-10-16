package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.*;
import io.tenvyr.control.authority.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Executable regression cases translated from the original engine/authority production tests. */
public final class EngineCheck {
    private static int checks;
    private static void check(boolean value,String label){checks++;if(!value)throw new AssertionError(label);}
    private static void rejects(Runnable action,String label){checks++;try{action.run();}catch(RuntimeException expected){return;}throw new AssertionError(label);}
    private static ObjectNode capsule(String id,JsonNode steps,JsonNode attempts){return Json.object("executionId",id,"schemaVersion","1","capturedAt","2026-10-14T00:00:00Z","contentHash","","pointInTime","terminal","sourceStatus","CANCELLED","header",Json.object("policy",Json.object("snapshotVersion","1","snapshotHash","a".repeat(64)),"delegation",Json.object("observed",0)),"revisions",Json.array(Json.object("steps",steps.deepCopy())),"attempts",attempts.deepCopy(),"evidenceCompleteness",Json.array());}
    public static void main(String[] args)throws Exception{
        Conditions conditions=new Conditions();ObjectNode context=Templates.context(Json.object("n",5,"nil",null,"array",Json.array(3,4)),List.of(Json.object("stepId","first","output",Json.object("score",9),"status","COMPLETED","attempt",1,"error",null)));
        check(conditions.evaluate(conditions.compile(Json.value("{{ steps.first.result.score >= 8 }}")),context),"legacy comparison");
        check(!conditions.evaluate(conditions.compile(Json.object("op","eq","left",Json.object("ref","pipeline.input.n"),"right","5")),context),"strict types");
        check(conditions.evaluate(conditions.compile(Json.object("op","exists","value",Json.object("ref","pipeline.input.nil"))),context),"null exists");
        check(conditions.evaluate(conditions.compile(Json.object("op","exists","value",Json.object("ref","steps.first.error"))),context),"explicit null step error");
        check(!conditions.evaluate(conditions.compile(Json.object("op","exists","value",Json.object("ref","pipeline.input.absent"))),context),"missing distinct from null");
        check(conditions.evaluate(conditions.compile(Json.object("op","in","value",4,"values",Json.object("ref","pipeline.input.array"))),context),"reference membership");
        rejects(()->conditions.compile(Json.value("process.exit(1)")),"executable expression rejected");
        check(Templates.resolve(Json.value("{{steps.first.result}}"),context).isObject(),"whole template preserves object");
        check(Templates.resolve(Json.value("{{pipeline.input.array.1}}"),context).intValue()==4,"template array path");
        check(Templates.resolve(Json.value("score={{steps.first.result.score}}; missing={{pipeline.input.absent}}"),context).asText().equals("score=9; missing="),"embedded values");
        check(Templates.resolve(Json.value("{{pipeline.input.absent}}"),context).isNull(),"missing exact template null");
        check(Templates.durationMs(Json.value("1.5m"))==90000,"duration units");
        check(Templates.durationMs(Json.value("-1s"))==0,"duration rejected");
        ObjectNode plan=Json.object("steps",Json.array(Json.object("id","first","onFailure","continue"),Json.object("id","next","dependsOn",Json.array("first"))));
        check(EngineFacts.dependenciesResolved(plan.path("steps").get(1),List.of(Json.object("stepId","first","status","FAILED")),plan),"continue releases dependency");
        check(!EngineFacts.dependenciesResolved(plan.path("steps").get(1),List.of(Json.object("stepId","first","status","CANCELLED")),plan),"cancel does not release dependency");
        check(EngineFacts.maxAttempts(Json.object("retries",2))==3,"retry count");
        TransportIdentity identity=TransportIdentity.of(Json.object("adapter","kafka","topic","t".repeat(260),"partition",2,"offset","17"));
        check(identity.scope().equals("kafka-sha256:"+Json.sha256("t".repeat(260)+":2")),"long durable Kafka scope");
        check(!identity.scope().equals(TransportIdentity.of(Json.object("adapter","kafka","topic","t".repeat(260),"partition",3,"offset","17")).scope()),"partition isolation");
        rejects(()->TransportIdentity.of(Json.object("adapter","http","keyId","k","deliveryId","x".repeat(256))),"durable delivery bound");

        check(BudgetDomain.available(Json.object("tokens",100),List.of(Json.object("dimension","tokens","operation","reserve","amount",50),Json.object("dimension","tokens","operation","commit","amount",20),Json.object("dimension","tokens","operation","release","amount",30)),"tokens")==80,"commit evidence never double-debits");
        check(BudgetDomain.usage(null).isEmpty(),"missing usage stays unknown");
        check(BudgetDomain.usage(Json.object("totalTokens",40,"costUsd",0.000003)).path(1).path("amount").longValue()==3,"currency micros");
        rejects(()->BudgetDomain.usage(Json.object("totalTokens",-1)),"negative usage rejected");
        rejects(()->BudgetDomain.usage(Json.object("costUsd",0)),"zero rounded currency rejected");
        rejects(()->BudgetDomain.amount("tokens",Json.value(1.5)),"fractional tokens rejected");
        rejects(()->BudgetDomain.available(Json.object("tokens",10),List.of(Json.object("dimension","tokens","operation","reserve","amount",11)),"tokens"),"overspend rejected");
        check(BudgetDomain.pipelineBudget(Json.object("tokens",100)).equals(BudgetDomain.pipelineBudget(Json.object("ceilings",Json.object("tokens",100)))),"budget envelope roundtrip");
        JsonNode mappings=StateWritesDomain.validate(Json.array(Json.object("key","answer","fromOutput","/a~1b/0")));
        check(StateWritesDomain.patch(Json.object("a/b",Json.array((Object)null)),mappings).path("set").path("answer").isNull(),"pointer null preserved");
        rejects(()->StateWritesDomain.patch(Json.object(),mappings),"missing pointer rejected");
        rejects(()->StateWritesDomain.pointer("/items/-"),"append pointer rejected");
        rejects(()->StateWritesDomain.pointer("/bad~2"),"invalid pointer escape rejected");
        ObjectNode patch=PlanPatchDomain.parse(Json.object("schemaVersion",1,"baseRevision",1,"operations",Json.array(Json.object("op","replaceUnfrozenStep","stepId","first","step",Json.object("id","first","agent","new")))));
        rejects(()->PlanPatchDomain.apply(plan.path("steps"),Set.of("first"),patch),"started step frozen");
        check(PlanPatchDomain.apply(plan.path("steps"),Set.of(),patch).path(0).path("agent").asText().equals("new"),"unstarted replacement");
        ObjectNode policy=PolicyDomain.snapshot(Json.object("version",1,"rules",Json.array(Json.object("id","review","actionType","dispatch","effect","DENY","agents",Json.array("reviewer")),Json.object("id","approve","actionType","dispatch","effect","REQUIRE_APPROVAL"))));
        check(PolicyDomain.evaluate(PolicyDomain.dispatch("i","e","s",1,"reviewer","http"),policy).path("effect").asText().equals("DENY"),"policy first matching rule");
        check(PolicyDomain.evaluate(PolicyDomain.dispatch("i","e","s",1,"writer","http"),policy).path("effect").asText().equals("REQUIRE_APPROVAL"),"policy approval rule");
        check(PolicyDomain.evaluate(PolicyDomain.planPatch("p","e"),policy).path("effect").asText().equals("ALLOW"),"unmatched default allow");
        JsonNode envelope=ContextDomain.materialize(Json.object("stateKeys",Json.array("selected")),Json.object("selected",5,"hidden","private"),7,Json.array());
        check(envelope.path("tenvyr").path("executionState").path("values").size()==1,"context selected keys only");
        rejects(()->ContextDomain.materialize(Json.object("stateKeys",Json.array("missing")),Json.object(),0,Json.array()),"missing projected state fails closed");
        ObjectNode evidence=ContextDomain.claimEvidence(Json.object("invocationId","i","harness",Json.object("agent","a","executorKind","http","configHash","a".repeat(64)),"dispatchable",true,"startedAt","2026-10-14T00:00:00Z"));
        ObjectNode completed=ContextDomain.complete(evidence,Json.object("inputTokens",4,"cachedInputTokens",2),"2026-10-14T00:00:01Z","2026-10-14T00:00:00Z");
        check(ContextDomain.parseEfficiency(completed).path("timing").path("durationMs").longValue()==1000,"efficiency duration");
        check(completed.path("usage").path("cachedInputTokens").intValue()==2,"observed cache tokens");
        check(!evidence.path("usage").path("reported").asBoolean(),"claim evidence immutable");

        ArrayNode steps=Json.array(Json.object("id","first","agent","reader"));ObjectNode a=capsule("a",steps,Json.array(Json.object("stepId","first","status","SUCCESS"))),b=capsule("b",steps,Json.array(Json.object("stepId","first","status","SUCCESS")));
        String hash=ExecutionCapsuleService.contentHash(a);a.put("capturedAt","different");((ObjectNode)a.path("header").path("policy")).put("snapshotVersion","2");
        check(hash.equals(ExecutionCapsuleService.contentHash(a)),"capsule hash excludes volatile capture/global policy");
        ObjectNode comparison=ExecutionCapsuleService.compareCapsules(a,b);check(comparison.path("plan").path("identical").asBoolean()&&comparison.path("outcome").path("identical").asBoolean(),"identical stable step evidence");
        ((ObjectNode)b.path("revisions").path(0).path("steps").path(0)).put("agent","writer");check(!ExecutionCapsuleService.compareCapsules(a,b).path("plan").path("identical").asBoolean(),"step specification drift");
        ((ArrayNode)b.get("evidenceCompleteness")).add("Attempts truncated to 100 of 101");check(ExecutionCapsuleService.compareCapsules(a,b).path("outcome").path("unavailable").asBoolean(),"truncated outcome unavailable");
        b.put("pointInTime","live");check(ExecutionCapsuleService.compareCapsules(a,b).path("warnings").toString().contains("LIVE capture"),"live source warning");

        Map<String,String> env=Map.of("HTTP_AGENT_ALLOW_INSECURE","true","HTTP_AGENT_CALLBACK_BASE_URL","http://127.0.0.1:3001","SECRET","secret","AGENT_TRANSPORT_CONFIG",Json.stringify(Json.object("http-agent",Json.object("kind","http","submitUrl","http://127.0.0.1:8080/v1/runs","outboundAuthentication",Json.object("type","none"),"callbackAuthentication",Json.object("keyId","key","secretEnv","SECRET"),"requestTimeoutMs",1000,"maxResponseBytes",4096))));
        AgentTransportConfig transport=new AgentTransportConfig(env);ObjectNode descriptor=transport.descriptor("http-agent");check(!Json.stringify(descriptor).contains("secret"),"executor snapshot secret free");check(transport.frozenDescriptor(descriptor).equals(descriptor),"descriptor roundtrip");ObjectNode invalid=descriptor.deepCopy();invalid.set("localProfile",Json.object("command","/bin/echo","args",Json.array(),"secrets",Json.object("TOKEN","literal secret")));rejects(()->transport.frozenDescriptor(invalid),"persisted secret references strict");
        rejects(()->new AgentTransportConfig(Map.of("HTTP_AGENT_CALLBACK_MAX_SKEW_SECONDS","300","HTTP_AGENT_REPLAY_TTL_MS","1")),"replay ttl covers clock skew");
        AtomicInteger results=new AtomicInteger(),events=new AtomicInteger();HttpAgentAdapter http=new HttpAgentAdapter(transport);http.start(new AgentAdapter.Handlers(){public void result(ObjectNode value,ObjectNode source){if(results.getAndIncrement()==0)throw new IllegalStateException("transient durable failure");}public void event(ObjectNode value,ObjectNode source){events.incrementAndGet();}});
        try{long now=Instant.parse("2026-10-14T00:00:00Z").toEpochMilli();String timestamp=Long.toString(now/1000);byte[] raw=Json.stringify(Json.object("schemaVersion","1","invocationId","invocation:1","executionId","execution","stepExecutionId","step","status","succeeded","output",Json.object("ok",true),"completedAt","2026-10-14T00:00:00.000Z")).getBytes(StandardCharsets.UTF_8);String signature=HttpAgentAdapter.signature("secret",timestamp,"delivery",raw);
            rejects(()->HttpAgentAdapter.verify("secret",timestamp,"delivery",signature,"{}".getBytes(StandardCharsets.UTF_8),300,now),"HMAC exact raw bytes");
            try{http.handleCallback("http-agent","key",timestamp,"delivery",signature,raw,"127.0.0.1",now);throw new AssertionError("handler failure expected");}catch(IllegalStateException expected){}
            check(http.handleCallback("http-agent","key",timestamp,"delivery",signature,raw,"127.0.0.1",now).equals("processed"),"failure rolls replay entry back");
            check(http.handleCallback("http-agent","key",timestamp,"delivery",signature,raw,"127.0.0.1",now).equals("duplicate"),"completed replay suppressed");check(results.get()==2,"only durable handler retries");
            rejects(()->HttpAgentAdapter.verify("secret",timestamp,"delivery",signature,raw,300,now+301000),"expired signature rejected");
        }finally{http.close();}
        Instant start=Instant.parse("2026-10-14T00:00:00Z");ObjectNode attempt=Json.object("invocationId","i","executionId","e","logicalStepId","s","status","DISPATCHED","executorSnapshot",Json.object("agent","reader"),"dispatchedAt",start.toString());Map<String,SupervisionService.Expectation> expectations=Map.of("reader",new SupervisionService.Expectation(true,30000,30000));
        check(SupervisionService.syntheticResult(attempt,expectations,start.plusMillis(29999))==null,"supervision before grace");ObjectNode timed=SupervisionService.syntheticResult(attempt,expectations,start.plusSeconds(31));check(timed.path("error").path("code").asText().equals("AGENT_ACCEPTANCE_TIMEOUT"),"acceptance timeout");check(timed.equals(SupervisionService.syntheticResult(attempt,expectations,start.plusSeconds(60))),"synthetic timeout deterministic across replicas");
        attempt.put("status","RUNNING");attempt.put("startTime",start.toString());attempt.put("lastProgressReceivedAt",start.plusSeconds(29).toString());check(SupervisionService.syntheticResult(attempt,expectations,start.plusSeconds(31)).path("error").path("code").asText().equals("AGENT_HEARTBEAT_STALE"),"progress never substitutes heartbeat");
        System.out.println("EngineCheck: "+checks+" checks passed");
    }
}
