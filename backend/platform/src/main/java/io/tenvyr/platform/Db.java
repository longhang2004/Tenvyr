package io.tenvyr.platform;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.*;
import java.time.*;
import java.util.*;
import org.postgresql.util.PGobject;

/** JDBC owns all persistent truth. A transaction pins one connection, including row locks. */
public final class Db implements AutoCloseable {
    @FunctionalInterface public interface Work<T> { T run(Db tx) throws Exception; }
    private final String url,user,password; private final Connection pinned;
    public Db(String url,String user,String password) { this(url,user,password,null); }
    private Db(String url,String user,String password,Connection pinned) { this.url=url;this.user=user;this.password=password;this.pinned=pinned; }
    public static Db fromEnv() { return new Db(env("DATABASE_URL","jdbc:postgresql://"+env("POSTGRES_HOST","localhost")+":"+env("POSTGRES_PORT","5432")+"/"+env("POSTGRES_DB","agentweave")),env("POSTGRES_USER","postgres"),env("POSTGRES_PASSWORD","postgres")); }
    public static Db on(Connection connection) { return new Db(null,null,null,Objects.requireNonNull(connection)); }
    public Connection connection() { if(pinned==null) throw new IllegalStateException("connection() requires a transaction"); return pinned; }
    private static String env(String k,String d) { return System.getenv().getOrDefault(k,d); }
    public <T> T transaction(Work<T> work) {
        if(pinned!=null) { try { return work.run(this); } catch(RuntimeException e) {throw e;} catch(Exception e) {throw new Failure(e);} }
        try(Connection c=DriverManager.getConnection(url,user,password)) {
            c.setAutoCommit(false); try { T result=work.run(new Db(url,user,password,c)); c.commit(); return result; }
            catch(Exception e) { try {c.rollback();} catch(SQLException rollback) {e.addSuppressed(rollback);} if(e instanceof RuntimeException r) throw r; throw new Failure(e); }
        } catch(SQLException e) {throw new Failure(e);}
    }
    public List<ObjectNode> query(String sql,Object... parameters) { return withConnection(c->{try(PreparedStatement p=prepare(c,sql,parameters);ResultSet r=p.executeQuery()) {List<ObjectNode> rows=new ArrayList<>();while(r.next()) rows.add(row(r));return rows;}}); }
    public ObjectNode one(String sql,Object... parameters) { List<ObjectNode> rows=query(sql,parameters); return rows.isEmpty()?null:rows.get(0); }
    public int execute(String sql,Object... parameters) { return withConnection(c->{try(PreparedStatement p=prepare(c,sql,parameters)){return p.executeUpdate();}}); }
    public boolean exists(String sql,Object... parameters) {return one(sql,parameters)!=null;}
    public static String identifier(String name) { if(!name.matches("[A-Za-z_][A-Za-z0-9_]*")) throw new IllegalArgumentException("Unsafe SQL identifier"); return "\""+name+"\""; }
    public ObjectNode insert(String table,ObjectNode fields) {
        List<String> keys=Json.keys(fields); String sql="INSERT INTO "+identifier(table)+" ("+String.join(",",keys.stream().map(Db::identifier).toList())+") VALUES ("+String.join(",",Collections.nCopies(keys.size(),"?"))+") RETURNING *";
        return one(sql,keys.stream().map(k->fieldValue(table,k,fields.get(k))).toArray());
    }
    public ObjectNode update(String table,String id,ObjectNode fields) {
        List<String> keys=Json.keys(fields); List<Object> values=new ArrayList<>();keys.forEach(k->values.add(fieldValue(table,k,fields.get(k))));values.add(UUID.fromString(id));
        return one("UPDATE "+identifier(table)+" SET "+String.join(",",keys.stream().map(k->identifier(k)+"=?").toList())+" WHERE \"id\"=? RETURNING *",values.toArray());
    }
    private <T> T withConnection(SqlWork<T> work) {try {if(pinned!=null)return work.run(pinned);try(Connection c=DriverManager.getConnection(url,user,password)){return work.run(c);}}catch(SQLException e){throw new Failure(e);}}
    @FunctionalInterface private interface SqlWork<T>{T run(Connection c)throws SQLException;}
    private static Object fieldValue(String table,String key,JsonNode value) {JsonNode column=Entities.column(table,key);if(column!=null&&Set.of("json","jsonb").contains(Json.text(column,"type"))&&(value!=null&&!value.isNull()||!Json.bool(column,"nullable",false))) {try{PGobject json=new PGobject();json.setType(Json.text(column,"type"));json.setValue(Json.stringify(value));return json;}catch(SQLException e){throw new Failure(e);}}return value;}
    private static PreparedStatement prepare(Connection c,String sql,Object[] params)throws SQLException {
        PreparedStatement p=c.prepareStatement(sql);
        for(int i=0;i<params.length;i++) {Object v=params[i]; if(v instanceof JsonNode n) {
            if(n.isNull()) v=null; else if(n.isTextual()) v=n.asText(); else if(n.isBoolean())v=n.asBoolean(); else if(n.isIntegralNumber())v=n.longValue();else if(n.isNumber())v=n.doubleValue();else {PGobject json=new PGobject();json.setType("jsonb");json.setValue(Json.stringify(n));v=json;}
        } if(v instanceof Instant instant)v=Timestamp.from(instant);if(v instanceof String)p.setObject(i+1,v,Types.OTHER);else p.setObject(i+1,v); } return p;
    }
    private static ObjectNode row(ResultSet r)throws SQLException {ObjectNode out=Json.object();ResultSetMetaData m=r.getMetaData();for(int i=1;i<=m.getColumnCount();i++){Object v=r.getObject(i);if(v instanceof PGobject p && ("json".equals(p.getType())||"jsonb".equals(p.getType())))out.set(m.getColumnLabel(i),Json.parse(p.getValue()));else if(v instanceof Timestamp t)out.put(m.getColumnLabel(i),t.toInstant().toString());else if(v instanceof java.sql.Array a)out.set(m.getColumnLabel(i),Json.value(a.getArray()));else out.set(m.getColumnLabel(i),Json.value(v instanceof UUID?v.toString():v));}return out;}
    public static final class Failure extends RuntimeException { public Failure(Throwable cause){super(cause);} public String sqlState(){Throwable e=getCause();return e instanceof SQLException s?s.getSQLState():null;} }
    @Override public void close() {}
}
