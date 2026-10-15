package io.tenvyr.control.authority;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import java.time.Instant;
import java.util.*;

public final class PolicyDomain {
    private static final List<String> ACTIONS=List.of("dispatch","plan_patch","delegate","executor_action"), EFFECTS=List.of("ALLOW","DENY","REQUIRE_APPROVAL");
    private PolicyDomain() {}
    public static ObjectNode snapshot(JsonNode n) {
        if(n==null||!n.isObject()||!n.path("version").isNumber()||n.path("version").doubleValue()!=n.path("version").longValue()||n.path("version").longValue()<1) throw error("Policy version must be a positive integer");
        JsonNode rs=n.get("rules"); if(rs==null||!rs.isArray()||rs.size()==0||rs.size()>256) throw error("Policy must have 1-256 rules"); ArrayNode rules=Json.array(),normalized=Json.array();
        int i=0; for(JsonNode r:rs) { if(!r.isObject()) throw error("Rule must be an object"); String id=string(r.get("id"),64,true),act=Json.text(r,"actionType"),effect=Json.text(r,"effect"); if(!ACTIONS.contains(act)||!EFFECTS.contains(effect)) throw error("Unsupported rule action/effect"); ObjectNode parsed=Json.object("id",id,"actionType",act,"effect",effect); ObjectNode norm=parsed.deepCopy();
            for(String field:List.of("agents","executors")) { JsonNode v=r.get(field); ArrayNode a=Json.array(); if(v!=null&&!v.isNull()) { if(!v.isArray()||v.size()>(field.equals("agents")?64:16)) throw error("Rule constraint must be a bounded array"); for(JsonNode item:v) a.add(string(item,255,true)); parsed.set(field,a); } norm.set(field,a); }
            rules.add(parsed); normalized.add(norm); i++; }
        return Json.object("version",n.get("version"),"hash",Json.hash(Json.object("version",n.get("version"),"rules",normalized)),"rules",rules);
    }
    public static ObjectNode dispatch(String id,String e,String s,int attempt,String agent,String executor) { return proposal(id,"dispatch",Json.object("executionId",string(Json.value(e),255,false),"logicalStepId",string(Json.value(s),255,false),"attemptNumber",attempt),Json.object("agent",string(Json.value(agent),255,false),"executor",string(Json.value(executor),255,false))); }
    public static ObjectNode planPatch(String id,String execution) { return proposal(id,"plan_patch",Json.object("executionId",string(Json.value(execution),255,false)),null); }
    public static ObjectNode delegation(String id,String execution,String agent) { return proposal(id,"delegate",Json.object("executionId",string(Json.value(execution),255,false)),Json.object("agent",string(Json.value(agent),255,false))); }
    private static ObjectNode proposal(String id,String type,ObjectNode scope,ObjectNode target) { string(Json.value(id),64,false); ObjectNode p=Json.object("proposalId",id,"actionType",type,"scope",scope); if(target!=null)p.set("target",target); String hash=Json.hash(p); p.put("hash",hash);p.put("createdAt",Instant.now().toString());return p; }
    public static ObjectNode evaluate(JsonNode p,JsonNode snap) { String effect="ALLOW",reason="no matching rule; default allow";
        for(JsonNode r:snap.path("rules")) { if(!Objects.equals(Json.text(r,"actionType"),Json.text(p,"actionType")))continue; if(r.has("agents")&&!contains(r.get("agents"),Json.text(p.path("target"),"agent","")))continue; if(r.has("executors")&&!contains(r.get("executors"),Json.text(p.path("target"),"executor","")))continue; effect=Json.text(r,"effect");reason="matched rule "+Json.text(r,"id");break; }
        return Json.object("decisionId",p.get("proposalId"),"proposalHash",p.get("hash"),"policyVersion",snap.get("version"),"policyHash",snap.get("hash"),"effect",effect,"reasons",Json.array(reason),"evaluatedAt",Instant.now().toString());
    }
    private static boolean contains(JsonNode a,String s) { for(JsonNode n:a)if(n.isTextual()&&n.textValue().equals(s))return true; return false; }
    private static String string(JsonNode n,int max,boolean trim) { if(n==null||!n.isTextual()||n.textValue().isEmpty()||(trim&&n.textValue().trim().isEmpty())||n.textValue().length()>max)throw error("Policy fact must be a bounded string");return n.textValue(); }
    private static AuthorityError error(String m) { return new AuthorityError("POLICY_CONFIG_INVALID",m); }
}
