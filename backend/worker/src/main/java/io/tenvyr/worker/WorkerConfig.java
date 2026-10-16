package io.tenvyr.worker;

import java.net.URI;
import java.util.*;
import java.util.function.Consumer;

/** Configuration is frozen by Worker construction; no transport choice comes from agent input. */
public final class WorkerConfig {
    public String agentName,bearerToken;
    public Map<String,String> callbackKeys=Map.of();
    public List<String> allowedOrigins=List.of();
    public boolean allowInsecureHttp,eventsEnabled;
    public long timeoutMs=900_000,idempotencyTtlMs=86_400_000,heartbeatIntervalMs=60_000,shutdownGraceMs=30_000;
    public int concurrency=4,maxQueuedRuns=100,idempotencyMaxEntries=10_000,maxRequestBytes=1_048_576,maxResponseBytes=65_536;
    public int callbackMaxAttempts=8;
    public long callbackInitialDelayMs=500,callbackMaxDelayMs=30_000,callbackRequestTimeoutMs=10_000;
    public double callbackJitterRatio=.2;
    public Consumer<CallbackDelivery.Outcome> onCallbackDeliveryFailed;
    WorkerConfig freeze() {
        require(agentName,"Agent name"); require(bearerToken,"Bearer token");
        if(callbackKeys.isEmpty())throw invalid("At least one callback key is required");
        callbackKeys.forEach((key,value)->{require(key,"Callback key ID");require(value,"Callback secret");});
        if(allowedOrigins.isEmpty())throw invalid("At least one callback origin is required");
        List<String> origins=new ArrayList<>();for(String origin:allowedOrigins) { URI uri=uri(origin,allowInsecureHttp);String canonical=origin(uri); if(uri.getRawQuery()!=null||uri.getRawFragment()!=null||!(uri.getRawPath()==null||uri.getRawPath().isEmpty()||uri.getRawPath().equals("/"))||!canonical.equals(origin.replaceFirst("/$","")))throw invalid("Callback origin must contain only an origin"); origins.add(canonical); }
        if(timeoutMs<=0||idempotencyTtlMs<=0||shutdownGraceMs<=0||concurrency<=0||maxQueuedRuns<0||idempotencyMaxEntries<=0||maxRequestBytes<=0||maxResponseBytes<=0||callbackMaxAttempts<=0||callbackInitialDelayMs<=0||callbackMaxDelayMs<callbackInitialDelayMs||callbackRequestTimeoutMs<=0||heartbeatIntervalMs<1000||heartbeatIntervalMs>3_600_000||!Double.isFinite(callbackJitterRatio)||callbackJitterRatio<0||callbackJitterRatio>1)throw invalid("Invalid Worker bounds");
        WorkerConfig out=new WorkerConfig();out.agentName=agentName;out.bearerToken=bearerToken;out.callbackKeys=Map.copyOf(callbackKeys);out.allowedOrigins=List.copyOf(origins);out.allowInsecureHttp=allowInsecureHttp;out.eventsEnabled=eventsEnabled;out.timeoutMs=timeoutMs;out.idempotencyTtlMs=idempotencyTtlMs;out.heartbeatIntervalMs=heartbeatIntervalMs;out.shutdownGraceMs=shutdownGraceMs;out.concurrency=concurrency;out.maxQueuedRuns=maxQueuedRuns;out.idempotencyMaxEntries=idempotencyMaxEntries;out.maxRequestBytes=maxRequestBytes;out.maxResponseBytes=maxResponseBytes;out.callbackMaxAttempts=callbackMaxAttempts;out.callbackInitialDelayMs=callbackInitialDelayMs;out.callbackMaxDelayMs=callbackMaxDelayMs;out.callbackRequestTimeoutMs=callbackRequestTimeoutMs;out.callbackJitterRatio=callbackJitterRatio;out.onCallbackDeliveryFailed=onCallbackDeliveryFailed;return out;
    }
    public URI callback(String value) { URI uri=uri(value,allowInsecureHttp);if(uri.getRawQuery()!=null||uri.getRawFragment()!=null||!allowedOrigins.contains(origin(uri)))throw invalid("Callback URL is not allowed");return uri; }
    static URI uri(String value,boolean allowHttp) { try {URI uri=new URI(value);String scheme=uri.getScheme();if(uri.getHost()==null||uri.getRawUserInfo()!=null||!("https".equalsIgnoreCase(scheme)||allowHttp&&"http".equalsIgnoreCase(scheme)))throw invalid("Invalid callback URL");return uri;}catch(java.net.URISyntaxException e){throw invalid("Invalid callback URL");} }
    static String origin(URI uri) { String scheme=uri.getScheme().toLowerCase(Locale.ROOT),host=uri.getHost().toLowerCase(Locale.ROOT);if(host.contains(":")&&!host.startsWith("["))host="["+host+"]";int port=uri.getPort();return scheme+"://"+host+(port<0||port==80&&scheme.equals("http")||port==443&&scheme.equals("https")?"":":"+port); }
    private static void require(String value,String name){if(value==null||value.isBlank())throw invalid(name+" must be non-empty");}
    private static IllegalArgumentException invalid(String message){return new IllegalArgumentException("Invalid Tenvyr Worker configuration: "+message);}
}
