package io.tenvyr.platform;

import java.net.URI;
import java.util.*;

/** Called by the original-TypeORM/Java schema comparison harness on disposable schemas only. */
public final class MigrationIntegrationCheck {
    public static void main(String[] args){
        if(args.length!=3)throw new IllegalArgumentException("migrate|revert schema expected-count");
        String url=System.getenv("TENVYR_TEST_JDBC_URL"),schema=args[1];Db.identifier(schema);
        if(url==null||!URI.create(url.substring(5)).getPath().matches(".*(?:test|scratch|disposable).*"))throw new IllegalArgumentException("Disposable PostgreSQL test URL required");
        Db db=new Db(url+(url.contains("?")?"&":"?")+"currentSchema="+schema+",public",System.getenv().getOrDefault("POSTGRES_USER","postgres"),System.getenv().getOrDefault("POSTGRES_PASSWORD","postgres"));
        int count=0;
        if(args[0].equals("migrate"))count=Migrator.migrate(db).size();
        else if(args[0].equals("revert")){while(Migrator.revert(db)!=null)count++;}
        else throw new IllegalArgumentException("Unknown migration operation");
        if(count!=Integer.parseInt(args[2]))throw new AssertionError("Expected "+args[2]+" migrations, got "+count);
        System.out.println("MigrationIntegrationCheck: "+args[0]+" executed "+count);
    }
}
