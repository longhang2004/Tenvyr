package io.tenvyr.control.authority;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import java.util.*;

public final class PlanPatchDomain {
    private PlanPatchDomain() {}
    public static ObjectNode parse(JsonNode n) {
        if(n==null||!n.isObject()||!n.path("schemaVersion").isNumber()||n.path("schemaVersion").doubleValue()!=1)throw error("INVALID_PATCH","PlanPatch schemaVersion must be 1"); JsonNode revision=n.get("baseRevision");
        if(revision==null||!revision.isNumber()||revision.doubleValue()!=revision.longValue()||revision.longValue()<1||revision.longValue()>Integer.MAX_VALUE)throw error("BASE_REVISION_INVALID","baseRevision must be a bounded positive integer");
        if(Json.stringify(n).getBytes(java.nio.charset.StandardCharsets.UTF_8).length>65536)throw error("PATCH_TOO_LARGE","PlanPatch exceeds 65536 serialized bytes"); JsonNode ops=n.get("operations"); if(ops==null||!ops.isArray()||ops.size()==0)throw error("INVALID_PATCH","PlanPatch must contain operations");if(ops.size()>20)throw error("TOO_MANY_OPERATIONS","PlanPatch exceeds 20 operations");ArrayNode parsed=Json.array();
        for(JsonNode op:ops) { if(!op.isObject()||!op.path("step").isObject())throw error("INVALID_OPERATION","Patch operations require an object step");String type=Json.text(op,"op");if("addStep".equals(type))parsed.add(Json.object("op",type,"step",op.get("step").deepCopy()));else if("replaceUnfrozenStep".equals(type)) {JsonNode id=op.get("stepId");if(id==null||!id.isTextual()||id.asText().isEmpty()||id.asText().length()>100||!id.equals(op.path("step").get("id")))throw error("INVALID_OPERATION","Replacement id must equal step.id");parsed.add(Json.object("op",type,"stepId",id,"step",op.get("step").deepCopy()));}else throw error("INVALID_OPERATION","Unknown patch operation"); }
        return Json.object("schemaVersion",1,"baseRevision",revision,"operations",parsed);
    }
    public static ArrayNode apply(JsonNode base,Set<String> frozen,JsonNode patch) {ArrayNode candidate=(ArrayNode)base.deepCopy();for(JsonNode op:patch.path("operations")) {if("addStep".equals(Json.text(op,"op")))candidate.add(op.get("step").deepCopy());else {String id=Json.text(op,"stepId");int index=-1;for(int i=0;i<candidate.size();i++)if(id.equals(Json.text(candidate.get(i),"id"))){index=i;break;}if(index<0)throw error("TARGET_NOT_FOUND","Replacement target does not exist");if(frozen.contains(id))throw error("TARGET_FROZEN","Replacement target is frozen");candidate.set(index,op.get("step").deepCopy());}}return candidate;}
    private static AuthorityError error(String c,String m){return new AuthorityError(c,m);}
}
