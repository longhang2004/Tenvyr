package io.tenvyr.platform;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
public final class Entities {
    private static final Map<String,JsonNode> TABLES=new LinkedHashMap<>();
    static {try(var in=Entities.class.getResourceAsStream("/db/entities.json")){for(JsonNode entity:Json.MAPPER.readTree(in))TABLES.put(entity.path("table").asText(),entity);}catch(Exception e){throw new ExceptionInInitializerError(e);}}
    private Entities(){}
    public static Set<String> tables(){return Collections.unmodifiableSet(TABLES.keySet());}
    public static JsonNode metadata(String table){JsonNode n=TABLES.get(table);if(n==null)throw new IllegalArgumentException("Unknown table "+table);return n.deepCopy();}
    public static JsonNode column(String table,String name){JsonNode entity=TABLES.get(table);if(entity!=null)for(JsonNode column:entity.path("columns"))if(column.path("name").asText().equals(name))return column;return null;}
}
