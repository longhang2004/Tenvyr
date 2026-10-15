package io.tenvyr.platform.domain;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import java.util.List;
public final class Workspace {
    public static final int PATH_MAX=4096,REPO_ROOT_MAX=4096,BRANCH_MAX=255,NOTES_MAX=1024,COMMAND_MAX=1024,ARTIFACT_MAX=255,ARTIFACT_COUNT_MAX=16;
    private Workspace(){}
    public static ObjectNode parseAcceptanceEvidence(JsonNode value){if(value==null||value.isNull()||value.isMissingNode())return null;if(!value.isObject())throw new IllegalArgumentException("acceptanceEvidence must be an object");ObjectNode result=Json.object();for(String key:List.of("testCommand","buildCommand","lintCommand","typecheckCommand")){JsonNode raw=value.get(key);if(raw==null||raw.isNull())continue;if(!raw.isTextual()||raw.asText().isEmpty())throw new IllegalArgumentException("acceptanceEvidence."+key+" must be a non-empty string");if(raw.asText().length()>1024)throw new IllegalArgumentException("acceptanceEvidence."+key+" exceeds the bound");result.set(key,raw);}JsonNode artifacts=value.get("requiredArtifacts");if(artifacts!=null&&!artifacts.isNull()){if(!artifacts.isArray()||artifacts.size()>16)throw new IllegalArgumentException("acceptanceEvidence.requiredArtifacts must be a bounded string array");ArrayNode out=Json.array();for(JsonNode artifact:artifacts){if(!artifact.isTextual())throw new IllegalArgumentException("acceptanceEvidence.requiredArtifacts must be a bounded string array");out.add(artifact.asText().substring(0,Math.min(255,artifact.asText().length())));}result.set("requiredArtifacts",out);}return result.isEmpty()?null:result;}
}
