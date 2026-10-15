package io.tenvyr.executorhost;

import io.tenvyr.platform.Json;
import io.tenvyr.worker.Cancellation;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongConsumer;

/** Bounded stdin/stdout/stderr, explicit argv/env and session-wide termination. */
public final class Supervisor {
    public static final long ESCALATION_GRACE_MS=5000;
    public record Outcome(String kind,int exitCode,String stdout,String stderr,String message,String trigger,String finalSignal,String stream) {}
    private Supervisor(){}
    public static List<String> composeArgv(HostConfig.Profile profile,String model){List<String> args=new ArrayList<>(profile.args());if(model!=null&&profile.modelArgvPrefix()!=null&&!profile.modelArgvPrefix().isEmpty()){args.addAll(profile.modelArgvPrefix());args.add(model);}return args;}
    public static Outcome supervise(Path launcher,HostConfig.Profile profile,Map<String,String> environment,Object input,String model,Cancellation signal,String deadline,Path cwd,LongConsumer onSpawn)throws InterruptedException{return supervise(launcher,profile,environment,input,model,signal,deadline,cwd,onSpawn,ESCALATION_GRACE_MS);}
    public static Outcome supervise(Path launcher,HostConfig.Profile profile,Map<String,String> environment,Object input,String model,Cancellation signal,String deadline,Path cwd,LongConsumer onSpawn,long grace)throws InterruptedException {
        List<String> command=new ArrayList<>(List.of(launcher.toString(),"exec",profile.command()));command.addAll(composeArgv(profile,model));
        ProcessBuilder builder=new ProcessBuilder(command).directory(cwd.toFile());builder.environment().clear();builder.environment().putAll(environment);
        Process process;try{process=builder.start();}catch(IOException|RuntimeException e){return new Outcome("spawn_failed",-1,"","","Configured process could not start",null,null,null);}
        ExecutorService io=Executors.newFixedThreadPool(3,r->{Thread t=new Thread(r,"tenvyr-executor-io");t.setDaemon(true);return t;});
        AtomicReference<String> limit=new AtomicReference<>();ByteArrayOutputStream stdout=new ByteArrayOutputStream(),stderr=new ByteArrayOutputStream();
        Future<?> out=io.submit(()->capture(process.getInputStream(),stdout,profile.maxStdoutBytes(),"stdout",limit));Future<?> err=io.submit(()->capture(process.getErrorStream(),stderr,profile.maxStderrBytes(),"stderr",limit));
        io.submit(()->{try(OutputStream stdin=process.getOutputStream()){byte[] raw=Json.stringify(Json.value(input)).getBytes(StandardCharsets.UTF_8);if(raw.length>1024*1024)throw new IOException("Input exceeds byte bound");stdin.write(raw);}catch(IOException ignored){}});
        long wall=System.currentTimeMillis()+profile.wallTimeMs(),killAt=wall;String deadlineTrigger="wall_time";
        if(deadline!=null)try{long requested=Instant.parse(deadline).toEpochMilli();if(requested<killAt){killAt=requested;deadlineTrigger="invocation_deadline";}}catch(RuntimeException ignored){}
        String trigger=null,lastSignal=null;long escalateAt=Long.MAX_VALUE;
        try {
            if(onSpawn!=null)onSpawn.accept(process.pid());
            while(process.isAlive()) {
                long now=System.currentTimeMillis();
                if(limit.get()!=null&&!"SIGKILL".equals(lastSignal)){killGroup(launcher,process.pid(),"KILL");lastSignal="SIGKILL";}
                else if(trigger==null&&(signal.isCancelled()||now>=killAt)){trigger=signal.isCancelled()?"shutdown":deadlineTrigger;killGroup(launcher,process.pid(),"TERM");lastSignal="SIGTERM";escalateAt=now+Math.max(0,grace);}
                else if(trigger!=null&&now>=escalateAt&&!"SIGKILL".equals(lastSignal)){killGroup(launcher,process.pid(),"KILL");lastSignal="SIGKILL";}
                process.waitFor(10,TimeUnit.MILLISECONDS);
            }
            // The group may outlive its leader after a successful native CLI exit.
            killGroup(launcher,process.pid(),"KILL");
            waitReader(out);waitReader(err);
            String output=text(stdout),errors=text(stderr);int exit=process.exitValue();
            if(limit.get()!=null)return new Outcome("output_limit",exit,output,errors,null,null,null,limit.get());
            if(trigger!=null)return new Outcome("killed",exit,output,errors,null,trigger,lastSignal,null);
            if(exit==126&&errors.startsWith("Tenvyr process launcher:"))return new Outcome("spawn_failed",exit,output,errors,"Configured executable could not be launched",null,null,null);
            return new Outcome(exit==0?"succeeded":"failed",exit,output,errors,null,null,null,null);
        } finally {
            try{killGroup(launcher,process.pid(),"KILL");}finally{if(process.isAlive()){process.descendants().forEach(ProcessHandle::destroyForcibly);process.destroyForcibly();}close(process.getOutputStream());close(process.getInputStream());close(process.getErrorStream());io.shutdownNow();}
        }
    }
    private static void capture(InputStream input,ByteArrayOutputStream output,int max,String stream,AtomicReference<String> limit){try(input){byte[] bytes=new byte[4096];int n;while((n=input.read(bytes))!=-1){synchronized(output){if(limit.get()!=null)continue;if(output.size()+n>max){limit.compareAndSet(null,stream);continue;}output.write(bytes,0,n);}}}catch(IOException ignored){}}
    private static String text(ByteArrayOutputStream stream){synchronized(stream){return stream.toString(StandardCharsets.UTF_8);}}
    private static void waitReader(Future<?> reader)throws InterruptedException{try{reader.get(2,TimeUnit.SECONDS);}catch(ExecutionException|TimeoutException ignored){reader.cancel(true);}}
    public static void killGroup(Path launcher,long pid,String signal){if(pid<=1)throw new IllegalArgumentException("Unsafe process group");try{Process helper=new ProcessBuilder(launcher.toString(),"signal",signal,Long.toString(pid)).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();if(!helper.waitFor(2,TimeUnit.SECONDS)){helper.destroyForcibly();throw new IllegalStateException("Process group signal timed out");}if(helper.exitValue()!=0)throw new IllegalStateException("Process group signal failed");}catch(IOException e){throw new IllegalStateException("Process group helper unavailable",e);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException("Process group signal interrupted",e);}}
    private static void close(Closeable stream){try{stream.close();}catch(IOException ignored){}}
}
