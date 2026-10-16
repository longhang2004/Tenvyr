package io.tenvyr.operations;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import java.util.*;

/** Snapshot identity belongs to the restored dump, never the advancing live authority. */
public final class Anchors {
    public static final List<String> TABLES=List.of("pipelines","executions","execution_plan_revisions","plan_proposals","step_executions","step_attempts","workspaces","dispatch_outbox","result_inbox","result_conflicts","agent_events","agent_event_conflicts","policy_snapshots","policy_decisions","budget_accounts","budget_reservations","budget_ledger_entries","approval_requests","artifacts","artifact_exposures","state_write_evidence","execution_replays","execution_exports","delegation_requests","delegation_observations","delegation_request_conflicts","delegation_observation_conflicts","runtime_connections","connection_revisions","model_sources","coordination_runs","coordination_iterations","operator_actions","workspace_executions","workspace_release_locks","handoffs");
    public static final List<String> REQUIRED=List.of("migrationLedgerFingerprint","tableCountFingerprint","planRevisionHashFingerprint");
    @FunctionalInterface public interface Query {String run(String database,String sql)throws Exception;}
    private Anchors(){}
    public static String inventory(){return String.join(", ",TABLES);}
    public static String tableCountsSql(){return "SELECT "+String.join(", ",TABLES.stream().map(t->"(SELECT count(*) FROM "+t+") AS \""+t+"\"").toList());}
    public static ObjectNode snapshot(Query run,String database)throws Exception {
        String ledger=run.run(database,"SELECT COALESCE(string_agg(name, '|' ORDER BY name), '') AS value FROM migrations");
        String line=run.run(database,tableCountsSql());String[] counts=line==null?new String[0]:line.split("\\|",-1);
        String plans=run.run(database,"SELECT COALESCE(string_agg(\"planHash\", '|' ORDER BY \"executionId\", \"revisionNumber\"), '') AS value FROM execution_plan_revisions");
        ObjectNode result=Json.object("migrationLedgerFingerprint",ledger==null?null:Json.sha256(ledger),"tableCountFingerprint",null,"planRevisionHashFingerprint",plans==null?null:Json.sha256(plans));
        if(counts.length==TABLES.size()&&Arrays.stream(counts).allMatch(v->v.matches("[0-9]+"))){StringJoiner canonical=new StringJoiner(",");for(int i=0;i<counts.length;i++)canonical.add(TABLES.get(i)+":"+counts[i]);result.put("tableCountFingerprint",Json.sha256(canonical.toString()));}
        String first=run.run(database,"SELECT id AS value FROM executions ORDER BY \"createdAt\" LIMIT 1");result.set("executionAnchor",first==null||first.isEmpty()?NullNode.instance:TextNode.valueOf(first));
        String terminal=run.run(database,"SELECT id AS value FROM executions WHERE status IN ('COMPLETED','FAILED','CANCELLED') ORDER BY \"updatedAt\" DESC LIMIT 1");
        result.set("capsuleAnchor",NullNode.instance);
        if(terminal!=null&&!terminal.isEmpty()){UUID.fromString(terminal);String exports=run.run(database,"SELECT string_agg(id || ':' || \"capsuleHash\", '|' ORDER BY id) AS value FROM execution_exports WHERE \"executionId\" = '"+terminal+"'");if(exports==null)throw new IllegalStateException("Could not read capsule exports");result.set("capsuleAnchor",Json.object("executionId",terminal,"exportIds",exports.isEmpty()?Json.array():Json.value(Arrays.asList(exports.split("\\|")))));}
        return result;
    }
    public static void validateManifest(JsonNode manifest,String dumpChecksum,String sidecarChecksum,String version){
        if(manifest==null||!manifest.isObject())throw new IllegalArgumentException("backup manifest is missing — refusing to restore");
        String checksum=Json.text(manifest,"checksum");if(checksum==null||!checksum.matches("[0-9a-f]{64}"))throw new IllegalArgumentException("backup manifest checksum is missing or malformed");
        if(!checksum.equals(dumpChecksum)||sidecarChecksum!=null&&!checksum.equals(sidecarChecksum))throw new IllegalArgumentException("checksum mismatch — refusing to restore");
        if(!manifest.path("verified").isBoolean()||!manifest.path("verified").asBoolean())throw new IllegalArgumentException("backup manifest is not a VERIFIED backup");
        if(!Objects.equals(version,Json.text(manifest,"version")))throw new IllegalArgumentException("backup version does not match deployment");
        if(!manifest.path("algorithm").asText().equals("sha256"))throw new IllegalArgumentException("unsupported backup checksum algorithm");
        if(!manifest.path("sourceRevision").asText().matches("[0-9a-f]{40}"))throw new IllegalArgumentException("backup manifest sourceRevision must be a full git commit SHA");
        for(String key:REQUIRED)if(!manifest.path("anchors").path(key).asText().matches("[0-9a-f]{64}"))throw new IllegalArgumentException("backup manifest required anchor \""+key+"\" is missing or malformed");
        if(!manifest.path("tables").asText().equals(inventory()))throw new IllegalArgumentException("backup manifest inventory does not match the current authority inventory");
    }
    public static List<String> compare(JsonNode expected,JsonNode actual){List<String> failures=new ArrayList<>();if(expected==null||!expected.isObject()||!expected.has("migrationLedgerFingerprint"))return List.of("backup manifest predates snapshot anchors");for(String key:List.of("migrationLedgerFingerprint","tableCountFingerprint","planRevisionHashFingerprint","executionAnchor","capsuleAnchor")){JsonNode value=expected.get(key);if(value!=null&&!value.isNull()&&!value.equals(actual.path(key)))failures.add(key+" mismatch: backup manifest="+value+" restored="+actual.path(key));}return failures;}
}
