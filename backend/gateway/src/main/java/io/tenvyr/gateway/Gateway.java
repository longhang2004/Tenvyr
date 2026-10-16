package io.tenvyr.gateway;

import io.netty.bootstrap.ServerBootstrap;
import io.netty.buffer.Unpooled;
import io.netty.channel.*;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.http.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.*;

public final class Gateway implements AutoCloseable {
    private final EventLoopGroup accept=new NioEventLoopGroup(1),io=new NioEventLoopGroup();
    private final ExecutorService requests=new ThreadPoolExecutor(4,16,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(256));
    private final SocketIo sockets;
    private final GatewayRoutes routes;
    private final LocalOrigin origins;
    private Channel server;
    public Gateway(String orchestrator,String cors) { this(orchestrator,cors,25_000,20_000); }
    public Gateway(String orchestrator,String cors,long interval,long timeout) { origins=new LocalOrigin(cors);sockets=new SocketIo(origins,interval,timeout);routes=new GatewayRoutes(orchestrator,sockets::broadcast); }
    public int start(String host,int port)throws InterruptedException {
        server=new ServerBootstrap().group(accept,io).channel(NioServerSocketChannel.class).childHandler(new ChannelInitializer<SocketChannel>() {
            @Override protected void initChannel(SocketChannel channel) {channel.pipeline().addLast(new HttpServerCodec(),new HttpObjectAggregator(SocketIo.MAX_PAYLOAD),new SimpleChannelInboundHandler<FullHttpRequest>() {
                @Override protected void channelRead0(ChannelHandlerContext ctx,FullHttpRequest request) {
                    try {
                        QueryStringDecoder query=new QueryStringDecoder(request.uri());
                        if(sockets.handle(ctx,request,query))return;
                        String origin=request.headers().get(HttpHeaderNames.ORIGIN);
                        if(request.method().equals(HttpMethod.OPTIONS) && origins.enabled()) {reply(ctx,request,204,"text/plain","",origin,origins.httpAllowed(origin));return;}
                        if(request.content().readableBytes()>102_400) {reply(ctx,request,413,"application/json","{\"statusCode\":413,\"message\":\"request entity too large\"}",origin,origins.httpAllowed(origin));return;}
                        FullHttpRequest held=request.retainedDuplicate();
                        try {requests.execute(()->{
                            try {GatewayRoutes.Response response=routes.handle(held.method().equals(HttpMethod.HEAD)?"GET":held.method().name(),query.rawPath(),query.parameters(),held.content().toString(StandardCharsets.UTF_8));reply(ctx,held,response.status(),response.contentType(),response.body(),origin,origins.httpAllowed(origin));}
                            catch(RuntimeException e){reply(ctx,held,500,"application/json","{\"statusCode\":500,\"message\":\"Internal server error\"}",origin,origins.httpAllowed(origin));}
                            finally {held.release();}
                        });} catch(RejectedExecutionException e) {held.release();reply(ctx,request,503,"application/json","{\"statusCode\":503,\"message\":\"Service Unavailable\"}",origin,origins.httpAllowed(origin));}
                    } catch(RuntimeException e) {reply(ctx,request,400,"application/json","{\"statusCode\":400,\"message\":\"Bad Request\"}",null,false);}
                }
                @Override public void exceptionCaught(ChannelHandlerContext ctx,Throwable error) {ctx.close();}
            });}
        }).bind(host,port).sync().channel();
        return ((InetSocketAddress)server.localAddress()).getPort();
    }
    static void reply(ChannelHandlerContext ctx,FullHttpRequest request,int status,String contentType,String body,String origin,boolean cors) {
        byte[] bytes=body.getBytes(StandardCharsets.UTF_8);
        FullHttpResponse response=new DefaultFullHttpResponse(HttpVersion.HTTP_1_1,HttpResponseStatus.valueOf(status),request.method().equals(HttpMethod.HEAD)?Unpooled.EMPTY_BUFFER:Unpooled.wrappedBuffer(bytes));
        response.headers().set(HttpHeaderNames.CONTENT_TYPE,contentType).setInt(HttpHeaderNames.CONTENT_LENGTH,bytes.length);
        if(cors && origin!=null)response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN,origin).set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_CREDENTIALS,"true").set(HttpHeaderNames.VARY,"Origin");
        if(request.method().equals(HttpMethod.OPTIONS)&&cors) {response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_METHODS,"GET,HEAD,PUT,PATCH,POST,DELETE");String headers=request.headers().get(HttpHeaderNames.ACCESS_CONTROL_REQUEST_HEADERS);if(headers!=null)response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_HEADERS,headers);}
        boolean keepAlive=HttpUtil.isKeepAlive(request);
        if(keepAlive)response.headers().set(HttpHeaderNames.CONNECTION,HttpHeaderValues.KEEP_ALIVE);
        ChannelFuture sent=ctx.writeAndFlush(response);if(!keepAlive)sent.addListener(ChannelFutureListener.CLOSE);
    }
    @Override public void close() {if(server!=null)server.close().awaitUninterruptibly();sockets.close();requests.shutdownNow();accept.shutdownGracefully(0,1,TimeUnit.SECONDS).awaitUninterruptibly();io.shutdownGracefully(0,1,TimeUnit.SECONDS).awaitUninterruptibly();}
    public static void main(String[] args)throws Exception {
        Map<String,String> env=System.getenv();
        Gateway gateway=new Gateway(env.getOrDefault("ORCHESTRATOR_URL","http://127.0.0.1:3001"),env.get("CORS_ORIGIN"));
        int port=Integer.parseInt(env.getOrDefault("GATEWAY_PORT","3000"));if(port==0)port=3000;
        gateway.start(env.getOrDefault("GATEWAY_HOST","127.0.0.1"),port);
        Runtime.getRuntime().addShutdownHook(new Thread(gateway::close));
        System.out.println("Gateway listening on http://localhost:"+port);
    }
}
