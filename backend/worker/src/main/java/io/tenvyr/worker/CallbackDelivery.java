package io.tenvyr.worker;

import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Exact v1 HMAC headers, one delivery identity and immutable bytes across every retry. */
public final class CallbackDelivery {
    public static final String KEY_ID="X-AgentWeave-Key-Id",TIMESTAMP="X-AgentWeave-Timestamp",DELIVERY_ID="X-AgentWeave-Delivery-Id",SIGNATURE="X-AgentWeave-Signature";
    public record Outcome(boolean delivered,String deliveryId,int attempts,Integer httpStatus,String reason) {}
    private static final HttpClient CLIENT=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    private static final ScheduledExecutorService TIMER=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"tenvyr-callback-deadline");t.setDaemon(true);return t;});
    private CallbackDelivery() {}
    public static String signature(String secret,String timestamp,String deliveryId,byte[] body) {try {Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));mac.update((timestamp+"."+deliveryId+".").getBytes(StandardCharsets.UTF_8));return "v1="+HexFormat.of().formatHex(mac.doFinal(body));}catch(Exception e){throw new IllegalStateException(e);} }
    public static Long retryAfter(String value,long maxDelayMs) { if(value==null||!value.matches("[0-9]+"))return null;String digits=value.replaceFirst("^0+(?=\\d)","");String max=Long.toString(maxDelayMs/1000);if(digits.length()>max.length()||digits.length()==max.length()&&digits.compareTo(max)>0)return maxDelayMs;return Long.parseLong(digits)*1000; }
    public static Outcome deliver(URI target,String keyId,String secret,byte[] bytes,WorkerConfig config,Cancellation cancellation) {
        String id=UUID.randomUUID().toString();Integer lastStatus=null;String reason="delivery-failed";
        for(int attempt=1;attempt<=config.callbackMaxAttempts;attempt++) {
            if(cancellation.isCancelled())return new Outcome(false,id,attempt-1,null,"worker-shutdown");
            String timestamp=Long.toString(System.currentTimeMillis()/1000);
            HttpRequest request=HttpRequest.newBuilder(target).timeout(Duration.ofMillis(config.callbackRequestTimeoutMs)).header("Content-Type","application/json").header("Accept","application/json").header(KEY_ID,keyId).header(TIMESTAMP,timestamp).header(DELIVERY_ID,id).header(SIGNATURE,signature(secret,timestamp,id,bytes)).header("User-Agent","Tenvyr-Worker/0.1.0").POST(HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
            CompletableFuture<HttpResponse<InputStream>> pending=CLIENT.sendAsync(request,HttpResponse.BodyHandlers.ofInputStream());
            java.util.concurrent.atomic.AtomicReference<InputStream> responseBody=new java.util.concurrent.atomic.AtomicReference<>();
            java.util.concurrent.atomic.AtomicBoolean timedOut=new java.util.concurrent.atomic.AtomicBoolean();
            ScheduledFuture<?> timeout=TIMER.schedule(()->{timedOut.set(true);pending.cancel(true);close(responseBody.get());},config.callbackRequestTimeoutMs,TimeUnit.MILLISECONDS);
            Long delay=null;
            try(AutoCloseable registration=cancellation.onCancel(()->{pending.cancel(true);close(responseBody.get());})) {
                HttpResponse<InputStream> response=pending.get();lastStatus=response.statusCode();responseBody.set(response.body());if(cancellation.isCancelled())close(response.body());
                try(InputStream input=response.body()) {long declared=response.headers().firstValueAsLong("content-length").orElse(-1);if(declared>config.maxResponseBytes)return new Outcome(false,id,attempt,lastStatus,"response-too-large");int total=0,n;byte[] chunk=new byte[4096];while((n=input.read(chunk))!=-1){total+=n;if(total>config.maxResponseBytes)return new Outcome(false,id,attempt,lastStatus,"response-too-large");} }
                if(timedOut.get())throw new IOException("timeout");
                if(lastStatus>=200&&lastStatus<=299)return new Outcome(true,id,attempt,lastStatus,"delivered");
                boolean retry=lastStatus==408||lastStatus==429||lastStatus>=500&&lastStatus<=599;reason=retry?"retryable-http-status":"non-retryable-http-status";
                if(!retry||attempt==config.callbackMaxAttempts)return new Outcome(false,id,attempt,lastStatus,reason);
                delay=retryAfter(response.headers().firstValue("retry-after").orElse(null),config.callbackMaxDelayMs);
            } catch(Exception e) {if(cancellation.isCancelled())return new Outcome(false,id,attempt,null,"worker-shutdown");reason=timedOut.get()?"request-timeout":"network-error";if(attempt==config.callbackMaxAttempts)return new Outcome(false,id,attempt,null,reason);} finally {timeout.cancel(false);close(responseBody.get());}
            if(delay==null){double base=Math.min(config.callbackMaxDelayMs,config.callbackInitialDelayMs*Math.pow(2,attempt-1));delay=Math.max(0,Math.min(config.callbackMaxDelayMs,Math.round(base*(1+(ThreadLocalRandom.current().nextDouble()*2-1)*config.callbackJitterRatio))));}
            try {if(!cancellation.await(delay))return new Outcome(false,id,attempt,null,"worker-shutdown");}catch(InterruptedException e){Thread.currentThread().interrupt();return new Outcome(false,id,attempt,null,cancellation.isCancelled()?"worker-shutdown":"backoff-failed");}
        }
        return new Outcome(false,id,config.callbackMaxAttempts,lastStatus,reason);
    }
    private static void close(InputStream input){if(input!=null)try{input.close();}catch(IOException ignored){}}
}
