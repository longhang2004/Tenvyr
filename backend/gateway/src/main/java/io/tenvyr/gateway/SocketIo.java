package io.tenvyr.gateway;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;
import io.tenvyr.platform.Protocol;
import io.netty.channel.*;
import io.netty.handler.codec.http.*;
import io.netty.handler.codec.http.websocketx.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/** Engine.IO v4 and Socket.IO v5 default namespace, used by the existing dashboard. */
public final class SocketIo implements AutoCloseable {
    public static final int MAX_PAYLOAD=1_000_000;
    private final Map<String,Session> sessions=new ConcurrentHashMap<>();
    private final ScheduledExecutorService clock=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"gateway-heartbeat");t.setDaemon(true);return t;});
    private final LocalOrigin origins;
    private final long pingInterval,pingTimeout,connectTimeout,upgradeTimeout;
    public SocketIo(LocalOrigin origins) { this(origins,25_000,20_000); }
    public SocketIo(LocalOrigin origins,long pingInterval,long pingTimeout) { this(origins,pingInterval,pingTimeout,45_000,10_000); }
    SocketIo(LocalOrigin origins,long pingInterval,long pingTimeout,long connectTimeout,long upgradeTimeout) {this(origins,pingInterval,pingTimeout,connectTimeout,upgradeTimeout,true);}
    SocketIo(LocalOrigin origins,long pingInterval,long pingTimeout,long connectTimeout,long upgradeTimeout,boolean scheduleHeartbeat) {
        if(pingInterval<=0||pingTimeout<=0||connectTimeout<=0||upgradeTimeout<=0)throw new IllegalArgumentException("Socket.IO timeouts must be positive");
        this.origins=origins;this.pingInterval=pingInterval;this.pingTimeout=pingTimeout;this.connectTimeout=connectTimeout;this.upgradeTimeout=upgradeTimeout;
        if(scheduleHeartbeat)clock.scheduleAtFixedRate(this::heartbeat,10,Math.min(pingInterval,100),TimeUnit.MILLISECONDS);
    }
    public boolean handle(ChannelHandlerContext ctx,FullHttpRequest request,QueryStringDecoder query) {
        if(!query.path().equals("/socket.io/") && !query.path().equals("/socket.io"))return false;
        String origin=request.headers().get(HttpHeaderNames.ORIGIN);
        if(!origins.socketAllowed(origin)) { error(ctx,request,403,4,"Forbidden");return true; }
        String eio=GatewayRoutes.first(query.parameters(),"EIO"),transport=GatewayRoutes.first(query.parameters(),"transport"),sid=GatewayRoutes.first(query.parameters(),"sid");
        if(!"4".equals(eio)) { error(ctx,request,400,5,"Unsupported protocol version");return true; }
        if(!Set.of("polling","websocket").contains(transport==null?"":transport)) { error(ctx,request,400,0,"Transport unknown");return true; }
        if(request.method().equals(HttpMethod.OPTIONS)) { Gateway.reply(ctx,request,204,"text/plain; charset=UTF-8","",origin,true);return true; }
        Session session=sid==null?null:sessions.get(sid);
        if(sid!=null && session==null) { error(ctx,request,400,1,"Session ID unknown");return true; }
        if(transport.equals("websocket")) {
            if(!request.method().equals(HttpMethod.GET) || !"websocket".equalsIgnoreCase(request.headers().get(HttpHeaderNames.UPGRADE))) { error(ctx,request,400,3,"Bad request");return true; }
            boolean fresh=session==null;
            if(fresh)session=create();
            Session established=session;
            synchronized(session) {
                if(session.webSocket!=null || session.upgradeSocket!=null) { if(fresh)session.close();error(ctx,request,400,3,"Bad request");return true; }
                if(fresh)session.webSocket=ctx.channel();else {session.upgradeSocket=ctx.channel();session.upgradeDeadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(upgradeTimeout);}
            }
            String location="ws://"+request.headers().get(HttpHeaderNames.HOST)+query.path();
            WebSocketServerHandshaker handshaker=new WebSocketServerHandshakerFactory(location,null,true,MAX_PAYLOAD).newHandshaker(request);
            if(handshaker==null) { session.socketClosed(ctx.channel());WebSocketServerHandshakerFactory.sendUnsupportedVersionResponse(ctx.channel());return true; }
            ctx.pipeline().addLast(new WebSocketFrameAggregator(MAX_PAYLOAD));
            ctx.pipeline().addLast(new SimpleChannelInboundHandler<WebSocketFrame>() {
                @Override protected void channelRead0(ChannelHandlerContext channel,WebSocketFrame frame) {
                    if(frame instanceof CloseWebSocketFrame) { established.socketClosed(channel.channel());handshaker.close(channel.channel(),((CloseWebSocketFrame)frame).retain()); }
                    else if(frame instanceof PingWebSocketFrame)channel.writeAndFlush(new PongWebSocketFrame(frame.content().retain()));
                    else if(frame instanceof TextWebSocketFrame text)established.receive(text.text(),channel.channel());
                    else if(frame instanceof BinaryWebSocketFrame)established.binary(channel.channel());
                }
                @Override public void channelInactive(ChannelHandlerContext channel) { established.socketClosed(channel.channel()); }
                @Override public void exceptionCaught(ChannelHandlerContext channel,Throwable error) { established.socketClosed(channel.channel());channel.close(); }
            });
            handshaker.handshake(ctx.channel(),request).addListener(future->{if(!future.isSuccess())established.socketClosed(ctx.channel());else if(fresh)established.send(open(established,false));});
            return true;
        }
        if(request.method().equals(HttpMethod.GET)) {
            if(session==null) { session=create();Gateway.reply(ctx,request,200,"text/plain; charset=UTF-8",open(session,true),origin,true); }
            else session.poll(ctx,request,origin);
        } else if(request.method().equals(HttpMethod.POST)) {
            if(session==null) { error(ctx,request,400,1,"Session ID unknown");return true; }
            session.post(ctx,request,origin);
        } else error(ctx,request,400,3,"Bad request");
        return true;
    }
    private Session create() { Session session=new Session();sessions.put(session.id,session);return session; }
    private String open(Session session,boolean polling) { return "0"+Json.stringify(Json.object("sid",session.id,"upgrades",polling?Json.array("websocket"):Json.array(),"pingInterval",pingInterval,"pingTimeout",pingTimeout,"maxPayload",MAX_PAYLOAD)); }
    private void error(ChannelHandlerContext ctx,FullHttpRequest request,int status,int code,String message) { Gateway.reply(ctx,request,status,"application/json",Json.stringify(Json.object("code",code,"message",message)),request.headers().get(HttpHeaderNames.ORIGIN),origins.socketAllowed(request.headers().get(HttpHeaderNames.ORIGIN))); }
    public void broadcast(String executionId,JsonNode data) {
        String packet="42"+Json.stringify(Json.array("execution-update",Json.object("executionId",executionId,"data",data,"timestamp",Protocol.jsInstant(Instant.now()))));
        for(Session session:sessions.values())synchronized(session) { if(session.connected)session.send(packet); }
    }
    void heartbeat() { long now=System.nanoTime();for(Session session:sessions.values())synchronized(session) {
        if(session.closed)continue;
        if(!session.everConnected&&now>=session.connectDeadline) {session.close();continue;}
        if(session.upgradeSocket!=null&&now>=session.upgradeDeadline) {session.upgradeSocket.close();session.upgradeSocket=null;session.probed=false;}
        if(session.awaitingPong && now>=session.pongDeadline)session.close();else if(!session.awaitingPong && now>=session.nextPing) {session.awaitingPong=true;session.pongDeadline=now+TimeUnit.MILLISECONDS.toNanos(pingTimeout);session.send("2");}
    } }
    @Override public void close() { clock.shutdownNow();sessions.values().forEach(Session::close); }
    private final class Session {
        final String id=UUID.randomUUID().toString().replace("-","");
        final String socketId=UUID.randomUUID().toString().replace("-","");
        final Queue<String> packets=new ArrayDeque<>();
        Channel webSocket,upgradeSocket;
        ChannelHandlerContext pending;
        FullHttpRequest pendingRequest;
        String pendingOrigin;
        boolean connected,everConnected,closed,posting,probed,awaitingPong;
        int pendingAttachments;
        long nextPing=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(pingInterval),pongDeadline,upgradeDeadline;
        final long connectDeadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(connectTimeout);
        synchronized void poll(ChannelHandlerContext ctx,FullHttpRequest request,String origin) {
            if(closed || webSocket!=null) { error(ctx,request,400,3,"Bad request");return; }
            if(pending!=null) {close();error(ctx,request,400,3,"Bad request");return;}
            pending=ctx;pendingRequest=request.retainedDuplicate();pendingOrigin=origin;
            ctx.channel().closeFuture().addListener(ignored->{synchronized(this){if(pending==ctx)clearPoll();}});
            flush();
        }
        synchronized void post(ChannelHandlerContext ctx,FullHttpRequest request,String origin) {
            if(closed || webSocket!=null || posting) { close();error(ctx,request,400,3,"Bad request");return; }
            posting=true;
            try {
                String body=request.content().toString(java.nio.charset.StandardCharsets.UTF_8);
                for(String packet:body.split("\u001e",-1)) { if(packet.startsWith("b")) { try{Base64.getDecoder().decode(packet.substring(1));binary(null);}catch(IllegalArgumentException e){close();} }else receive(packet,null); }
                Gateway.reply(ctx,request,200,"text/plain; charset=UTF-8","ok",origin,true);
            } finally {posting=false;}
        }
        synchronized void receive(String packet,Channel source) {
            if(closed)return;
            if(source!=null && source==upgradeSocket) {
                if(packet.equals("2probe") && !probed) { probed=true;source.writeAndFlush(new TextWebSocketFrame("3probe"));send("6"); }
                else if(packet.equals("5") && probed) {if(pending!=null){Gateway.reply(pending,pendingRequest,200,"text/plain; charset=UTF-8","6",pendingOrigin,true);clearPoll();}webSocket=upgradeSocket;upgradeSocket=null;probed=false;flush();}
                else {source.close();upgradeSocket=null;probed=false;}
                return;
            }
            if(packet.isEmpty()) {close();return;}
            switch(packet.charAt(0)) {
                case '1' -> close();
                case '3' -> {if(!packet.equals("3")){close();return;}awaitingPong=false;nextPing=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(pingInterval);}
                case '4' -> socket(packet.substring(1));
                default -> close();
            }
        }
        private void socket(String packet) {
            if(packet.isEmpty()){close();return;}
            char type=packet.charAt(0);
            String payload=packet.substring(1),namespace="/";
            if(type=='5'||type=='6') {int dash=payload.indexOf('-');if(dash<1){close();return;}try{pendingAttachments=Integer.parseInt(payload.substring(0,dash));if(pendingAttachments<0)throw new NumberFormatException();}catch(NumberFormatException e){close();return;}payload=payload.substring(dash+1);}
            if(payload.startsWith("/")) {int comma=payload.indexOf(',');namespace=comma<0?payload:payload.substring(0,comma);payload=comma<0?"":payload.substring(comma+1);}
            if(!namespace.equals("/")) {if(type=='0')send("44"+namespace+","+Json.stringify(Json.object("message","Invalid namespace")));return;}
            try {
                if(type=='0') {if(connected){close();return;}if(!payload.isEmpty()&&!Json.parse(payload).isObject()){close();return;}connected=true;everConnected=true;send("40"+Json.stringify(Json.object("sid",socketId)));return;}
                if(!connected){close();return;}
                if(type=='1') {if(!payload.isEmpty()){close();return;}connected=false;return;}
                if(type=='2'||type=='3'||type=='5'||type=='6') {
                    int i=0;while(i<payload.length()&&payload.charAt(i)>='0'&&payload.charAt(i)<='9')i++;
                    JsonNode data=Json.parse(payload.substring(i));
                    if(!data.isArray() || ((type=='2'||type=='5')&&(data.isEmpty()||(!data.get(0).isTextual()&&!data.get(0).isNumber())||Set.of("connect","connect_error","disconnect","disconnecting","newListener","removeListener").contains(data.get(0).asText()))))close();
                    // The prior service registers no inbound application event handlers.
                } else close();
            } catch(RuntimeException e) {close();}
        }
        synchronized void binary(Channel source) {if(source!=null&&source==upgradeSocket){source.close();upgradeSocket=null;probed=false;return;}if(pendingAttachments<=0){close();return;}pendingAttachments--;}
        synchronized void send(String packet) {
            if(closed)return;
            packets.add(packet);flush();
        }
        private void flush() {
            if(webSocket!=null) {while(!packets.isEmpty())webSocket.write(new TextWebSocketFrame(packets.remove()));webSocket.flush();return;}
            if(pending==null || packets.isEmpty())return;
            StringJoiner payload=new StringJoiner("\u001e");int bytes=0;
            while(!packets.isEmpty()) {String next=packets.peek();int length=next.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;if(bytes>0 && bytes+length+1>MAX_PAYLOAD)break;packets.remove();payload.add(next);bytes+=length+1;}
            Gateway.reply(pending,pendingRequest,200,"text/plain; charset=UTF-8",payload.toString(),pendingOrigin,true);clearPoll();
        }
        private void clearPoll() {if(pendingRequest!=null)pendingRequest.release();pending=null;pendingRequest=null;pendingOrigin=null;}
        synchronized void socketClosed(Channel socket) {if(socket==upgradeSocket){upgradeSocket=null;probed=false;}else if(socket==webSocket)close();}
        synchronized void close() {
            if(closed)return;closed=true;connected=false;sessions.remove(id);
            if(pending!=null){Gateway.reply(pending,pendingRequest,200,"text/plain; charset=UTF-8","1",pendingOrigin,true);clearPoll();}
            if(webSocket!=null)webSocket.writeAndFlush(new CloseWebSocketFrame()).addListener(ChannelFutureListener.CLOSE);
            if(upgradeSocket!=null)upgradeSocket.close();packets.clear();
        }
    }
}
