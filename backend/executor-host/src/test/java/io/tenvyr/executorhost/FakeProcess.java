package io.tenvyr.executorhost;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import io.tenvyr.platform.Json;

/** Real process fixtures use Java, never a backend bridge or an installed model CLI. */
public final class FakeProcess {
    public static void main(String[] args)throws Exception {
        switch(args[0]){
            case "probe"->System.out.println("fixture-1");
            case "team"->{
                var invocation=Json.parse(new String(System.in.readAllBytes(),StandardCharsets.UTF_8));var input=invocation.path("input");
                var output=switch(input.path("role").asText()){
                    case "planner"->Json.object("schemaVersion",1,"iterationNumber",input.get("iterationNumber"),"baseRevision",input.get("planRevision"),"reason","native fixture plan","tasks",Json.array(Json.object("taskId","native-work","agent","conn__worker","connectionId","conn:worker","input",Json.object(),"required",true,"reason","native execution")));
                    case "verifier"->Json.object("schemaVersion",1,"iterationId",input.path("context").get("iterationId"),"iterationNumber",input.path("context").get("iterationNumber"),"action","ACCEPT","reason","native worker evidence checked","evidenceRefs",Json.array());
                    default->Json.object("native",true,"cwd",Path.of("").toRealPath().toString(),"literal",args.length>1?args[1]:"","inheritedSecret",System.getenv().containsKey("UNCONFIGURED_PARENT_SECRET"));
                };System.out.println(Json.stringify(output));
            }
            case "echo"->{System.out.write(System.in.readAllBytes());System.err.print("stderr-ok");}
            case "env"->{System.out.print(System.getenv().getOrDefault("ALLOWED","")+"|"+System.getenv().getOrDefault("SECRET","")+"|"+System.getenv().getOrDefault("PARENT_ONLY","absent"));}
            case "argv"->{for(int i=1;i<args.length;i++)System.out.println(args[i]);}
            case "cwd"->System.out.print(Path.of("").toRealPath());
            case "fail"->{System.err.print("boom");System.exit(3);}
            case "stdout"->System.out.print("💚".repeat(10000));
            case "stderr"->System.err.print("x".repeat(10000));
            case "grandchild"->{Runtime.getRuntime().addShutdownHook(new Thread(()->{for(;;)try{Thread.sleep(1000);}catch(InterruptedException ignored){}}));Files.writeString(Path.of(args[1]),Long.toString(ProcessHandle.current().pid()));for(;;)Thread.sleep(1000);}
            case "tree", "tree-exit"->{if(args[0].equals("tree"))Runtime.getRuntime().addShutdownHook(new Thread(()->{for(;;)try{Thread.sleep(1000);}catch(InterruptedException ignored){}}));String java=Path.of(System.getProperty("java.home"),"bin","java").toString();new ProcessBuilder(java,"-cp",System.getProperty("java.class.path"),FakeProcess.class.getName(),"grandchild",args[1]).inheritIO().start();for(int i=0;i<200&&!Files.exists(Path.of(args[1]));i++)Thread.sleep(10);if(args[0].equals("tree-exit"))return;for(;;)Thread.sleep(1000);}
            case "sleep"->{for(;;)Thread.sleep(1000);}
            default->throw new IllegalArgumentException("Unknown fixture");
        }
    }
}
