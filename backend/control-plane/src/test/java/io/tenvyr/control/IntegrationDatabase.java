package io.tenvyr.control;

import io.tenvyr.platform.*;
import java.net.URI;
import java.util.*;

/** A real disposable PostgreSQL schema; never connects to a production-named database. */
public final class IntegrationDatabase implements AutoCloseable {
    public final Db db;
    private final Db admin;
    private final String schema="control_check_"+UUID.randomUUID().toString().replace("-","");
    public String schema(){return schema;}
    public IntegrationDatabase(){
        String raw=System.getenv("TEST_DATABASE_URL");if(raw==null)raw=System.getenv("TENVYR_TEST_DATABASE_URL");
        if(raw==null)throw new IllegalArgumentException("TEST_DATABASE_URL is required");
        String user=System.getenv().getOrDefault("POSTGRES_USER","postgres"),password=System.getenv().getOrDefault("POSTGRES_PASSWORD","postgres"),url=raw;
        if(!raw.startsWith("jdbc:postgresql:")){
            URI parsed=URI.create(raw);if(!Set.of("postgres","postgresql").contains(parsed.getScheme()))throw new IllegalArgumentException("PostgreSQL required");
            if(parsed.getUserInfo()!=null){String[] auth=parsed.getUserInfo().split(":",2);user=auth[0];password=auth.length>1?auth[1]:"";}
            url="jdbc:postgresql://"+parsed.getHost()+":"+(parsed.getPort()<0?5432:parsed.getPort())+parsed.getPath();
        }
        String name=URI.create(url.substring(5)).getPath();
        if(name==null||!name.toLowerCase(Locale.ROOT).matches(".*(?:test|scratch|disposable).*"))throw new IllegalArgumentException("Disposable database name required");
        admin=new Db(url,user,password);admin.execute("CREATE SCHEMA "+Db.identifier(schema));
        db=new Db(url+(url.contains("?")?"&":"?")+"currentSchema="+schema+",public",user,password);
    }
    @Override public void close(){admin.execute("DROP SCHEMA "+Db.identifier(schema)+" CASCADE");admin.close();}
}
