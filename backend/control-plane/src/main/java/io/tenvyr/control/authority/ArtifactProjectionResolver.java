package io.tenvyr.control.authority;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.*;
import java.sql.Connection;
import java.util.*;

/** Resolves only canonical APPLIED success descriptors, verified against durable ordinal hashes. */
public final class ArtifactProjectionResolver {
    public record Resolution(ArrayNode references,List<String> artifactIds){}
    private final Db tx;
    public ArtifactProjectionResolver(Connection c){tx=Db.on(c);}
    public Resolution resolve(String executionId,JsonNode selectors){ArrayNode validated=ContextDomain.validateSelectors(selectors),refs=Json.array();List<String> ids=new ArrayList<>();Map<String,List<ObjectNode>> producers=new HashMap<>();
        for(JsonNode selector:validated){String source=Json.text(selector,"fromStep");List<ObjectNode> artifacts=producers.computeIfAbsent(source,s->producer(executionId,s));if(artifacts==null)continue;int matched=0;for(ObjectNode item:artifacts){JsonNode a=item.path("artifact"),d=item.path("descriptor");if(selector.has("name")&&!selector.get("name").equals(d.get("name")))continue;if(selector.has("ordinal")&&selector.path("ordinal").longValue()!=a.path("descriptorOrdinal").longValue())continue;matched++;String id=Json.text(a,"id");if(ids.contains(id))throw fail("TENVYR_CTX_ARTIFACT_OVERLAP");ids.add(id);ObjectNode ref=Json.object("artifactId",id,"producerStepId",source,"producerAttemptId",item.get("attemptId"),"descriptorOrdinal",a.get("descriptorOrdinal"));for(String key:List.of("name","mediaType","uri"))if(d.path(key).isTextual())ref.set(key,d.get(key));if(Json.bool(selector,"includeMetadata",false)&&d.path("metadata").isObject())ref.set("metadata",d.get("metadata").deepCopy());refs.add(ref);}if(matched==0)throw fail("TENVYR_CTX_ARTIFACT_FILTER_NO_MATCH");}
        if(refs.size()>128)throw fail("TENVYR_CTX_ARTIFACT_LIMIT");List<JsonNode> sorted=new ArrayList<>();refs.forEach(sorted::add);sorted.sort((a,b)->{int n=Json.localeCompare(Json.text(a,"producerStepId"),Json.text(b,"producerStepId"));if(n==0)n=Json.localeCompare(Json.text(a,"producerAttemptId"),Json.text(b,"producerAttemptId"));if(n==0)n=Integer.compare(Json.integer(a,"descriptorOrdinal",0),Json.integer(b,"descriptorOrdinal",0));if(n==0)n=Json.localeCompare(Json.text(a,"artifactId"),Json.text(b,"artifactId"));return n;});ArrayNode ordered=Json.array();sorted.forEach(ordered::add);return new Resolution(ordered,List.copyOf(ids));
    }
    private List<ObjectNode> producer(String execution,String source){ObjectNode step=tx.one("SELECT * FROM step_executions WHERE \"executionId\"=?::uuid AND \"stepId\"=?",execution,source);if(step==null)throw fail("TENVYR_CTX_ARTIFACT_PRODUCER_MISSING");ObjectNode attempt=tx.one("SELECT * FROM step_attempts WHERE \"logicalStepId\"=?::uuid AND status='SUCCESS' ORDER BY \"attemptNumber\" DESC LIMIT 1",step.get("id"));if(attempt==null)return null;if(!execution.equals(Json.text(attempt,"executionId")))throw fail("TENVYR_CTX_FOREIGN_ARTIFACT");ObjectNode inbox=tx.one("SELECT * FROM result_inbox WHERE \"stepAttemptId\"=?::uuid AND status='APPLIED'",attempt.get("id"));if(inbox==null)return null;List<ObjectNode> out=new ArrayList<>();for(ObjectNode artifact:tx.query("SELECT * FROM artifacts WHERE \"resultInboxId\"=?::uuid ORDER BY \"descriptorOrdinal\"",inbox.get("id"))){JsonNode d=inbox.path("payload").path("artifacts").get(Json.integer(artifact,"descriptorOrdinal",-1));if(d==null||!Json.hash(d).equals(Json.text(artifact,"descriptorHash")))throw fail("TENVYR_CTX_ARTIFACT_ORDINAL_MISMATCH");out.add(Json.object("artifact",artifact,"descriptor",d,"attemptId",attempt.get("id")));}return out;}
    private static AuthorityError fail(String code){return new AuthorityError(code,code);}
}
