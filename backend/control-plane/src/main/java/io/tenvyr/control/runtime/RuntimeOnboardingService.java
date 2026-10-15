package io.tenvyr.control.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import java.nio.file.*;
import java.util.*;

public final class RuntimeOnboardingService {
    private final Map<String,String> environment;
    public RuntimeOnboardingService(){this(System.getenv());}
    public RuntimeOnboardingService(Map<String,String> environment){this.environment=Map.copyOf(environment);}
    public static List<String> kinds(){return RuntimeProfiles.KINDS;}
    public static String resolveExecutableOnPath(String name,Map<String,String> env){if(!RuntimeProfiles.KINDS.contains(name))return null;String path=env.getOrDefault("PATH","");if(path.length()>65536)return null;int count=0;for(String part:path.split(java.io.File.pathSeparator)){if(++count>256)break;if(part.isBlank())continue;try{Path p=Path.of(part,name);if(p.isAbsolute()&&Files.isRegularFile(p)&&Files.isExecutable(p))return p.toRealPath().toString();}catch(Exception ignored){}}return null;}
    public ObjectNode status(String kind){ObjectNode t=RuntimeProfiles.template(kind);String executable=resolveExecutableOnPath(kind,environment);ArrayNode guidance=Json.array();ObjectNode out=Json.object("runtimeKind",kind,"pinnedVersion",t.get("pinnedVersion"),"detected",executable!=null,"executable",executable,"version",null,"authReady",null,"loginCommand",t.get("loginCommand"),"modelArgvPrefix",t.get("modelArgvPrefix"),"guidance",guidance,"docUrl",t.get("sourceUrl"),"connectPayload",null);if(executable==null){guidance.add(kind+" was not found on PATH; install the official CLI first.");return out;}guidance.add("Detected executable: "+executable);ObjectNode cli=Json.object("command",executable,"envAllowlist",safeEnvironment());JsonNode probe=t.path("probe");if(Json.bool(probe,"expectsVersion",false)){ObjectNode result=RuntimeConnectionService.runProbe(cli,boundedProbe(probe),environment);if(Json.bool(result,"ok",false)&&result.has("version"))out.set("version",result.get("version"));else guidance.add("Version probe did not complete ("+Json.text(result,"reasonCode")+"); pinned version is operator-declared.");}JsonNode auth=t.has("authProbe")?t.get("authProbe"):Json.bool(probe,"authAnyNonZero",false)||probe.path("authExitCodes").size()>0?probe:null;if(auth!=null){ObjectNode result=RuntimeConnectionService.runProbe(cli,boundedProbe(auth),environment);out.put("authReady",Json.bool(result,"ok",false));guidance.add(Json.bool(result,"ok",false)?"Authentication: ready (runtime-owned).":"Authentication required; run the official login command.");}else guidance.add("Authentication is runtime-owned and has no documented auth-status probe.");ObjectNode payload=Json.object("runtimeKind",kind,"executable",executable);if(out.hasNonNull("version"))payload.set("version",out.get("version"));out.set("connectPayload",payload);return out;}
    static ObjectNode safeEnvironment(){return Json.object("PATH","PATH","HOME","HOME","USERPROFILE","USERPROFILE","TMPDIR","TMPDIR","SYSTEMROOT","SYSTEMROOT");}
    private static ObjectNode boundedProbe(JsonNode raw){ObjectNode p=(ObjectNode)raw.deepCopy();p.put("wallTimeMs",15000);p.put("maxOutputBytes",8192);return p;}
}
