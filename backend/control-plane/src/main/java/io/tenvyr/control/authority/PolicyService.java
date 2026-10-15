package io.tenvyr.control.authority;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import java.sql.Connection;
import java.util.function.Supplier;

/** Trusted configuration freezes once per version; every decision commits with its action. */
public final class PolicyService {
    private final Db db; private final Supplier<String> configuration;
    public PolicyService(Db db){this(db,()->System.getenv("TENVYR_POLICY"));}
    public PolicyService(Db db,Supplier<String> configuration){this.db=db;this.configuration=configuration;}
    public boolean isConfigured(){String v=configuration.get();return v!=null&&!v.trim().isEmpty();}
    public ObjectNode configuredSnapshot(){String v=configuration.get();if(v==null||v.trim().isEmpty())throw new AuthorityError("SNAPSHOT_NOT_FOUND","Policy is not configured");try{return PolicyDomain.snapshot(Json.parse(v));}catch(AuthorityError e){throw e;}catch(RuntimeException e){throw new AuthorityError("POLICY_CONFIG_INVALID","TENVYR_POLICY must be valid policy JSON");}}
    public ObjectNode loadSnapshot(Connection c){return c==null?db.transaction(t->load(t)):load(Db.on(c));}
    private ObjectNode load(Db tx){ObjectNode config=configuredSnapshot();tx.execute("INSERT INTO policy_snapshots (version,hash,rules) VALUES (?,?,?) ON CONFLICT (version) DO NOTHING",config.get("version"),config.get("hash"),config.get("rules"));ObjectNode row=tx.one("SELECT * FROM policy_snapshots WHERE version=?",config.get("version"));if(row==null)throw new IllegalStateException("Policy freeze produced no row");if(!row.get("hash").equals(config.get("hash")))throw new AuthorityError("POLICY_VERSION_CONFLICT","Policy version is frozen with different rules; bump the version");return Json.object("version",row.get("version"),"hash",row.get("hash"),"rules",row.get("rules"));}
    public ObjectNode evaluate(JsonNode proposal,Connection c){return c==null?db.transaction(t->evaluate(proposal,t.connection())):evaluate(proposal,Db.on(c));}
    private ObjectNode evaluate(JsonNode p,Db tx){ObjectNode d=PolicyDomain.evaluate(p,load(tx));JsonNode s=p.path("scope"),target=p.path("target");tx.insert("policy_decisions",Json.object("proposalId",p.get("proposalId"),"actionType",p.get("actionType"),"executionId",s.get("executionId"),"logicalStepId",Json.get(s,"logicalStepId"),"attemptNumber",Json.get(s,"attemptNumber"),"targetAgent",Json.get(target,"agent"),"targetExecutor",Json.get(target,"executor"),"proposalHash",p.get("hash"),"policyVersion",d.get("policyVersion"),"policyHash",d.get("policyHash"),"effect",d.get("effect"),"reasons",d.get("reasons")));return d;}
}
