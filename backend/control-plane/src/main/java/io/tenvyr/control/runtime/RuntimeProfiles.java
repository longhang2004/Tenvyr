package io.tenvyr.control.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Json;
import java.util.*;

/** Version-pinned, fixed argv from the retained executable runtime contracts. */
public final class RuntimeProfiles {
    private RuntimeProfiles() {}
    public static final List<String> KINDS=List.of("codex","claude","opencode");
    public static ObjectNode template(String kind) {
        if(!KINDS.contains(kind))throw new RuntimeFailure("RUNTIME_NOT_SUPPORTED","Unsupported onboarding runtime");
        String version=switch(kind){case "codex"->"0.147.0";case "claude"->"2.1.228";default->"1.18.16";};
        ObjectNode probe=kind.equals("codex")?Json.object("args",Json.array("login","status"),"authAnyNonZero",true):Json.object("args",Json.array("--version"),"expectsVersion",true);
        ObjectNode capabilities=Json.object("invocation",Json.object("supported",true,"source","configured","version",version),"structuredResult",Json.object("supported",true,"source","configured","version",version),"localProcessTermination",Json.object("supported",true,"source","configured"));
        if(!kind.equals("claude"))capabilities.set("progressEvents",Json.object("supported",true,"source","configured","version",version));
        ObjectNode t=Json.object("runtimeKind",kind,"pinnedVersion",version,"accessedAt","2026-08-12","sourceUrl",switch(kind){case "codex"->"https://learn.chatgpt.com/docs/developer-commands?surface=cli";case "claude"->"https://code.claude.com/docs/en/cli-reference";default->"https://opencode.ai/docs/cli/";},"loginCommand",kind.equals("claude")?"claude auth login":kind+" login","runArgs",switch(kind){case "codex"->Json.array("exec","--json","--ephemeral","-");case "claude"->Json.array("-p","--output-format","json");default->Json.array("run","--format","json");},"modelArgvPrefix",Json.array("--model"),"probe",probe,"declaredCapabilities",capabilities);
        if(kind.equals("opencode"))t.put("loginCommand","opencode auth login");
        if(kind.equals("claude"))t.set("authProbe",Json.object("args",Json.array("auth","status"),"authExitCodes",Json.array(1)));
        return t;
    }
    public static ObjectNode buildRuntimeConnectionProfile(JsonNode input){String kind=Json.text(input,"runtimeKind");ObjectNode t=template(kind),cli=Json.object("command",input.get("executable"),"args",t.get("runArgs"),"modelArgvPrefix",t.get("modelArgvPrefix"),"probe",t.get("probe"),"envAllowlist",RuntimeOnboardingService.safeEnvironment());if(t.has("authProbe"))cli.set("authProbe",t.get("authProbe"));ObjectNode profile=Json.object("name",input.get("name"),"executorId",input.get("executorId"),"runtimeKind",kind,"version",Json.text(input,"version",Json.text(t,"pinnedVersion")),"credentialRefs",input.has("credentialRefs")?input.get("credentialRefs"):Json.array(),"declaredCapabilities",input.has("declaredCapabilities")?input.get("declaredCapabilities"):t.get("declaredCapabilities"),"cli",cli);return RuntimeConnectionService.parseConnectionProfile(profile);}
}
