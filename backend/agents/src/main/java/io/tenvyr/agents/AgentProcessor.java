package io.tenvyr.agents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.regex.*;

/** Actual specialized-agent behavior, independent of Kafka offset ownership. */
public final class AgentProcessor {
    @FunctionalInterface public interface Runner { JsonNode run(String prompt,ObjectNode context,long timeoutMillis)throws Exception; }
    private final String agent;
    private final Path skills;
    private final Runner runner;
    private static final Pattern OUTPUT=Pattern.compile("\\{[\\s\\S]*}");
    public AgentProcessor(String agent,String runnerUrl,Path skills) {this(agent,skills,httpRunner(runnerUrl));}
    public AgentProcessor(String agent,Path skills,Runner runner) {if(!Set.of("code-reviewer","observability").contains(agent))throw new IllegalArgumentException("Unknown specialized agent: "+agent);this.agent=agent;this.skills=skills;this.runner=runner;}
    public String agent() {return agent;}
    public ObjectNode normalize(JsonNode value,long kafkaTimestamp) {
        ObjectNode invocation;
        if(value!=null && value.path("schemaVersion").isTextual() && value.path("schemaVersion").asText().equals("1")) invocation=Protocol.invocation(value);
        else {
            String executionId=string(value,"executionId",""),stepId=string(value,"stepId","");
            JsonNode attempt=value==null?null:value.get("attempt");
            if(attempt==null||!attempt.isNumber()||attempt.doubleValue()!=Math.rint(attempt.doubleValue()))attempt=Json.value(Double.NaN);
            String stepExecutionId="legacy:"+executionId+":"+stepId,invocationId=stepExecutionId+":"+(attempt.isNumber()&&Double.isFinite(attempt.doubleValue())?Json.stringify(attempt):"NaN");
            String createdAt=string(value,"timestamp",Protocol.jsInstant(Instant.ofEpochMilli(kafkaTimestamp)));
            invocation=Protocol.normalizeInvocation(value,Json.object("invocationId",invocationId,"executionId",executionId,"stepExecutionId",stepExecutionId,"stepId",stepId,"agent",agent,"attempt",attempt,"traceId",executionId,"correlationId",invocationId,"createdAt",createdAt));
        }
        if(!agent.equals(Json.text(invocation.get("target"),"agent")))throw new Protocol.ValidationError("AgentInvocationV1",List.of(new Protocol.Issue("/target/agent","must be "+agent+" for this topic","const")));
        return invocation;
    }
    public ObjectNode process(ObjectNode invocation) {
        String startedAt=Protocol.jsInstant(Instant.now());
        ObjectNode result=correlation(invocation).put("startedAt",startedAt);
        try {
            JsonNode input=invocation.get("input");
            if(input==null||!input.isObject())throw new IllegalArgumentException(agent.equals("code-reviewer")?"Code reviewer input must be an object":"Observability input must be an object");
            ObjectNode context=Json.object("executionId",invocation.get("executionId"),"stepId",invocation.get("stepId"),"attempt",invocation.get("attempt"));
            if(agent.equals("code-reviewer")) {context.put("code",string(input,"code","")).put("language",string(input,"language","typescript"));}
            else {context.put("logs",string(input,"logs","No system logs available.")).put("findings",Json.stringify(truthy(input.get("findings"))?input.get("findings"):Json.object()));}
            long timeout=60_000;
            if(invocation.has("deadlineAt"))timeout=Math.max(Duration.between(Instant.now(),OffsetDateTime.parse(invocation.path("deadlineAt").asText().replace(' ','T').replace('t','T').replace('z','Z')).toInstant()).toMillis(),1);
            JsonNode response=runner.run(prompt(),context,timeout);
            JsonNode data=response.get("data");
            if(data==null||!data.isObject())throw new IllegalArgumentException("Agent Runner data must be an object");
            JsonNode output=data.get("output");
            if(output==null||!output.isTextual())throw new IllegalArgumentException("Agent Runner output must be a string");
            ObjectNode usage=Json.object();
            for(String[] fields:new String[][]{{"inputTokens","promptTokens"},{"outputTokens","completionTokens"},{"totalTokens","totalTokens"}})if(data.has(fields[1]))usage.set(fields[0],data.get(fields[1]));
            JsonNode metadata=data.get("metadata");
            ObjectNode resultData=parseOutput(output.asText());
            ObjectNode tenvyr=Json.object("usage",usage);if(metadata!=null)tenvyr.set("metadata",metadata);
            resultData.set("_tenvyr",tenvyr);
            result.put("status","succeeded").set("output",resultData);result.set("usage",usage);if(metadata!=null)result.set("metadata",metadata);
            result.put("completedAt",Protocol.jsInstant(Instant.now()));
            return Protocol.result(result);
        } catch(Exception e) {
            if(e instanceof InterruptedException)Thread.currentThread().interrupt();
            boolean timedOut=e instanceof HttpTimeoutException || e instanceof java.util.concurrent.TimeoutException;
            ObjectNode failure=correlation(invocation).put("status",timedOut?"timed_out":"failed").put("startedAt",startedAt).put("completedAt",Protocol.jsInstant(Instant.now()));
            failure.set("error",Json.object("code",timedOut?"AGENT_TIMED_OUT":"AGENT_EXECUTION_FAILED","message",message(e),"retryable",timedOut));
            return Protocol.result(failure);
        }
    }
    private ObjectNode parseOutput(String output) {
        Matcher match=OUTPUT.matcher(output);
        try {
            if(match.find())return Json.requireObject(Json.parse(match.group()),"Agent Runner JSON output").deepCopy();
            return agent.equals("code-reviewer")?Json.object("score",90,"findings",Json.array(output)):Json.object("status","DEGRADED","analysis",output,"latencySec",2);
        }catch(RuntimeException e) {return agent.equals("code-reviewer")?Json.object("score",80,"findings",Json.array(output)):Json.object("status","DEGRADED","analysis",output,"latencySec",2);}
    }
    public String prompt() {
        boolean reviewer=agent.equals("code-reviewer");
        String rules=reviewer?"Analyze code for AWS/Stripe API key secrets, SQL injection (direct interpolation), and missing JWT route guards.":"Analyze system log files and identify performance bottlenecks and timeouts.";
        try {Path file=skills.resolve(reviewer?"security-review-basic.md":"observability-guidelines.md");if(Files.exists(file))rules=Files.readString(file);}catch(Exception e) {System.err.println("Failed to load skill rules from file, using fallback: "+message(e));}
        return reviewer?"\n      You are a security audit agent. Apply the following skill guidelines:\n      "+rules+"\n      \n      Review this code segment:\n      Language: {{language}}\n      Code:\n      {{code}}\n\n      Please return a clean JSON payload ONLY containing:\n      {\n        \"score\": <integer from 0 to 100 representing code safety>,\n        \"findings\": [\"finding 1\", \"finding 2\"]\n      }\n    ":"\n      You are an operations diagnostic agent. Apply the following guidelines:\n      "+rules+"\n      \n      Diagnose the system performance logs:\n      Logs:\n      {{logs}}\n      \n      Review Findings:\n      {{findings}}\n\n      Please return a clean JSON payload ONLY containing:\n      {\n        \"status\": \"HEALTHY\" | \"DEGRADED\" | \"CRITICAL\",\n        \"analysis\": \"<diagnostic analysis summary>\",\n        \"latencySec\": <estimated overall step latency>\n      }\n    ";
    }
    private static Runner httpRunner(String runnerUrl) {
        HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL).build();
        return (prompt,context,timeout)->{
            HttpRequest request=HttpRequest.newBuilder(URI.create(runnerUrl+"/api/run")).timeout(Duration.ofMillis(timeout)).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(Json.stringify(Json.object("promptTemplate",prompt,"context",context)))).build();
            HttpResponse<String> response=client.send(request,HttpResponse.BodyHandlers.ofString());
            JsonNode data=Json.parse(response.body());
            if(response.statusCode()<200||response.statusCode()>=300||!Json.bool(data,"success",false))throw new IllegalStateException(truthy(data.get("error"))?jsString(data.get("error")):"Agent Runner returned HTTP "+response.statusCode());
            return data;
        };
    }
    private static ObjectNode correlation(ObjectNode invocation) {return Json.object("schemaVersion","1","invocationId",invocation.get("invocationId"),"executionId",invocation.get("executionId"),"stepExecutionId",invocation.get("stepExecutionId"));}
    private static String string(JsonNode value,String key,String fallback) {return value!=null&&value.path(key).isTextual()?value.path(key).asText():fallback;}
    private static boolean truthy(JsonNode n) {return n!=null&&!n.isNull()&&(!n.isTextual()||!n.asText().isEmpty())&&(!n.isBoolean()||n.asBoolean())&&(!n.isNumber()||n.doubleValue()!=0);}
    private static String jsString(JsonNode n) {return n.isTextual()?n.asText():n.isObject()?"[object Object]":Json.stringify(n);}
    static String message(Throwable e) {return e.getMessage()==null||e.getMessage().isEmpty()?e.toString():e.getMessage();}
}
