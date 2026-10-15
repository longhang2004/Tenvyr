package io.tenvyr.control.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Fixed argv, a cleared environment, bounded drains and descendant termination. */
public final class ProcessBoundary {
    private ProcessBoundary() {}
    public record Result(Integer status,String stdout,String stderr,boolean timedOut,boolean exceeded,long durationMs) {}
    public static Result run(String command,List<String> args,Path cwd,Map<String,String> environment,long timeout,int bound) { return run(command,args,cwd,environment,timeout,bound,null); }
    public static Result run(String command,List<String> args,Path cwd,Map<String,String> environment,long timeout,int bound,String stdin) {
        if(timeout<1||timeout>120000||bound<1||bound>1048576||stdin!=null&&stdin.length()>65536)throw new RuntimeFailure("COMMAND_INVALID","Command bounds are invalid");
        if(command==null || command.indexOf(0)>=0 || args.size()>128 || args.stream().anyMatch(a->a==null || a.indexOf(0)>=0)) throw new RuntimeFailure("COMMAND_INVALID","Invalid fixed command argv");
        List<String> argv=new ArrayList<>();argv.add(command);argv.addAll(args);
        ProcessBuilder builder=new ProcessBuilder(argv);if(cwd!=null)builder.directory(cwd.toFile());builder.environment().clear();builder.environment().putAll(environment);
        long start=System.nanoTime();Process process;
        try {process=builder.start();} catch(IOException e) {return new Result(-1,"","",false,false,elapsed(start));}
        Capture out=new Capture(bound),err=new Capture(bound);
        Thread stdout=new Thread(()->out.drain(process.getInputStream()),"tenvyr-stdout"),stderr=new Thread(()->err.drain(process.getErrorStream()),"tenvyr-stderr");stdout.setDaemon(true);stderr.setDaemon(true);stdout.start();stderr.start();
        boolean timedOut=false;Set<ProcessHandle> descendants=new HashSet<>();
        try {if(stdin!=null)process.getOutputStream().write(stdin.getBytes(StandardCharsets.UTF_8));process.getOutputStream().close();long deadline=System.nanoTime()+timeout*1000000;while(process.isAlive()){descendants.addAll(process.descendants().toList());long remaining=(deadline-System.nanoTime())/1000000;if(remaining<=0){timedOut=true;terminate(process);break;}if(out.exceeded||err.exceeded){terminate(process);break;}process.waitFor(Math.min(50,remaining),TimeUnit.MILLISECONDS);}if(timedOut||out.exceeded||err.exceeded)descendants.forEach(ProcessHandle::destroyForcibly);stdout.join(1000);stderr.join(1000);process.getInputStream().close();process.getErrorStream().close();} catch(InterruptedException e){terminate(process);descendants.forEach(ProcessHandle::destroyForcibly);Thread.currentThread().interrupt();throw new RuntimeFailure("COMMAND_INTERRUPTED","Command interrupted");}catch(IOException e){terminate(process);descendants.forEach(ProcessHandle::destroyForcibly);}
        return new Result(process.isAlive()?null:process.exitValue(),out.text(),err.text(),timedOut,out.exceeded||err.exceeded,elapsed(start));
    }
    public static void terminate(Process process) {
        List<ProcessHandle> descendants=process.descendants().toList();descendants.forEach(ProcessHandle::destroy);process.destroy();
        try {if(!process.waitFor(500,TimeUnit.MILLISECONDS)){descendants.forEach(ProcessHandle::destroyForcibly);process.destroyForcibly();process.waitFor(500,TimeUnit.MILLISECONDS);}} catch(InterruptedException e){descendants.forEach(ProcessHandle::destroyForcibly);process.destroyForcibly();Thread.currentThread().interrupt();}
    }
    public static Map<String,String> environment(JsonNode profile,Map<String,String> host,boolean requireSecrets) {
        Map<String,String> result=new HashMap<>();
        for(String key:List.of("envAllowlist","secrets")){
            JsonNode refs=profile.path(key);if(!refs.isObject())continue;
            refs.fields().forEachRemaining(e->{String ref=e.getValue().asText();String value=host.get(ref);if(value==null){if(key.equals("secrets")&&requireSecrets)throw new RuntimeFailure("SECRET_REFERENCE_MISSING","Required credential reference is unavailable");}else result.put(e.getKey(),value);});
        }
        return result;
    }
    public static List<String> args(JsonNode values){List<String> result=new ArrayList<>();values.forEach(n->result.add(n.asText()));return result;}
    private static long elapsed(long start){return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start);}
    private static final class Capture {
        final int bound;final ByteArrayOutputStream bytes=new ByteArrayOutputStream();volatile boolean exceeded;
        Capture(int bound){this.bound=bound;}
        void drain(InputStream input){try(input){byte[] buffer=new byte[4096];int n;while((n=input.read(buffer))!=-1){synchronized(bytes){int keep=Math.min(n,Math.max(0,bound-bytes.size()));if(keep>0)bytes.write(buffer,0,keep);if(keep<n)exceeded=true;}}}catch(IOException ignored){}}
        String text(){synchronized(bytes){return bytes.toString(StandardCharsets.UTF_8);}}
    }
}
