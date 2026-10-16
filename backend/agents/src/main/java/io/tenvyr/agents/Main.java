package io.tenvyr.agents;

import com.sun.net.httpserver.*;
import io.tenvyr.platform.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;

public final class Main {
    public static void main(String[] args)throws Exception {
        String agent=args.length>0?args[0]:System.getenv().getOrDefault("AGENT_NAME","code-reviewer");
        Map<String,String> env=System.getenv();
        AgentProcessor processor=new AgentProcessor(agent,env.getOrDefault("AGENT_RUNNER_URL","http://localhost:8085"),Path.of(env.getOrDefault("TENVYR_ROOT",System.getProperty("user.dir")),"skills"));
        KafkaAgent kafka=new KafkaAgent(processor,env.getOrDefault("KAFKA_BROKERS","localhost:9092"));
        int port=Integer.parseInt(env.getOrDefault("PORT",agent.equals("code-reviewer")?"3002":"3003"));
        HttpServer server;
        try {kafka.start();server=HttpServer.create(new InetSocketAddress(port),128);}
        catch(Exception|Error e) {kafka.close();throw e;}
        server.createContext("/",exchange->{
            String path=exchange.getRequestURI().getPath();boolean health=path.equals("/health")||path.equals("/health/");
            int status=200;
            var data=health?Json.object("status","UP","service","agent-"+agent):Json.object("message","Welcome to Tenvyr "+(agent.equals("code-reviewer")?"Code Reviewer":"Observability")+" Agent API");
            var body=Json.object("success",true,"data",data,"error",null,"meta",Json.object("timestamp",Protocol.jsInstant(Instant.now())));
            if(exchange.getRequestMethod().equals("OPTIONS"))status=204;
            else if((!exchange.getRequestMethod().equals("GET")&&!exchange.getRequestMethod().equals("HEAD"))||(!health&&!path.equals("/"))) {status=404;body=Json.object("message","Cannot "+exchange.getRequestMethod()+" "+path,"error","Not Found","statusCode",404);}
            byte[] bytes=Json.stringify(body).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");exchange.getResponseHeaders().set("Access-Control-Allow-Origin","*");
            if(status==204){exchange.getResponseHeaders().set("Access-Control-Allow-Methods","GET,HEAD,PUT,PATCH,POST,DELETE");String requested=exchange.getRequestHeaders().getFirst("Access-Control-Request-Headers");if(requested!=null)exchange.getResponseHeaders().set("Access-Control-Allow-Headers",requested);}
            if(exchange.getRequestMethod().equals("HEAD"))exchange.getResponseHeaders().set("Content-Length",Integer.toString(bytes.length));
            exchange.sendResponseHeaders(status,status==204||exchange.getRequestMethod().equals("HEAD")?-1:bytes.length);if(status!=204&&!exchange.getRequestMethod().equals("HEAD"))exchange.getResponseBody().write(bytes);exchange.close();
        });
        server.start();Runtime.getRuntime().addShutdownHook(new Thread(()->{server.stop(1);kafka.close();}));
        System.out.println("Agent "+agent+" listening on http://localhost:"+port);
    }
}
