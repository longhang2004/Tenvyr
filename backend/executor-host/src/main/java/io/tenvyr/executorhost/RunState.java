package io.tenvyr.executorhost;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import java.io.IOException;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

/** Crash policy: terminate verified orphan groups; never adopt or replay an invocation. */
public final class RunState {
    public record State(String invocationId,long pid,String startedAt,String killAt) {}
    private RunState(){}
    private static Path file(Path directory,String agent){if(!agent.matches("[A-Za-z0-9_.-]+")||agent.equals(".")||agent.equals(".."))throw new IllegalArgumentException("Unsafe state identity");return directory.resolve(agent+".json");}
    public static State read(Path directory,String agent){try{Path file=file(directory,agent);if(Files.size(file)>4096)return null;JsonNode value=Json.parse(Files.readString(file));if(!value.path("invocationId").isTextual()||!value.path("pid").isIntegralNumber()||value.path("pid").asLong()<=1||!value.path("startedAt").isTextual()||!value.path("killAt").isTextual())return null;return new State(value.path("invocationId").asText(),value.path("pid").asLong(),value.path("startedAt").asText(),value.path("killAt").asText());}catch(IOException|RuntimeException e){return null;}}
    public static void write(Path directory,String agent,State state)throws IOException{Files.createDirectories(directory);Path file=file(directory,agent),temporary=directory.resolve(agent+".json.tmp");Files.writeString(temporary,Json.stringify(Json.value(state)),StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING);try{Files.move(temporary,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}catch(AtomicMoveNotSupportedException e){Files.move(temporary,file,StandardCopyOption.REPLACE_EXISTING);}}
    public static void clear(Path directory,String agent){try{Files.deleteIfExists(file(directory,agent));}catch(IOException ignored){}}
    public static boolean identityMatches(long pid,String recorded){try{return ProcessHandle.of(pid).flatMap(p->p.info().startInstant()).map(start->Math.abs(start.toEpochMilli()-Instant.parse(recorded).toEpochMilli())<=2000).orElse(false);}catch(RuntimeException e){return false;}}
    public static String terminate(Path directory,String agent,Path launcher,long grace)throws InterruptedException{State state=read(directory,agent);if(state==null){clear(directory,agent);return null;}try{if(!ProcessHandle.of(state.pid).map(ProcessHandle::isAlive).orElse(false)||!identityMatches(state.pid,state.startedAt))return null;Supervisor.killGroup(launcher,state.pid,"TERM");Thread.sleep(Math.max(0,Math.min(grace,5000)));Supervisor.killGroup(launcher,state.pid,"KILL");return state.invocationId;}finally{clear(directory,agent);}}
    public static void sweep(Path directory,Path launcher)throws IOException,InterruptedException{try(var files=Files.list(directory)){for(Path file:files.filter(p->p.getFileName().toString().matches("[A-Za-z0-9_.-]+\\.json")).toList()){String name=file.getFileName().toString();terminate(directory,name.substring(0,name.length()-5),launcher,5000);}}}
}
