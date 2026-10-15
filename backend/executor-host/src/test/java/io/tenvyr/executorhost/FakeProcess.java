package io.tenvyr.executorhost;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Real process fixtures use Java, never a backend bridge or an installed model CLI. */
public final class FakeProcess {
    public static void main(String[] args)throws Exception {
        switch(args[0]){
            case "echo"->{System.out.write(System.in.readAllBytes());System.err.print("stderr-ok");}
            case "env"->{System.out.print(System.getenv().getOrDefault("ALLOWED","")+"|"+System.getenv().getOrDefault("SECRET","")+"|"+System.getenv().getOrDefault("PARENT_ONLY","absent"));}
            case "argv"->{for(int i=1;i<args.length;i++)System.out.println(args[i]);}
            case "cwd"->System.out.print(Path.of("").toRealPath());
            case "fail"->{System.err.print("boom");System.exit(3);}
            case "stdout"->System.out.print("💚".repeat(10000));
            case "stderr"->System.err.print("x".repeat(10000));
            case "grandchild"->{Runtime.getRuntime().addShutdownHook(new Thread(()->{for(;;)try{Thread.sleep(1000);}catch(InterruptedException ignored){}}));Files.writeString(Path.of(args[1]),Long.toString(ProcessHandle.current().pid()));for(;;)Thread.sleep(1000);}
            case "tree", "tree-exit"->{String java=Path.of(System.getProperty("java.home"),"bin","java").toString();new ProcessBuilder(java,"-cp",System.getProperty("java.class.path"),FakeProcess.class.getName(),"grandchild",args[1]).inheritIO().start();for(int i=0;i<200&&!Files.exists(Path.of(args[1]));i++)Thread.sleep(10);if(args[0].equals("tree-exit"))return;Runtime.getRuntime().addShutdownHook(new Thread(()->{for(;;)try{Thread.sleep(1000);}catch(InterruptedException ignored){}}));for(;;)Thread.sleep(1000);}
            case "sleep"->{for(;;)Thread.sleep(1000);}
            default->throw new IllegalArgumentException("Unknown fixture");
        }
    }
}
