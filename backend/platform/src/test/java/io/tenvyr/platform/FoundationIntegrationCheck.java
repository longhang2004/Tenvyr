package io.tenvyr.platform;

import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** Sends real browser-style requests through the shared HTTP boundary. */
public final class FoundationIntegrationCheck {
    private static int checks;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    private static final HttpClient CLIENT=HttpClient.newHttpClient();
    private static HttpResponse<String> request(Http server,String method,String origin)throws Exception {
        HttpRequest.Builder request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+server.port()+"/probe")).timeout(Duration.ofSeconds(3)).method(method,HttpRequest.BodyPublishers.noBody());
        if(origin!=null)request.header("Origin",origin);
        return CLIENT.send(request.build(),HttpResponse.BodyHandlers.ofString());
    }
    private static void noCors(HttpResponse<?> response){check(response.headers().firstValue("Access-Control-Allow-Origin").isEmpty(),"unapproved origin is never reflected");check(response.headers().firstValue("Access-Control-Allow-Credentials").isEmpty(),"unapproved origin receives no credentials permission");}
    public static void main(String[] args)throws Exception {
        for(String raw:new String[]{"*"," , ","https://trusted.test,*"})try{Http.corsOrigins(raw);throw new AssertionError("Accepted unsafe allow-list");}catch(IllegalArgumentException expected){checks++;}
        try(Http server=new Http(0)){
            check(server.address().getAddress().getHostAddress().equals("127.0.0.1"),"shared default binds IPv4 loopback");
            server.route("GET","/probe",r->Http.json(200,Json.object("ok",true)));server.start();
            check(request(server,"GET",null).statusCode()==200,"same-origin/server client works");
            for(String origin:new String[]{"https://evil.test","http://localhost:4000","null"})noCors(request(server,"GET",origin));
        }
        AtomicInteger calls=new AtomicInteger();
        try(Http server=new Http("127.0.0.1",0,"https://trusted.test, http://localhost:4000")){
            server.route("POST","/probe",r->{calls.incrementAndGet();return Http.json(200,Json.object("ok",true));});server.start();
            for(String origin:new String[]{"https://trusted.test","http://localhost:4000"}){
                HttpResponse<String> response=request(server,"POST",origin);
                check(response.statusCode()==200,"explicit origin reaches route");
                check(response.headers().firstValue("Access-Control-Allow-Origin").orElse("").equals(origin),"exact allow-list origin");
                check(response.headers().firstValue("Access-Control-Allow-Credentials").orElse("").equals("true"),"credentials only for exact origin");
            }
            for(String origin:new String[]{"https://trusted.test.evil","https://trusted.test:443","http://trusted.test","null"})noCors(request(server,"OPTIONS",origin));
            int before=calls.get();check(request(server,"OPTIONS","https://trusted.test").statusCode()==204&&calls.get()==before,"preflight never invokes business handler");
        }
        ByteArrayOutputStream diagnostics=new ByteArrayOutputStream();PrintStream original=System.err;
        try(Http server=new Http("127.0.0.1",0,null);PrintStream captured=new PrintStream(diagnostics,true,StandardCharsets.UTF_8)){
            System.setErr(captured);server.route("GET","/probe",r->{throw new IllegalStateException("sensitive-provider-response");});server.start();
            HttpResponse<String> response=request(server,"GET",null);check(response.statusCode()==500,"unexpected failure stays an internal error");
            check(!response.body().contains("sensitive-provider-response"),"unexpected error response does not expose payloads");
            check(!diagnostics.toString(StandardCharsets.UTF_8).contains("sensitive-provider-response")&&diagnostics.toString(StandardCharsets.UTF_8).contains("IllegalStateException"),"server diagnostics preserve error class without raw provider/database payloads");
        }finally{System.setErr(original);}
        System.out.println("FoundationIntegrationCheck: "+checks+" real HTTP checks passed");
    }
}
