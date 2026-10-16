package io.tenvyr.platform;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;

/** Preserves TypeORM's migration ledger, exact SQL and all-or-nothing migration batch. */
public final class Migrator {
    private static final long MIGRATION_LOCK=1722270000000L;
    private static final JsonNode LEDGER=resource("migrations.json");
    private Migrator(){}
    private static JsonNode resource(String name){try(var in=Migrator.class.getResourceAsStream("/db/"+name)){if(in==null)throw new IllegalStateException("Missing migration resource "+name);return Json.MAPPER.readTree(in);}catch(Exception e){throw new IllegalStateException(e);}}
    public static JsonNode ledger(){return LEDGER.deepCopy();}
    private static void lock(Db tx){tx.query("SELECT pg_advisory_xact_lock(?)",MIGRATION_LOCK);tx.execute("CREATE TABLE IF NOT EXISTS \"migrations\" (\"id\" SERIAL NOT NULL, \"timestamp\" bigint NOT NULL, \"name\" varchar NOT NULL, CONSTRAINT \"PK_8c82d7f526340ab734260ea46be\" PRIMARY KEY (\"id\"))");}
    public static List<String> migrate(Db db){return db.transaction(tx->{lock(tx);Set<String> applied=new HashSet<>();for(ObjectNode row:tx.query("SELECT \"timestamp\",\"name\" FROM \"migrations\" ORDER BY \"id\""))applied.add(Json.text(row,"name"));List<String> executed=new ArrayList<>();for(JsonNode migration:LEDGER){String name=Json.text(migration,"name");if(applied.contains(name))continue;for(JsonNode statement:resource(Json.text(migration,"up")))tx.execute(statement.asText());tx.execute("INSERT INTO \"migrations\" (\"timestamp\",\"name\") VALUES (?,?)",migration.path("timestamp").asLong(),name);executed.add(name);}return List.copyOf(executed);});}
    public static String revert(Db db){return db.transaction(tx->{lock(tx);ObjectNode latest=tx.one("SELECT * FROM \"migrations\" ORDER BY \"timestamp\" DESC,\"id\" DESC LIMIT 1");if(latest==null)return null;String name=Json.text(latest,"name");JsonNode found=null;for(JsonNode entry:LEDGER)if(name.equals(Json.text(entry,"name")))found=entry;if(found==null)throw new IllegalStateException("Unknown recorded migration "+name);
        if(name.equals("MilestoneZeroFoundation1722270000000")){ObjectNode evidence=tx.one("SELECT EXISTS (SELECT 1 FROM \"step_attempts\" a JOIN \"execution_plan_revisions\" r ON r.\"id\"=a.\"planRevisionId\" WHERE r.\"source\" <> 'legacy_backfill') AS \"hasAuthoritativeAttempts\"");if(Json.bool(evidence,"hasAuthoritativeAttempts",false))throw new IllegalStateException("Milestone Zero foundation rollback is only supported before immutable runtime attempts exist; apply a forward fix instead.");}
        for(JsonNode statement:resource(Json.text(found,"down")))tx.execute(statement.asText());tx.execute("DELETE FROM \"migrations\" WHERE \"id\"=?",latest.path("id").asInt());return name;});}
    public static void migrateFromEnv(Db db){if(!"false".equals(System.getenv("TENVYR_DB_MIGRATIONS")))migrate(db);}
}
