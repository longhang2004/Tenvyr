package io.tenvyr.gateway;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import io.netty.buffer.*;
import io.netty.channel.*;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.handler.codec.http.*;
import io.netty.handler.codec.http.websocketx.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Exercises the actual Netty handlers without requiring an operating-system listener. */
public final class GatewayPureCheck {
    private static int checks;
    private static final List<EmbeddedChannel> channels=new ArrayList<>();
    public static void main(String[] args)throws Exception {
        try {origins();files();polling();websocket();upgrade();expiry();}
        finally {for(EmbeddedChannel channel:channels)channel.finishAndReleaseAll();}
        System.out.println("GatewayPureCheck: "+checks+" checks passed (filesystem, CORS, polling, framed WebSocket, upgrade, expiry)");
    }
    private static void origins() {
        LocalOrigin defaults=new LocalOrigin(null);
        check(!defaults.enabled()&&!defaults.httpAllowed("http://localhost:4000"),"HTTP CORS defaults off");
        for(String origin:new String[]{null,"http://localhost:4000","https://127.0.0.1:4000","http://[::1]:4000"})check(defaults.socketAllowed(origin),"loopback/non-browser Socket.IO");
        for(String origin:new String[]{"null","https://localhost.evil","file://localhost/path","https://192.168.1.1","broken"})check(!defaults.socketAllowed(origin),"remote Socket.IO denied");
        LocalOrigin explicit=new LocalOrigin("https://one.test, http://localhost:4000");
        check(explicit.httpAllowed("https://one.test")&&!explicit.httpAllowed("https://two.test"),"exact HTTP allowlist");
        check(!explicit.socketAllowed("http://localhost:3000")&&explicit.socketAllowed(null),"explicit Socket.IO allowlist");
        for(String value:new String[]{"*","https://one.test,*",", "})rejects(()->new LocalOrigin(value),"wildcard/empty CORS");
    }
    private static void files()throws Exception {
        Path root=Files.createTempDirectory("gateway-pure"),home=root.resolve("home");
        try {
            for(String name:List.of("home","alpha","Zoo",".hidden"))Files.createDirectory(root.resolve(name));
            Files.writeString(root.resolve("file"),"data");Files.createSymbolicLink(root.resolve("link"),root.resolve("alpha"));
            GatewayRoutes routes=new GatewayRoutes("http://127.0.0.1:1",(id,data)->{},root,home);
            JsonNode response=Json.parse(routes.directories("").body());
            check(response.path("directories").equals(Json.array("alpha","home","Zoo")),"hidden/files/symlinks omitted, locale order");
            check(response.path("currentPath").asText().equals(root.toString()),"configured frontend cwd namespace");
            check(Json.parse(routes.directories("~").body()).path("currentPath").asText().equals(home.toString()),"home expansion");
            check(Json.parse(routes.directories("link").body()).path("currentPath").asText().equals(root.resolve("link").toString()),"stat follows requested symlink, preserves lexical path");
            check(routes.directories("file").status()==400&&routes.directories("missing").status()==400,"filesystem errors");
            check(Json.parse(routes.directories("/").body()).path("parentPath").isNull(),"root has no parent");
            check(GatewayRoutes.ROUTES.size()==46,"all 46 forwarded routes plus root/health/workbench/webhook and filesystem");
            check(new HashSet<>(GatewayRoutes.ROUTES.stream().map(r->r.method()+" "+r.pattern()).toList()).size()==46,"distinct route contract");
            check(routes.handle("GET","/workbench",Map.of(),"").body().toLowerCase(Locale.ROOT).contains("<!doctype html>"),"real workbench resource");
            check(routes.handle("GET","/health",Map.of(),"").status()==200,"health route");
            check(routes.handle("POST","/api/pipelines",Map.of(),"null").status()==400,"Express strict JSON body parity");
            check(routes.handle("POST","/api/pipelines",Map.of(),"{broken").status()==400,"invalid JSON rejected before forwarding");
            check(routes.handle("GET","/unknown",Map.of(),"").status()==404,"unknown route");
        } finally {try(var paths=Files.walk(root)){for(Path file:paths.sorted(Comparator.reverseOrder()).toList())Files.delete(file);}}
    }
    private static void polling() {
        try(SocketIo sockets=new SocketIo(new LocalOrigin(null),60_000,60_000)) {
            String sid=open(sockets),path=poll(sid);
            FullHttpResponse version=response(call(sockets,"GET","/socket.io/?EIO=3&transport=polling",null,null));check(version.status().code()==400,"Engine.IO version guard");version.release();
            FullHttpResponse forbidden=response(call(sockets,"GET","/socket.io/?EIO=4&transport=polling",null,"https://remote.test"));
            check(forbidden.status().code()==403&&!forbidden.headers().contains(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN),"remote CORS fails closed");forbidden.release();
            FullHttpResponse preflight=response(call(sockets,"OPTIONS","/socket.io/?EIO=4&transport=polling",null,"http://localhost:4000"));
            check(preflight.status().code()==204&&preflight.headers().get(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN).equals("http://localhost:4000"),"Socket.IO preflight CORS");preflight.release();
            check(body(call(sockets,"POST",path,"40",null)).equals("ok"),"Engine.IO POST ack");
            check(body(call(sockets,"GET",path,null,null)).startsWith("40{\"sid\":"),"Socket.IO namespace connect");
            EmbeddedChannel waiting=call(sockets,"GET",path,null,"http://localhost:4000");check(waiting.readOutbound()==null,"poll held until event");
            sockets.broadcast("execution-test",Json.object("state","COMPLETED"));event(body(waiting));
            check(body(call(sockets,"POST",path,"42[\"client-event\",{}]\u001e3",null)).equals("ok"),"packet separator and valid ignored inbound event");
            EmbeddedChannel pending=call(sockets,"GET",path,null,null),duplicate=call(sockets,"GET",path,null,null);
            FullHttpResponse rejected=response(duplicate);check(rejected.status().code()==400,"duplicate poll rejected");rejected.release();
            check(body(pending).equals("1"),"duplicate poll closes original session");
            FullHttpResponse removed=response(call(sockets,"GET",path,null,null));check(removed.status().code()==400,"closed session removed");removed.release();
            String recovered=open(sockets);check(!recovered.equals(sid),"client reconnect gets a fresh session");
            String invalid=open(sockets);body(call(sockets,"POST",poll(invalid),"40",null));body(call(sockets,"GET",poll(invalid),null,null));
            body(call(sockets,"POST",poll(invalid),"42[\"disconnect\"]",null));
            FullHttpResponse invalidEvent=response(call(sockets,"GET",poll(invalid),null,null));check(invalidEvent.status().code()==400,"reserved Socket.IO event rejected");invalidEvent.release();
        }
    }
    private static void websocket() {
        try(SocketIo sockets=new SocketIo(new LocalOrigin(null),60_000,60_000);Wire wire=new Wire(sockets,null)) {
            JsonNode opening=Json.parse(wire.text().substring(1));check(opening.path("upgrades").isEmpty(),"direct WebSocket has no further upgrades");
            wire.send("40{\"token\":\"local\"}");check(wire.text().startsWith("40{"),"framed WebSocket namespace connect");
            sockets.broadcast("execution-test",Json.object("state","COMPLETED"));event(wire.text());
            wire.channel.writeInbound(encoded(new PingWebSocketFrame(Unpooled.wrappedBuffer(new byte[]{7}))));
            WebSocketFrame pong=wire.frame();check(pong instanceof PongWebSocketFrame&&pong.content().readByte()==7,"RFC6455 ping/pong");pong.release();
            wire.send("41");sockets.broadcast("execution-test",Json.object());check(wire.frameOrNull()==null,"namespace disconnect stops events");
            wire.send("40");check(wire.text().startsWith("40{"),"namespace can reconnect on same Engine.IO transport");
        }
    }
    private static void upgrade() {
        try(SocketIo sockets=new SocketIo(new LocalOrigin(null),60_000,60_000)) {
            String sid=open(sockets);body(call(sockets,"POST",poll(sid),"40",null));body(call(sockets,"GET",poll(sid),null,null));
            EmbeddedChannel waiting=call(sockets,"GET",poll(sid),null,null);
            try(Wire wire=new Wire(sockets,sid)) {
                check(wire.frameOrNull()==null,"upgrade has no duplicate open packet");
                wire.send("2probe");check(wire.text().equals("3probe"),"Engine.IO upgrade probe");check(body(waiting).equals("6"),"old pending poll drained with noop");
                wire.send("5");sockets.broadcast("execution-test",Json.object("state","COMPLETED"));event(wire.text());
                FullHttpResponse rejected=response(call(sockets,"GET",poll(sid),null,null));check(rejected.status().code()==400,"polling disabled after WebSocket upgrade");rejected.release();
            }
        }
    }
    private static void expiry()throws Exception {
        try(SocketIo sockets=new SocketIo(new LocalOrigin(null),5,5,60_000,60_000,false)) {
            String sid=open(sockets);Thread.sleep(8);sockets.heartbeat();check(body(call(sockets,"GET",poll(sid),null,null)).equals("2"),"server heartbeat ping");
            body(call(sockets,"POST",poll(sid),"3",null));Thread.sleep(8);sockets.heartbeat();check(body(call(sockets,"GET",poll(sid),null,null)).equals("2"),"pong schedules next ping");
            EmbeddedChannel pending=call(sockets,"GET",poll(sid),null,null);Thread.sleep(8);sockets.heartbeat();check(body(pending).equals("1"),"missed pong expires and releases pending poll");
        }
        try(SocketIo sockets=new SocketIo(new LocalOrigin(null),60_000,60_000,5,60_000,false)) {
            String sid=open(sockets);EmbeddedChannel pending=call(sockets,"GET",poll(sid),null,null);Thread.sleep(8);sockets.heartbeat();check(body(pending).equals("1"),"missing namespace connect expires session");
        }
        try(SocketIo sockets=new SocketIo(new LocalOrigin(null),60_000,60_000,60_000,5,false)) {
            String sid=open(sockets);try(Wire abandoned=new Wire(sockets,sid)){Thread.sleep(8);sockets.heartbeat();check(!abandoned.channel.isOpen(),"abandoned upgrade expires candidate only");}
            body(call(sockets,"POST",poll(sid),"40",null));check(body(call(sockets,"GET",poll(sid),null,null)).startsWith("40{"),"polling session survives upgrade timeout");
        }
    }
    private static EmbeddedChannel call(SocketIo sockets,String method,String path,String payload,String origin) {
        EmbeddedChannel channel=new EmbeddedChannel(new SimpleChannelInboundHandler<FullHttpRequest>() {
            @Override protected void channelRead0(ChannelHandlerContext ctx,FullHttpRequest request){check(sockets.handle(ctx,request,new QueryStringDecoder(request.uri())),"Socket.IO request routed");}
        });channels.add(channel);
        FullHttpRequest request=new DefaultFullHttpRequest(HttpVersion.HTTP_1_1,HttpMethod.valueOf(method),path,Unpooled.copiedBuffer(payload==null?"":payload,StandardCharsets.UTF_8));
        if(origin!=null)request.headers().set(HttpHeaderNames.ORIGIN,origin);
        channel.writeInbound(request);return channel;
    }
    private static FullHttpResponse response(EmbeddedChannel channel){channel.runPendingTasks();FullHttpResponse response=channel.readOutbound();if(response==null)throw new AssertionError("Expected HTTP response");return response;}
    private static String body(EmbeddedChannel channel){FullHttpResponse response=response(channel);try{return response.content().toString(StandardCharsets.UTF_8);}finally{response.release();}}
    private static String open(SocketIo sockets){JsonNode opening=Json.parse(body(call(sockets,"GET","/socket.io/?EIO=4&transport=polling",null,null)).substring(1));check(opening.path("maxPayload").asInt()==1_000_000&&opening.path("upgrades").equals(Json.array("websocket")),"Engine.IO open packet contract");return opening.path("sid").asText();}
    private static String poll(String sid){return "/socket.io/?EIO=4&transport=polling&sid="+sid;}
    private static void event(String packet){check(packet.startsWith("42"),"Socket.IO event frame");JsonNode value=Json.parse(packet.substring(2));check(value.get(0).asText().equals("execution-update"),"event name");JsonNode data=value.get(1);check(data.path("executionId").asText().equals("execution-test")&&data.has("data")&&data.path("timestamp").asText().matches(".*\\.\\d{3}Z"),"retained event shape and timestamp");}
    private static ByteBuf encoded(WebSocketFrame frame){EmbeddedChannel encoder=new EmbeddedChannel(new WebSocket13FrameEncoder(true));encoder.writeOutbound(frame);ByteBuf bytes=encoder.readOutbound();encoder.finishAndReleaseAll();return bytes;}
    private static final class Wire implements AutoCloseable {
        final EmbeddedChannel channel,decoder=new EmbeddedChannel(new WebSocket13FrameDecoder(false,false,SocketIo.MAX_PAYLOAD));
        Wire(SocketIo sockets,String sid){
            channel=new EmbeddedChannel(new HttpServerCodec(),new HttpObjectAggregator(SocketIo.MAX_PAYLOAD),new SimpleChannelInboundHandler<FullHttpRequest>(){
                @Override protected void channelRead0(ChannelHandlerContext ctx,FullHttpRequest request){check(sockets.handle(ctx,request,new QueryStringDecoder(request.uri())),"WebSocket request routed");}
            });channels.add(channel);
            String uri="/socket.io/?EIO=4&transport=websocket"+(sid==null?"":"&sid="+sid);
            channel.writeInbound(Unpooled.copiedBuffer("GET "+uri+" HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",StandardCharsets.US_ASCII));
            channel.runPendingTasks();ByteBuf response=channel.readOutbound();check(response!=null&&response.toString(StandardCharsets.US_ASCII).startsWith("HTTP/1.1 101"),"actual HTTP upgrade handshake");if(response!=null)response.release();
        }
        void send(String text){channel.writeInbound(encoded(new TextWebSocketFrame(text)));channel.runPendingTasks();}
        WebSocketFrame frameOrNull(){channel.runPendingTasks();ByteBuf bytes;while((bytes=channel.readOutbound())!=null)decoder.writeInbound(bytes);return decoder.readInbound();}
        WebSocketFrame frame(){WebSocketFrame frame=frameOrNull();if(frame==null)throw new AssertionError("Expected WebSocket frame");return frame;}
        String text(){WebSocketFrame frame=frame();try{check(frame instanceof TextWebSocketFrame,"text WebSocket frame");return ((TextWebSocketFrame)frame).text();}finally{frame.release();}}
        @Override public void close(){channel.finishAndReleaseAll();decoder.finishAndReleaseAll();}
    }
    private static void rejects(Runnable run,String label){try{run.run();throw new AssertionError("Accepted "+label);}catch(IllegalArgumentException expected){checks++;}}
    private static void check(boolean value,String label){checks++;if(!value)throw new AssertionError(label);}
}
