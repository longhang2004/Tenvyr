package io.tenvyr.platform;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.time.*;
import java.time.format.DateTimeParseException;
import java.util.*;
import java.util.regex.*;

/** Draft-2020-12 validation for the exact closed v1 schemas bundled from contracts/schemas. */
public final class Protocol {
    public record Issue(String path,String message,String keyword) {}
    public static final class ValidationError extends IllegalArgumentException {
        public final String contract; public final List<Issue> issues;
        public ValidationError(String contract,List<Issue> issues){super(contract+" validation failed: "+issues.stream().map(i->i.path()+" "+i.message()).reduce((a,b)->a+"; "+b).orElse("is invalid"));this.contract=contract;this.issues=List.copyOf(issues);}
    }
    private static final Map<String,JsonNode> SCHEMAS=new LinkedHashMap<>();
    static {for(String name:List.of("agent-invocation","agent-result","agent-event","http-agent-run-request","http-agent-run-accepted")) {
        try(var in=Protocol.class.getResourceAsStream("/contracts/"+name+".v1.schema.json")){if(in==null)throw new IllegalStateException("Missing schema "+name);JsonNode schema=Json.MAPPER.readTree(in);SCHEMAS.put(schema.path("$id").asText(),schema);}catch(Exception e){throw new ExceptionInInitializerError(e);}
    }}
    private Protocol(){}
    public static ObjectNode invocation(JsonNode n){return validate("agent-invocation",n);}
    public static ObjectNode result(JsonNode n){return validate("agent-result",n);}
    public static ObjectNode event(JsonNode n){return validate("agent-event",n);}
    public static ObjectNode httpRequest(JsonNode n){return validate("http-agent-run-request",n);}
    public static ObjectNode httpAccepted(JsonNode n){return validate("http-agent-run-accepted",n);}
    public static ObjectNode parseAgentInvocation(JsonNode n){return invocation(n);}
    public static ObjectNode parseAgentResult(JsonNode n){return result(n);}
    public static ObjectNode parseAgentEvent(JsonNode n){return event(n);}
    private static ObjectNode validate(String name,JsonNode n){JsonNode root=SCHEMAS.get("urn:tenvyr:schema:"+name+":v1");String title=root.path("title").asText();List<Issue> issues=new ArrayList<>();numeric(n,"",issues);if(issues.isEmpty())schema(root,n,"",root,issues);if(!issues.isEmpty())throw new ValidationError(title,issues);return (ObjectNode)n;}
    private static String pointer(String key){return key.replace("~","~0").replace("/","~1");}
    private static void numeric(JsonNode n,String path,List<Issue> issues){
        if(n==null)return;if(n.isNumber()){double v=n.doubleValue();if(!Double.isFinite(v))issues.add(new Issue(path.isEmpty()?"/":path,"must be a finite JSON number","semantic"));else if(v==Math.rint(v)&&Math.abs(v)>9007199254740991d)issues.add(new Issue(path.isEmpty()?"/":path,"must be a safe JSON integer","semantic"));return;}
        if(n.isArray()){for(int i=0;i<n.size();i++)numeric(n.get(i),path+"/"+i,issues);}else if(n.isObject())n.fields().forEachRemaining(e->numeric(e.getValue(),path+"/"+pointer(e.getKey()),issues));
    }
    private static void issue(List<Issue> out,String path,String message,String keyword){out.add(new Issue(path.isEmpty()?"/":path,message,keyword));}
    private static void schema(JsonNode s,JsonNode v,String path,JsonNode root,List<Issue> out){
        if(s.has("$ref")){String ref=s.path("$ref").asText();if(ref.startsWith("#"))schema(root.at(ref.substring(1)),v,path,root,out);else {JsonNode target=SCHEMAS.get(ref);if(target==null)throw new IllegalStateException("Unknown schema ref "+ref);schema(target,v,path,target,out);}return;}
        if(s.has("const")&&!Objects.equals(s.get("const"),v))issue(out,path,"must be equal to constant","const");
        if(s.has("enum")){boolean found=false;for(JsonNode allowed:s.get("enum"))if(allowed.equals(v))found=true;if(!found)issue(out,path,"must be equal to one of the allowed values","enum");}
        if(s.has("oneOf")){int matches=0;for(JsonNode option:s.get("oneOf")){List<Issue> branch=new ArrayList<>();schema(option,v,path,root,branch);if(branch.isEmpty())matches++;}if(matches!=1)issue(out,path,"must match exactly one schema in oneOf","oneOf");return;}
        if(s.has("allOf"))for(JsonNode branch:s.get("allOf"))schema(branch,v,path,root,out);
        if(s.has("if")){List<Issue> check=new ArrayList<>();schema(s.get("if"),v,path,root,check);JsonNode branch=s.get(check.isEmpty()?"then":"else");if(branch!=null)schema(branch,v,path,root,out);}
        if(s.has("not")){List<Issue> check=new ArrayList<>();schema(s.get("not"),v,path,root,check);if(check.isEmpty())issue(out,path,"must NOT be valid","not");}
        String type=s.path("type").asText("");boolean ok=switch(type){case ""->true;case "object"->v!=null&&v.isObject();case "array"->v!=null&&v.isArray();case "string"->v!=null&&v.isTextual();case "number"->v!=null&&v.isNumber();case "integer"->v!=null&&v.isNumber()&&v.doubleValue()==Math.rint(v.doubleValue());case "boolean"->v!=null&&v.isBoolean();case "null"->v!=null&&v.isNull();default->throw new IllegalStateException("Unsupported schema type "+type);};
        if(!ok){issue(out,path,"must be "+type,"type");return;}
        if(v!=null&&v.isObject()){
            if(s.has("required"))for(JsonNode key:s.get("required"))if(!v.has(key.asText()))issue(out,path+"/"+pointer(key.asText()),"must have required property '"+key.asText()+"'","required");
            JsonNode props=s.path("properties");v.fields().forEachRemaining(e->{JsonNode child=props.get(e.getKey());if(child!=null)schema(child,e.getValue(),path+"/"+pointer(e.getKey()),root,out);else if(s.has("additionalProperties")){JsonNode additional=s.get("additionalProperties");if(additional.isBoolean()){if(!additional.booleanValue())issue(out,path+"/"+pointer(e.getKey()),"must NOT have additional properties","additionalProperties");}else schema(additional,e.getValue(),path+"/"+pointer(e.getKey()),root,out);}});
        }
        if(v!=null&&v.isArray()){if(s.has("maxItems")&&v.size()>s.path("maxItems").asInt())issue(out,path,"must NOT have more than "+s.path("maxItems").asInt()+" items","maxItems");if(s.has("minItems")&&v.size()<s.path("minItems").asInt())issue(out,path,"must NOT have fewer items","minItems");if(s.has("items"))for(int i=0;i<v.size();i++)schema(s.get("items"),v.get(i),path+"/"+i,root,out);}
        if(v!=null&&v.isTextual()){String text=v.asText();int length=text.codePointCount(0,text.length());if(s.has("minLength")&&length<s.path("minLength").asInt())issue(out,path,"must NOT have fewer than "+s.path("minLength").asInt()+" characters","minLength");if(s.has("maxLength")&&length>s.path("maxLength").asInt())issue(out,path,"must NOT have more than "+s.path("maxLength").asInt()+" characters","maxLength");if(s.has("pattern")&&!Pattern.compile(s.path("pattern").asText()).matcher(text).find())issue(out,path,"must match pattern","pattern");if(s.has("format")&&!format(s.path("format").asText(),text))issue(out,path,"must match format \""+s.path("format").asText()+"\"","format");}
        if(v!=null&&v.isNumber()){if(s.has("minimum")&&v.doubleValue()<s.path("minimum").asDouble())issue(out,path,"must be >= "+s.path("minimum").asText(),"minimum");if(s.has("maximum")&&v.doubleValue()>s.path("maximum").asDouble())issue(out,path,"must be <= "+s.path("maximum").asText(),"maximum");}
    }
    private static boolean format(String kind,String text){
        if(kind.equals("uri")){try{return new URI(text).isAbsolute()&&!text.matches(".*[\\s<>].*");}catch(Exception e){return false;}}
        if(kind.equals("date-time")){if(!text.matches("(?i)\\d{4}-\\d{2}-\\d{2}[t ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:z|[+-]\\d{2}:?\\d{2})"))return false;try{OffsetDateTime.parse(text.replace(' ','T').replace('t','T').replace('z','Z'));return true;}catch(DateTimeParseException e){return false;}}
        throw new IllegalStateException("Unsupported schema format "+kind);
    }
    private static void matches(JsonNode payload,String field,JsonNode expected){if(payload.has(field)&&!payload.get(field).equals(expected))throw new ValidationError("LegacyAgentContract",List.of(new Issue("/"+field,"does not match caller-provided orchestration context","context")));}
    public static ObjectNode normalizeInvocation(JsonNode payload,ObjectNode defaults){
        if(payload!=null&&"1".equals(Json.text(payload,"schemaVersion")))return invocation(payload);Json.requireObject(payload,"LegacyAgentInvocation");
        for(String key:List.of("executionId","stepId","attempt"))matches(payload,key,defaults.get(key));matches(payload,"agent",defaults.get("agent"));
        ObjectNode out=Json.object("schemaVersion","1","target",Json.object("agent",defaults.get("agent")),"trace",Json.object("traceId",defaults.get("traceId"),"correlationId",defaults.get("correlationId")));
        for(String key:List.of("invocationId","executionId","stepExecutionId","stepId","attempt","createdAt"))out.set(key,defaults.get(key));if(payload.has("input"))out.set("input",payload.get("input"));
        String deadline=Json.text(defaults,"deadlineAt");if(deadline==null)deadline=deadline(Json.text(defaults,"createdAt"),payload.get("timeout"));if(deadline!=null)out.put("deadlineAt",deadline);
        ObjectNode legacy=Json.object();if(payload.path("maxAttempts").isNumber())legacy.set("maxAttempts",payload.get("maxAttempts"));if(payload.path("timeout").isTextual()||payload.path("timeout").isNumber())legacy.set("timeout",payload.get("timeout"));if(!legacy.isEmpty())out.set("metadata",Json.object("legacy",legacy));return invocation(out);
    }
    private static String deadline(String created,JsonNode timeout){double ms=0;if(timeout!=null&&timeout.isNumber())ms=timeout.asDouble();else if(timeout!=null&&timeout.isTextual()){Matcher m=Pattern.compile("^(\\d+(?:\\.\\d+)?)(ms|s|m|h)?$",Pattern.CASE_INSENSITIVE).matcher(timeout.asText().trim());if(m.matches())ms=Double.parseDouble(m.group(1))*switch(m.group(2)==null?"ms":m.group(2).toLowerCase(Locale.ROOT)){case "s"->1000;case "m"->60000;case "h"->3600000;default->1;};}if(ms<=0||!Double.isFinite(ms))return null;try{return jsInstant(Instant.parse(created).plusMillis((long)ms));}catch(Exception e){return null;}}
    public static String jsInstant(Instant instant){return java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC).format(instant);}
    public static ObjectNode normalizeResult(JsonNode payload,ObjectNode defaults){
        if(payload!=null&&"1".equals(Json.text(payload,"schemaVersion")))return result(payload);Json.requireObject(payload,"LegacyAgentResult");matches(payload,"executionId",defaults.get("executionId"));String status=Json.text(payload,"status");if(!List.of("COMPLETED","FAILED").contains(status==null?"":status))throw new ValidationError("LegacyAgentResult",List.of(new Issue("/status","must be COMPLETED or FAILED","enum")));String stepId=Json.text(payload,"stepId");if(!payload.path("stepId").isTextual()||stepId.isEmpty())throw new ValidationError("LegacyAgentResult",List.of(new Issue("/stepId","must be a non-empty string","type")));
        boolean succeeded=status.equals("COMPLETED");String message=payload.path("error").isTextual()?payload.path("error").asText():payload.path("error").path("message").isTextual()?payload.path("error").path("message").asText():null;if(!succeeded&&(message==null||message.isEmpty()))throw new ValidationError("LegacyAgentResult",List.of(new Issue("/error","is required for a failed legacy result","required")));
        ObjectNode legacy=Json.object("stepId",stepId);if(payload.path("attempt").isNumber())legacy.set("attempt",payload.get("attempt"));ObjectNode out=Json.object("schemaVersion","1","status",succeeded?"succeeded":"failed","metadata",Json.object("legacy",legacy));for(String key:List.of("invocationId","executionId","stepExecutionId","completedAt"))out.set(key,defaults.get(key));if(defaults.has("startedAt"))out.set("startedAt",defaults.get("startedAt"));if(payload.has("output"))out.set("output",payload.get("output"));else if(payload.has("data"))out.set("output",payload.get("data"));if(!succeeded)out.set("error",Json.object("code","LEGACY_AGENT_FAILURE","message",message,"retryable",false));return result(out);
    }
}
