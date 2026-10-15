package io.tenvyr.platform;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;

/** Small HTTP transport; authentication and business authority remain route-owned. */
public final class Http implements AutoCloseable {
    @FunctionalInterface public interface Handler { Response handle(Request request)throws Exception; }
    public record Response(int status,byte[] bytes,String contentType,Map<String,String> headers) {
        public Response(int status,byte[] bytes,String contentType){this(status,bytes,contentType,Map.of());}
    }
    public static final class Error extends RuntimeException { public final int status;public final String code;public Error(int status,String code,String message){super(message);this.status=status;this.code=code;} }
    public static final class Request {
        private final HttpExchange exchange;private final Map<String,String> params,query;private byte[] raw;
        private Request(HttpExchange exchange,Map<String,String> params){this.exchange=exchange;this.params=params;this.query=parseQuery(exchange.getRequestURI().getRawQuery());}
        public HttpExchange exchange(){return exchange;}public Map<String,String> params(){return params;}public Map<String,String> query(){return query;}public String path(String name){return params.get(name);}public String query(String name){return query.get(name);}public String header(String name){return exchange.getRequestHeaders().getFirst(name);}
        public byte[] rawBody()throws IOException{if(raw==null){raw=exchange.getRequestBody().readNBytes(1024*1024+1);if(raw.length>1024*1024)throw new Error(413,"PAYLOAD_TOO_LARGE","Request body exceeds 1 MiB");}return raw;}
        public JsonNode body()throws IOException {byte[] bytes=rawBody();if(bytes.length==0)throw new Error(400,"INVALID_JSON","Request body is required");return Json.parse(new String(bytes,StandardCharsets.UTF_8));}
    }
    private record Route(String method,Pattern pattern,List<String> names,Handler handler){}
    private final HttpServer server;private final ExecutorService executor;private final List<Route> routes=new ArrayList<>();private final Set<String> corsOrigins;
    public Http(int port){this("127.0.0.1",port);}
    public Http(String host,int port){this(host,port,System.getenv("CORS_ORIGIN"));}
    public Http(String host,int port,String cors){
        corsOrigins=corsOrigins(cors);
        try{server=HttpServer.create(new InetSocketAddress(host,port),128);}catch(IOException e){throw new IllegalStateException(e);}executor=Executors.newCachedThreadPool();server.setExecutor(executor);server.createContext("/",this::handle);
    }
    public static Set<String> corsOrigins(String raw){
        if(raw==null||raw.isEmpty())return Set.of();
        Set<String> origins=new LinkedHashSet<>();for(String origin:raw.split(",")){if(!origin.trim().isEmpty())origins.add(origin.trim());}
        if(origins.isEmpty()||origins.contains("*"))throw new IllegalArgumentException("CORS_ORIGIN requires explicit origins; wildcard is not allowed");
        return Set.copyOf(origins);
    }
    public Http route(String method,String path,Handler handler){List<String> names=new ArrayList<>();StringJoiner regex=new StringJoiner("/","^","/?$");for(String part:path.split("/",-1)){if(part.startsWith(":")){names.add(part.substring(1));regex.add("([^/]+)");}else regex.add(Pattern.quote(part));}routes.add(new Route(method.toUpperCase(Locale.ROOT),Pattern.compile(regex.toString()),names,handler));return this;}
    public void start(){server.start();}public int port(){return server.getAddress().getPort();}public InetSocketAddress address(){return server.getAddress();}
    private void handle(HttpExchange exchange)throws IOException {
        String origin=exchange.getRequestHeaders().getFirst("Origin");
        if(!corsOrigins.isEmpty())exchange.getResponseHeaders().set("Vary","Origin");
        if(origin!=null&&corsOrigins.contains(origin)){
            exchange.getResponseHeaders().set("Access-Control-Allow-Origin",origin);exchange.getResponseHeaders().set("Access-Control-Allow-Credentials","true");
            exchange.getResponseHeaders().set("Access-Control-Allow-Headers","Content-Type, Authorization, X-AgentWeave-Timestamp, X-AgentWeave-Delivery-Id, X-AgentWeave-Key-Id, X-AgentWeave-Signature");exchange.getResponseHeaders().set("Access-Control-Allow-Methods","GET, POST, PUT, PATCH, DELETE, OPTIONS");
        }
        Response response=null;
        try {
            if(exchange.getRequestMethod().equals("OPTIONS")&&!corsOrigins.isEmpty())response=new Response(204,new byte[0],"application/json");
            else for(Route route:routes){Matcher match=route.pattern().matcher(exchange.getRequestURI().getPath());if(!route.method().equals(exchange.getRequestMethod())||!match.matches())continue;Map<String,String> params=new LinkedHashMap<>();for(int i=0;i<route.names().size();i++)params.put(route.names().get(i),match.group(i+1));response=route.handler().handle(new Request(exchange,Map.copyOf(params)));break;}
            if(response==null)response=error(404,"NOT_FOUND","Route not found");
        }catch(Error e){response=error(e.status,e.code,e.getMessage());}catch(Protocol.ValidationError e){response=json(400,Json.object("statusCode",400,"error","Bad Request","message",e.getMessage(),"contract",e.contract,"issues",e.issues));}catch(IllegalArgumentException e){response=error(400,"BAD_REQUEST",e.getMessage());}catch(Exception e){System.err.println("HTTP request failed: "+e.getClass().getSimpleName()+(e instanceof Db.Failure failure?" SQLSTATE="+failure.sqlState():""));response=error(500,"INTERNAL_ERROR","Internal server error");}
        exchange.getResponseHeaders().set("Content-Type",response.contentType());response.headers().forEach((k,v)->exchange.getResponseHeaders().set(k,v));exchange.sendResponseHeaders(response.status(),response.status()==204?-1:response.bytes().length);if(response.status()!=204)exchange.getResponseBody().write(response.bytes());exchange.close();
    }
    public static Response json(int status,Object body){return new Response(status,Json.stringify(Json.value(body)).getBytes(StandardCharsets.UTF_8),"application/json; charset=utf-8");}
    public static Response error(int status,String code,String message){return json(status,Json.object("statusCode",status,"error",code,"message",message));}
    private static Map<String,String> parseQuery(String query){Map<String,String> out=new LinkedHashMap<>();if(query!=null)for(String part:query.split("&")){String[] bits=part.split("=",2);out.put(URLDecoder.decode(bits[0],StandardCharsets.UTF_8),bits.length>1?URLDecoder.decode(bits[1],StandardCharsets.UTF_8):"");}return Map.copyOf(out);}
    @Override public void close(){server.stop(1);executor.shutdownNow();}
}
