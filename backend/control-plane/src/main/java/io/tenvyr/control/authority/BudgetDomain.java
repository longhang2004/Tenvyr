package io.tenvyr.control.authority;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import java.math.BigInteger;
import java.util.*;

/** Canonical integer units: commits record work, reserves/releases move availability. */
public final class BudgetDomain {
    public static final long MAX=9_007_199_254_740_991L;
    public static final List<String> DIMENSIONS=List.of("currency_micros","tokens","wall_time_ms");
    private BudgetDomain() {}
    public static String dimension(String d) { if(!DIMENSIONS.contains(d)) throw error("DIMENSION_UNKNOWN","Unknown budget dimension"); return d; }
    public static long amount(String d,JsonNode n) { dimension(d); return integer(n,false,"AMOUNT_INVALID"); }
    public static long delta(String d,JsonNode n) { dimension(d); return integer(n,true,"DELTA_INVALID"); }
    private static long integer(JsonNode n,boolean signed,String code) {
        if(n==null||!n.isNumber()||!Double.isFinite(n.doubleValue())||n.decimalValue().stripTrailingZeros().scale()>0||(!signed&&n.decimalValue().signum()<1)||n.decimalValue().signum()==0) throw error(code,"Budget amount must be a canonical non-zero integer");
        if(n.decimalValue().abs().compareTo(java.math.BigDecimal.valueOf(MAX))>0) throw error("AMOUNT_OVERFLOW","Budget amount exceeds safe integer bound");
        return n.longValue();
    }
    public static String source(JsonNode n) { String v=n==null||n.isNull()?"unknown":n.asText(); if(!List.of("actual","estimated","unknown").contains(v)) throw error("CONFIDENCE_INVALID","Invalid usage source"); return v; }
    public static JsonNode confidence(JsonNode n) { if(n==null||n.isNull()) return NullNode.instance; if(!n.isNumber()||n.doubleValue()!=n.intValue()||n.intValue()<0||n.intValue()>100) throw error("CONFIDENCE_INVALID","Confidence must be an integer between 0 and 100"); return n.deepCopy(); }
    public static JsonNode evidence(JsonNode n) { if(n==null||n.isNull()) return NullNode.instance; if(!n.isObject()||Json.stringify(n).getBytes(java.nio.charset.StandardCharsets.UTF_8).length>4096) throw error("EVIDENCE_TOO_LARGE","Evidence must be a bounded object"); return n.deepCopy(); }
    public static ObjectNode ceilings(JsonNode n) { if(n==null||!n.isObject()||n.size()==0) throw error("DIMENSION_MISSING","At least one ceiling dimension is required"); ObjectNode o=Json.object(); n.fields().forEachRemaining(e->o.put(dimension(e.getKey()),amount(e.getKey(),e.getValue()))); return o; }
    public static JsonNode stepBudget(JsonNode n) { return n==null||n.isNull()?NullNode.instance:ceilings(n); }
    public static JsonNode pipelineBudget(JsonNode n) {
        if(n==null||n.isNull()) return NullNode.instance; if(!n.isObject()) throw error("INPUT_INVALID","Pipeline budget must be an object");
        ObjectNode out=Json.object(); JsonNode p=n.get("parent"); if(p!=null&&!p.isNull()) { if(!p.isObject()) throw error("INPUT_INVALID","Budget parent must be an object"); out.set("parent",Json.object("scopeType",bounded(p.get("scopeType"),32,"scopeType"),"scopeId",bounded(p.get("scopeId"),255,"scopeId"))); }
        JsonNode c=n.get("ceilings"); if(c==null||!c.isObject()) { ObjectNode flat=n.deepCopy(); flat.remove("parent"); c=flat; }
        out.set("ceilings",ceilings(c)); return out;
    }
    public static String bounded(JsonNode n,int max,String field) { if(n==null||!n.isTextual()||n.textValue().trim().isEmpty()||n.textValue().length()>max) throw error("INPUT_INVALID",field+" must be a bounded non-empty string"); return n.textValue(); }
    public static long available(JsonNode ceilings,Iterable<? extends JsonNode> facts,String dimension) {
        dimension(dimension); BigInteger sum=BigInteger.valueOf(Json.longValue(ceilings,dimension,0));
        for(JsonNode f:facts) if(dimension.equals(Json.text(f,"dimension"))) { long a=Json.longValue(f,"amount",0); sum=switch(Json.text(f,"operation","")) {case "reserve"->sum.subtract(BigInteger.valueOf(a));case "release"->sum.add(BigInteger.valueOf(a));case "adjust"->sum.add(BigInteger.valueOf(Json.longValue(f,"delta",0)));default->sum;}; }
        if(sum.signum()<0) throw error("AVAILABILITY_NEGATIVE","Budget ledger availability is negative"); if(sum.compareTo(BigInteger.valueOf(MAX))>0) throw error("AMOUNT_OVERFLOW","Budget ledger availability exceeds safe integer bound"); return sum.longValueExact();
    }
    public static ObjectNode projectAll(JsonNode ceilings,List<? extends JsonNode> facts) { Set<String> ds=new LinkedHashSet<>(Json.keys(ceilings)); facts.forEach(f->ds.add(Json.text(f,"dimension"))); ObjectNode out=Json.object(); ds.forEach(d->out.put(d,available(ceilings,facts,d))); return out; }
    public static String reservationKey(String e,String s,int attempt,String d) { return e+":"+s+":"+attempt+":"+dimension(d); }
    public static ArrayNode usage(JsonNode n) {
        ArrayNode out=Json.array(); if(n==null||n.isNull()) return out; if(!n.isObject()) throw error("AMOUNT_INVALID","Result usage must be an object");
        if(n.hasNonNull("totalTokens")) out.add(Json.object("dimension","tokens","amount",amount("tokens",n.get("totalTokens")),"source","actual"));
        if(n.hasNonNull("costUsd")) { JsonNode v=n.get("costUsd"); if(!v.isNumber()||!Double.isFinite(v.doubleValue())||v.doubleValue()<0) throw error("AMOUNT_INVALID","costUsd must be non-negative and finite"); double micros=Math.floor(v.doubleValue()*1_000_000+0.5); out.add(Json.object("dimension","currency_micros","amount",amount("currency_micros",Json.value(micros)),"source","estimated")); }
        return out;
    }
    private static AuthorityError error(String c,String m) { return new AuthorityError(c,m); }
}
