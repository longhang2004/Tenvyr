package io.tenvyr.control.authority;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.domain.ExecutionState;
import java.util.*;

/** Only frozen mappings grant state-write authority; outputs never carry their own patches. */
public final class StateWritesDomain {
    private StateWritesDomain() {}
    public static ArrayNode validate(JsonNode input) {
        if(input==null||!input.isArray()||input.size()==0||input.size()>128)throw new IllegalArgumentException("stateWrites must have 1-128 mappings");Set<String> keys=new HashSet<>();ArrayNode out=Json.array();
        for(JsonNode m:input) {if(!m.isObject()||Json.keys(m).stream().anyMatch(k->!List.of("key","fromOutput").contains(k)))throw new IllegalArgumentException("stateWrites entries have unsupported fields");String key=required(m.get("key")),p=required(m.get("fromOutput"));ExecutionState.validateStateKey(key);if(!keys.add(key))throw new IllegalArgumentException("Duplicate state write key");pointer(p);out.add(Json.object("key",key,"fromOutput",p));}return out;
    }
    private static String required(JsonNode n) {if(n==null||!n.isTextual()||n.textValue().trim().isEmpty())throw new IllegalArgumentException("State mapping fields must be non-empty strings");return n.textValue();}
    public static List<String> pointer(String p) {
        if(!p.startsWith("/"))throw new IllegalArgumentException("State pointer must start with /");List<String> tokens=new ArrayList<>();
        for(String token:p.substring(1).split("/",-1)) {if(token.equals("-"))throw new IllegalArgumentException("Array append token is forbidden");StringBuilder s=new StringBuilder();for(int i=0;i<token.length();i++){char c=token.charAt(i);if(c!='~'){s.append(c);continue;}if(i+1==token.length())throw new IllegalArgumentException("Invalid JSON pointer escape");char next=token.charAt(++i);if(next=='0')s.append('~');else if(next=='1')s.append('/');else throw new IllegalArgumentException("Invalid JSON pointer escape");}tokens.add(s.toString());}return tokens;
    }
    /** Java null is missing; a NullNode is an explicitly selected JSON null. */
    public static JsonNode resolve(JsonNode root,List<String> tokens) {JsonNode n=root;for(String token:tokens) {if(n==null)return null;if(n.isArray()){if(!token.matches("0|[1-9][0-9]*"))return null;try {long idx=Long.parseLong(token);if(idx>=n.size())return null;n=n.get((int)idx);}catch(NumberFormatException e){return null;}}else if(n.isObject())n=n.get(token);else return null;}return n;}
    public static ObjectNode patch(JsonNode output,JsonNode mappings) {ObjectNode set=Json.object();for(JsonNode m:mappings){JsonNode v=resolve(output,pointer(Json.text(m,"fromOutput")));if(v==null)throw new AuthorityError("TENVYR_STATE_WRITE_POINTER_MISSING","TENVYR_STATE_WRITE_POINTER_MISSING");set.set(Json.text(m,"key"),v.deepCopy());}return Json.object("set",set);}
}
