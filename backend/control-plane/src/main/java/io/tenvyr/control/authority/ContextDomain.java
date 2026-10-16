package io.tenvyr.control.authority;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.domain.ExecutionState;
import java.time.Instant;
import java.util.*;

/** Immutable context materialization, deterministic provenance and bounded efficiency evidence. */
public final class ContextDomain {
    private ContextDomain() {}
    public static ObjectNode validateProjection(JsonNode n) {
        object(n,"contextProjection");only(n,List.of("stateKeys","artifacts"),"contextProjection");JsonNode ks=n.get("stateKeys");if(ks==null||!ks.isArray()||ks.size()>128)throw invalid("stateKeys must be a bounded array");Set<String> seen=new HashSet<>();ArrayNode keys=Json.array();for(JsonNode k:ks){if(!k.isTextual())throw invalid("stateKeys entries must be strings");ExecutionState.validateStateKey(k.textValue());if(!seen.add(k.textValue()))throw invalid("Duplicate state key");keys.add(k.textValue());}ObjectNode out=Json.object("stateKeys",keys);if(n.has("artifacts"))out.set("artifacts",validateSelectors(n.get("artifacts")));if(keys.size()==0&&!out.has("artifacts"))throw invalid("Projection must select state or artifacts");return out;
    }
    public static ArrayNode validateSelectors(JsonNode n) {
        if(n==null||!n.isArray()||n.size()==0||n.size()>128)throw invalid("artifacts must have 1-128 selectors");ArrayNode out=Json.array();Set<String> seen=new HashSet<>();for(JsonNode s:n){object(s,"artifact selector");only(s,List.of("fromStep","name","ordinal","includeMetadata"),"artifact selector");JsonNode step=s.get("fromStep");if(step==null||!step.isTextual()||step.textValue().trim().isEmpty())throw invalid("fromStep must be non-empty");ObjectNode item=Json.object("fromStep",step);if(s.has("name")){if(!s.get("name").isTextual())throw invalid("Artifact name must be string");item.set("name",s.get("name"));}if(s.has("ordinal")){JsonNode v=s.get("ordinal");if(!v.isNumber()||v.doubleValue()!=v.longValue()||v.longValue()<0)throw invalid("Artifact ordinal must be non-negative integer");item.set("ordinal",v);}if(s.has("name")&&s.has("ordinal"))throw invalid("name and ordinal are mutually exclusive");if(s.has("includeMetadata")){if(!s.get("includeMetadata").isBoolean())throw invalid("includeMetadata must be boolean");item.set("includeMetadata",s.get("includeMetadata"));}if(!seen.add(Json.canonical(item)))throw invalid("Duplicate selector");out.add(item);}return out;
    }
    public static ObjectNode select(JsonNode projection,JsonNode state) {
        ObjectNode p;try{p=validateProjection(projection);}catch(RuntimeException e){throw failure("TENVYR_CTX_INVALID_PROJECTION");}ObjectNode out=Json.object();List<String> keys=new ArrayList<>();p.get("stateKeys").forEach(k->keys.add(k.textValue()));Collections.sort(keys);for(String key:keys){if(state==null||!state.has(key))throw failure("TENVYR_CTX_MISSING_STATE_KEY");out.set(key,state.get(key).deepCopy());}return out;
    }
    public static ObjectNode materialize(JsonNode p,JsonNode state,int version,JsonNode artifacts) {
        ObjectNode e=Json.object("tenvyr",Json.object("schemaVersion",1,"executionState",Json.object("version",version,"values",select(p,state)),"artifacts",artifacts==null?Json.array():artifacts.deepCopy()));int bytes;try{bytes=ExecutionState.jsonValueUtf8Size(e);}catch(RuntimeException x){throw failure("TENVYR_CTX_UNSAFE_VALUE");}if(bytes>65536)throw failure("TENVYR_CTX_ENVELOPE_TOO_LARGE");return e;
    }
    public static ObjectNode workspaceIdentity(JsonNode w) {return Json.object("workspaceId",w.get("workspaceId"),"branch",Json.get(w,"branch"),"headSha",Json.get(w,"headSha"),"dirty",Json.get(w,"dirty"));}
    public static ObjectNode metrics(JsonNode envelope,JsonNode fullState) {JsonNode t=envelope.path("tenvyr");return Json.object("projectedBytes",ExecutionState.jsonValueUtf8Size(envelope),"projectedCharacters",Json.canonical(envelope).length(),"selectedContextItemCount",t.path("executionState").path("values").size(),"selectedArtifactCount",t.path("artifacts").size(),"executionStateBytes",ExecutionState.jsonValueUtf8Size(fullState==null?Json.object():fullState));}
    public static ObjectNode claimEvidence(JsonNode input) {
        ObjectNode e=Json.object("schemaVersion",1,"invocationId",input.get("invocationId"),"contextBundle",Json.get(input,"contextBundle"),"harness",input.get("harness").deepCopy(),"context",Json.get(input,"context"),"session",Json.object("mode",Json.bool(input,"dispatchable",false)?"fresh":"unknown"),"usage",Json.object("reported",false),"timing",Json.object("startedAt",input.get("startedAt"),"completedAt",null,"durationMs",null));if(input.has("workspace"))e.set("workspace",input.get("workspace").deepCopy());return e;
    }
    public static ObjectNode reportedUsage(JsonNode usage) {ObjectNode out=Json.object("reported",usage!=null&&!usage.isNull()&&(usage.isObject()||usage.isArray()));if(usage==null||!usage.isObject())return out;for(String k:List.of("inputTokens","outputTokens","cachedInputTokens","cacheWriteTokens")){JsonNode n=usage.get(k);if(n!=null&&safeInteger(n))out.set(k,n.deepCopy());}return out;}
    public static ObjectNode complete(JsonNode e,JsonNode usage,String completed,String started) {ObjectNode out=(ObjectNode)e.deepCopy();out.set("usage",reportedUsage(usage));out.set("timing",Json.object("startedAt",started,"completedAt",completed,"durationMs",Math.max(0,Instant.parse(completed).toEpochMilli()-Instant.parse(started).toEpochMilli())));return out;}
    public static ObjectNode parseEfficiency(JsonNode n) {
        object(n,"Efficiency evidence");only(n,List.of("schemaVersion","invocationId","contextBundle","harness","workspace","context","session","usage","timing"),"Efficiency evidence");if(!n.path("schemaVersion").isNumber()||n.path("schemaVersion").doubleValue()!=1)throw invalid("Unsupported efficiency version");text(n.get("invocationId"),255,false);
        JsonNode h=n.get("harness");object(h,"harness");only(h,List.of("agent","executorKind","configHash","connectionId","connectionRevision","requestedModelId"),"harness");text(h.get("agent"),255,false);text(h.get("executorKind"),32,false);text(h.get("configHash"),64,false);if(h.has("connectionId"))text(h.get("connectionId"),255,false);if(h.has("connectionRevision"))integer(h.get("connectionRevision"));if(h.has("requestedModelId"))text(h.get("requestedModelId"),256,false);
        JsonNode b=n.get("contextBundle");if(b!=null&&!b.isNull()){object(b,"contextBundle");only(b,List.of("hash","reused"),"contextBundle");text(b.get("hash"),64,false);if(!b.path("hash").asText().matches("[0-9a-f]{64}")||!b.path("reused").isBoolean())throw invalid("Invalid bundle identity");}
        JsonNode w=n.get("workspace");if(w!=null){object(w,"workspace");only(w,List.of("workspaceId","branch","headSha","dirty"),"workspace");text(w.get("workspaceId"),255,false);nullableText(w.get("branch"),255);nullableText(w.get("headSha"),64);if(w.hasNonNull("dirty")&&!w.get("dirty").isBoolean())throw invalid("Invalid workspace dirty");}
        JsonNode c=n.get("context");if(c!=null&&!c.isNull()){object(c,"context");List<String> ks=List.of("projectedBytes","projectedCharacters","selectedContextItemCount","selectedArtifactCount","executionStateBytes");only(c,ks,"context");ks.forEach(k->integer(c.get(k)));}
        JsonNode s=n.get("session");object(s,"session");only(s,List.of("mode"),"session");if(!List.of("fresh","reused","resumed","unknown").contains(Json.text(s,"mode")))throw invalid("Invalid session mode");JsonNode u=n.get("usage");object(u,"usage");List<String> tokens=List.of("reported","inputTokens","outputTokens","cachedInputTokens","cacheWriteTokens");only(u,tokens,"usage");if(!u.path("reported").isBoolean())throw invalid("usage.reported must be boolean");tokens.stream().filter(k->!k.equals("reported")&&u.has(k)).forEach(k->integer(u.get(k)));
        JsonNode t=n.get("timing");object(t,"timing");only(t,List.of("startedAt","completedAt","durationMs"),"timing");text(t.get("startedAt"),64,false);nullableText(t.get("completedAt"),64);if(t.hasNonNull("durationMs"))integer(t.get("durationMs"));ObjectNode out=n.deepCopy();if(!out.has("contextBundle"))out.putNull("contextBundle");if(!out.has("context"))out.putNull("context");return out;
    }
    private static void object(JsonNode n,String f){if(n==null||!n.isObject())throw invalid(f+" must be an object");}
    private static void only(JsonNode n,List<String> keys,String f){for(String key:Json.keys(n))if(!keys.contains(key))throw invalid(f+" contains unsupported field "+key);}
    private static void text(JsonNode n,int max,boolean empty){if(n==null||!n.isTextual()||(!empty&&n.textValue().isEmpty())||n.textValue().length()>max)throw invalid("Invalid bounded evidence string");}
    private static void nullableText(JsonNode n,int max){if(n!=null&&!n.isNull())text(n,max,true);}
    private static boolean safeInteger(JsonNode n){return n.isNumber()&&Double.isFinite(n.doubleValue())&&n.doubleValue()==n.longValue()&&n.longValue()>=0&&n.longValue()<=BudgetDomain.MAX;}
    private static void integer(JsonNode n){if(n==null||!safeInteger(n))throw invalid("Evidence integer must be non-negative and safe");}
    private static IllegalArgumentException invalid(String m){return new IllegalArgumentException(m);}
    private static AuthorityError failure(String c){return new AuthorityError(c,c);}
}
