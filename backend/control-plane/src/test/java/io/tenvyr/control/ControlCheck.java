package io.tenvyr.control;

import io.tenvyr.platform.*;
import io.tenvyr.control.authority.ExecutionCapsuleService;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import com.fasterxml.jackson.databind.node.ObjectNode;

public final class ControlCheck {
    private static int checks;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args.length>0?args[0]:".");
        for(var vector:Json.parse(Files.readString(root.resolve("backend/control-plane/src/test/resources/node-capsule-hashes.json"))))check(ExecutionCapsuleService.contentHash((ObjectNode)vector.get("capsule")).equals(vector.path("hash").asText()),"original Node capsule Date/hash parity");
        var pipeline=ControlRoutes.pipelineInput(Json.object("yamlString","name: demo\nsteps:\n  - id: first\n    agent: reviewer\n"));
        check(pipeline.path("name").asText().equals("demo")&&pipeline.path("steps").size()==1,"safe YAML pipeline input");
        check(pipeline.path("version").asText().equals("1.0"),"pipeline version default");
        try{ControlRoutes.pipelineInput(Json.object("yamlString","!!java.net.URL [https://evil.test]"));throw new AssertionError("Unsafe YAML tag accepted");}catch(RuntimeException expected){checks++;}
        check(ControlRoutes.eventLimit("2.5")==50&&ControlRoutes.eventLimit("1000")==200&&ControlRoutes.eventLimit("0")==1,"bounded event pagination");
        try{ControlRoutes.eventCursor("2026-10-15T00:00:00Z",null);throw new AssertionError("Partial cursor accepted");}catch(IllegalArgumentException expected){checks++;}
        check(ControlRoutes.positivePage("-1")==1&&ControlRoutes.positivePage("2tail")==2,"legacy integer page parsing");
        var missing=ControlRoutes.domainError("connection","CONNECTION_NOT_FOUND","missing");
        check(missing.status()==404&&Json.parse(new String(missing.bytes(),StandardCharsets.UTF_8)).path("statusCode").asInt()==404,"legacy error envelope and status");
        var oauth=ControlRoutes.domainError("provider","AUTH_FLOW_EXPIRED","expired");
        check(oauth.status()==422,"provider domain status preserved");
        check(ControlRoutes.envelope(Json.object()).has("meta"),"operator response metadata");
        System.out.println("ControlCheck: "+checks+" checks passed");
    }
}
