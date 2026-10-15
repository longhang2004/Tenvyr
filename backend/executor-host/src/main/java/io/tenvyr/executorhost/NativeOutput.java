package io.tenvyr.executorhost;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import io.tenvyr.worker.Worker;
import java.util.*;
import java.util.regex.*;

/** Adapts Codex/OpenCode JSONL, Claude envelopes and generic JSON without running a model. */
public final class NativeOutput {
    public record Result(boolean success,JsonNode output,String code,String message,boolean retryable) {}
    private NativeOutput(){}
    public static Result adapt(Supervisor.Outcome outcome,HostConfig.Profile profile){
        if(!outcome.kind().equals("succeeded"))return switch(outcome.kind()){
            case "failed"->failure("PROCESS_FAILED",outcome.stderr().isEmpty()?"Process exited with code "+outcome.exitCode():tail(outcome.stderr(),1024),false);
            case "spawn_failed"->failure("SPAWN_FAILED",outcome.message(),false);
            case "killed"->failure("shutdown".equals(outcome.trigger())?"SHUTDOWN":"DEADLINE","Process group "+outcome.finalSignal()+" after "+outcome.trigger(),true);
            case "output_limit"->failure("OUTPUT_LIMIT",outcome.stream()+" exceeded the configured byte bound for agent \""+profile.agent()+"\"",false);
            default->throw new IllegalArgumentException("Unknown process outcome");};
        if(!profile.structuredResult())return success(Json.object("exitCode",outcome.exitCode(),"stdout",outcome.stdout()));
        String raw=outcome.stdout().trim();if(raw.isEmpty())return failure("INVALID_STRUCTURED_RESULT","Runtime exited 0 but produced empty stdout",false);
        try{String kind=profile.runtimeKind()==null?"generic-cli":profile.runtimeKind();return switch(kind){case "codex"->stream(raw,true);case "opencode"->stream(raw,false);case "claude"->claude(raw);default->success(Json.parse(raw));};}catch(RuntimeException e){return failure("INVALID_STRUCTURED_RESULT","Native runtime output is not valid structured JSON",false);}
    }
    private static Result stream(String raw,boolean codex){List<String> lines=raw.lines().map(String::trim).filter(s->!s.isEmpty()).toList();String last=null;for(String line:lines){JsonNode event=Json.parse(line);if(lines.size()==1&&!event.has("type")&&!event.has(codex?"item":"part")&&!event.isNull())return success(event);if(codex&&"item.completed".equals(Json.text(event,"type"))&&"agent_message".equals(event.path("item").path("type").asText())&&event.path("item").path("text").isTextual())last=event.path("item").path("text").asText();if(!codex&&"text".equals(Json.text(event,"type"))&&"text".equals(event.path("part").path("type").asText())&&event.path("part").path("text").isTextual())last=event.path("part").path("text").asText();}if(last==null)return failure("INVALID_STRUCTURED_RESULT","Native stream did not emit a completed assistant text event",false);return finalPayload(last);}
    private static Result claude(String raw){JsonNode value=Json.parse(raw);JsonNode result=value.get("result");if(result!=null&&result.isTextual())return finalPayload(result.asText());if(result!=null&&result.isContainerNode())return success(result);if(value.path("output").isTextual())return finalPayload(value.path("output").asText());if(value.path("content").isArray())for(JsonNode part:value.path("content"))if("text".equals(Json.text(part,"type"))&&part.path("text").isTextual())return finalPayload(part.path("text").asText());return success(value);}
    private static Result finalPayload(String text){String trimmed=text.trim();try{return success(Json.parse(trimmed));}catch(RuntimeException ignored){}Matcher fence=Pattern.compile("```(?:json)?\\s*([\\s\\S]*?)\\s*```").matcher(trimmed);if(fence.find())try{return success(Json.parse(fence.group(1).trim()));}catch(RuntimeException ignored){}return success(Json.object("text",trimmed));}
    private static Result success(JsonNode value){Worker.finite(value);return new Result(true,value,null,null,false);}
    private static Result failure(String code,String message,boolean retryable){return new Result(false,null,"EXECUTOR_HOST_"+code,message,retryable);}
    private static String tail(String text,int max){return text.length()<=max?text:"..."+text.substring(text.length()-max);}
}
