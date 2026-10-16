package io.tenvyr.control.runtime;

import io.tenvyr.platform.Json;
import java.nio.file.*;
import java.util.*;

public final class RuntimeCheck {
    private static int checks;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    public static void main(String[] args)throws Exception {
        for(String kind:RuntimeProfiles.KINDS){var template=RuntimeProfiles.template(kind);check(template!=null&&template.isObject(),"runtime template "+kind);}
        try{RuntimeConnectionService.parseConnectionProfile(Json.object("name","bad","runtimeKind","generic-cli","executorId","x","credentialRefs",Json.array(),"declaredCapabilities",Json.object(),"unknown",true));throw new AssertionError("Unknown profile field accepted");}catch(RuntimeFailure expected){check(expected.code().equals("CONNECTION_PROFILE_INVALID"),"profile rejects unknown fields");}
        Path root=Files.createTempDirectory("tenvyr-runtime-check-");
        try {
            String literal="literal;$(touch injected)";
            var result=ProcessBoundary.run("/usr/bin/printf",List.of("%s",literal),root,Map.of("ONLY","yes"),3000,1024);
            check(result.stdout().equals(literal)&&!Files.exists(root.resolve("injected")),"runtime argv never enters a shell");
            var environment=ProcessBoundary.run("/usr/bin/env",List.of(),root,Map.of("ONLY","yes"),3000,1024);
            check(environment.stdout().equals("ONLY=yes\n"),"runtime process receives only the explicit environment");
        } finally {Files.delete(root);}
        System.out.println("RuntimeCheck: "+checks+" checks passed");
    }
}
