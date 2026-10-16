package io.tenvyr.agents;

import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.errors.WakeupException;
import org.apache.kafka.common.serialization.StringSerializer;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Real processor and Kafka offset/lifecycle checks using Kafka's installed mock clients. */
public final class AgentCheck {
    private static int checks;
    public static void main(String[] args)throws Exception {
        Path skills=Files.createTempDirectory("agent-check");
        try {processor(skills);poison(skills);delivery(skills);redelivery(skills);shutdown(skills);}
        finally {try(var files=Files.walk(skills)){for(Path file:files.sorted(Comparator.reverseOrder()).toList())Files.delete(file);}}
        System.out.println("AgentCheck: "+checks+" checks passed (prompts, DTO, contracts, outcomes, poison ack, publication retry, graceful drain)");
    }
    static ObjectNode invocation(String agent,String executionId) {
        return Protocol.invocation(Json.object("schemaVersion","1","invocationId",executionId+":step:1","executionId",executionId,"stepExecutionId",executionId+":step","stepId",agent.equals("code-reviewer")?"review":"observe","target",Json.object("agent",agent),"input",agent.equals("code-reviewer")?Json.object("code","const safe = true;","language","typescript"):Json.object("logs","all good","findings",Json.array()),"attempt",1,"createdAt","2026-07-26T00:00:00.000Z","trace",Json.object("traceId",executionId,"correlationId",executionId+":step:1")));
    }
    private static ObjectNode response(String output) {return Json.object("success",true,"data",Json.object("output",output,"promptTokens",4,"completionTokens",6,"totalTokens",10,"metadata",Json.object("provider","mock","model","local-heuristic","fallbackUsed",true,"usageSource","estimated")));}
    private static void processor(Path skills)throws Exception {
        Files.writeString(skills.resolve("security-review-basic.md"),"EXACT SECURITY RULES");Files.writeString(skills.resolve("observability-guidelines.md"),"EXACT OPERATIONS RULES");
        for(String agent:List.of("code-reviewer","observability")) {
            AtomicReference<ObjectNode> context=new AtomicReference<>();AtomicLong timeout=new AtomicLong();AtomicReference<String> prompt=new AtomicReference<>();
            AgentProcessor processor=new AgentProcessor(agent,skills,(p,c,t)->{prompt.set(p);context.set(c);timeout.set(t);return response(agent.equals("code-reviewer")?"before {\"score\":73,\"findings\":[\"issue\"]} after":"```json\n{\"status\":\"DEGRADED\",\"analysis\":\"slow\",\"latencySec\":3}\n```");});
            ObjectNode input=invocation(agent,"execution-1"),result=processor.process(input);
            check(result.path("status").asText().equals("succeeded"),"runner outcome "+agent);
            check(result.path("invocationId").equals(input.get("invocationId"))&&result.path("stepExecutionId").equals(input.get("stepExecutionId")),"v1 correlation preserved");
            check(result.path("usage").equals(Json.object("inputTokens",4,"outputTokens",6,"totalTokens",10)),"runner usage DTO");
            check(result.path("output").path("_tenvyr").path("metadata").equals(result.get("metadata"))&&result.path("output").path("_tenvyr").path("usage").equals(result.get("usage")),"business output keeps _tenvyr evidence");
            check(result.path("startedAt").asText().matches(".*\\.\\d{3}Z")&&result.has("completedAt"),"millisecond timestamps");
            check(timeout.get()==60_000,"default runner timeout");
            if(agent.equals("code-reviewer")) {
                check(context.get().equals(Json.object("executionId","execution-1","stepId","review","attempt",1,"code","const safe = true;","language","typescript")),"reviewer exact runner context");
                check(prompt.get().contains("EXACT SECURITY RULES")&&prompt.get().contains("Language: {{language}}")&&prompt.get().contains("{{code}}"),"reviewer real skill prompt");
                check(result.path("output").path("score").asInt()==73,"reviewer parsed business output");
            } else {
                check(context.get().equals(Json.object("executionId","execution-1","stepId","observe","attempt",1,"logs","all good","findings","[]")),"observability exact runner context");
                check(prompt.get().contains("EXACT OPERATIONS RULES")&&prompt.get().contains("{{logs}}")&&prompt.get().contains("{{findings}}"),"observability real skill prompt");
                check(result.path("output").path("status").asText().equals("DEGRADED"),"observability parsed business output");
            }
            input.set("input",Json.object("code",17,"language",false,"logs",12,"findings",false));processor.process(input);
            check(agent.equals("code-reviewer")?context.get().path("code").asText().isEmpty()&&context.get().path("language").asText().equals("typescript"):context.get().path("logs").asText().equals("No system logs available.")&&context.get().path("findings").asText().equals("{}"),"original context defaults");
            input.put("deadlineAt",Protocol.jsInstant(Instant.now().plusSeconds(2)));processor.process(input);check(timeout.get()>0&&timeout.get()<=2_000,"deadline bounds runner call");
            input.put("deadlineAt","2026-07-26 00:00:00.000Z");processor.process(input);check(timeout.get()==1,"expired deadline receives original one millisecond floor");
            input.set("input",Json.array());check(processor.process(input).path("error").path("message").asText().contains("input must be an object"),"input business validation becomes failure");
            ObjectNode legacy=Json.object("executionId","execution-1","stepId",agent.equals("code-reviewer")?"review":"observe","agent",agent,"input",Json.object(),"attempt",2,"timeout","3s","maxAttempts",4,"timestamp","2026-07-26T00:00:00.000Z");
            ObjectNode normalized=processor.normalize(legacy,1);check(normalized.path("invocationId").asText().equals("legacy:execution-1:"+legacy.path("stepId").asText()+":2"),"deterministic legacy invocation id");
            check(normalized.path("deadlineAt").asText().equals("2026-07-26T00:00:03.000Z")&&normalized.path("metadata").path("legacy").path("maxAttempts").asInt()==4,"legacy timing and metadata");
            legacy.remove("timestamp");check(processor.normalize(legacy,1785024000000L).path("createdAt").asText().equals("2026-07-26T00:00:00.000Z"),"Kafka timestamp fallback");
            ObjectNode wrong=invocation(agent,"wrong");wrong.with("target").put("agent",agent.equals("code-reviewer")?"observability":"code-reviewer");rejects(()->processor.normalize(wrong,1),"wrong topic target");
            ObjectNode extension=invocation(agent,"extension").put("extra",true);rejects(()->processor.normalize(extension,1),"closed canonical contract");
            for(String raw:List.of("plain output","prefix {broken} suffix")) {
                AgentProcessor rawProcessor=new AgentProcessor(agent,skills,(p,c,t)->response(raw));ObjectNode rawResult=rawProcessor.process(invocation(agent,"raw"));
                check(rawResult.path("status").asText().equals("succeeded"),"raw runner output still succeeds");
                check(agent.equals("code-reviewer")?rawResult.path("output").path("score").asInt()==(raw.contains("{")?80:90):rawResult.path("output").path("status").asText().equals("DEGRADED")&&rawResult.path("output").path("latencySec").asInt()==2,"original raw output fallback");
            }
            AgentProcessor failing=new AgentProcessor(agent,skills,(p,c,t)->{throw new IOException("runner unavailable");});ObjectNode failure=failing.process(invocation(agent,"failed"));
            check(failure.path("status").asText().equals("failed")&&!failure.path("error").path("retryable").asBoolean()&&!failure.has("output"),"runner failure result");
            AgentProcessor timedOut=new AgentProcessor(agent,skills,(p,c,t)->{throw new java.net.http.HttpTimeoutException("deadline exceeded");});ObjectNode timed=timedOut.process(invocation(agent,"timed"));
            check(timed.path("status").asText().equals("timed_out")&&timed.path("error").path("code").asText().equals("AGENT_TIMED_OUT")&&timed.path("error").path("retryable").asBoolean(),"runner timeout result");
            AgentProcessor incomplete=new AgentProcessor(agent,skills,(p,c,t)->Json.object("data",Json.object("output","{}")));ObjectNode missing=incomplete.process(invocation(agent,"missing"));
            check(missing.path("usage").isEmpty()&&!missing.has("metadata"),"unreported usage stays absent rather than fabricated zeros");
            AgentProcessor malformed=new AgentProcessor(agent,skills,(p,c,t)->response("{}").with("data").put("promptTokens",-1));
            check(malformed.process(invocation(agent,"bad-usage")).path("status").asText().equals("failed"),"invalid runner DTO evidence cannot publish success");
        }
    }
    private static void poison(Path skills)throws Exception {
        AtomicInteger calls=new AtomicInteger(),published=new AtomicInteger();AgentProcessor processor=new AgentProcessor("code-reviewer",skills,(p,c,t)->{calls.incrementAndGet();return response("{}");});
        PrintStream original=System.err;ByteArrayOutputStream log=new ByteArrayOutputStream();
        try {System.setErr(new PrintStream(log,true,StandardCharsets.UTF_8));for(String raw:Arrays.asList(null,"","{TOP_SECRET:not-json","{\"executionId\":\"x\"}","[]",Json.stringify(invocation("code-reviewer","extra").put("extra",true))))KafkaAgent.deliver(processor,raw,1,"key",(k,r)->published.incrementAndGet());}
        finally {System.setErr(original);}
        check(calls.get()==0&&published.get()==0,"poison never invokes runner or publishes result");check(!log.toString(StandardCharsets.UTF_8).contains("TOP_SECRET"),"malformed message contents never enter diagnostic logs");
        AtomicReference<String> key=new AtomicReference<>();KafkaAgent.deliver(processor,Json.stringify(invocation("code-reviewer","actual-key")),1,"untrusted-message-key",(k,r)->key.set(k));check(key.get().equals("actual-key"),"result key comes from validated execution correlation");
        try {KafkaAgent.deliver(processor,Json.stringify(invocation("code-reviewer","publish-failure")),1,"key",(k,r)->{throw new IOException("broker unavailable");});throw new AssertionError("Publication failure swallowed");}catch(IOException expected){checks++;}
    }
    private static void delivery(Path skills)throws Exception {
        TrackingConsumer consumer=new TrackingConsumer();MockProducer<String,String> producer=new MockProducer<>(true,new StringSerializer(),new StringSerializer());AtomicInteger calls=new AtomicInteger();
        AgentProcessor processor=new AgentProcessor("code-reviewer",skills,(p,c,t)->{calls.incrementAndGet();return response("{}");});
        try(KafkaAgent agent=new KafkaAgent(processor,consumer,producer)) {
            check(consumer.subscription().equals(Set.of("agentweave.agent.code-reviewer.task")),"legacy task topic");
            consumer.prepare(List.of(record(0,"{poison"),record(1,Json.stringify(invocation("code-reviewer","delivery")))));agent.start();
            await(()->consumer.lastOffset.get()==2,"poison+success commits");check(calls.get()==1&&producer.history().size()==1,"poison ack does not block next valid task");
            check(consumer.commits.equals(List.of(1L,2L)),"each exact delivered offset committed");ProducerRecord<String,String> published=producer.history().get(0);
            check(published.topic().equals("agentweave.agent.code-reviewer.result")&&published.key().equals("delivery"),"legacy result topic and key");
            check(Protocol.result(Json.parse(published.value())).path("invocationId").asText().equals("delivery:step:1"),"published result is validated canonical v1");
            rejects(agent::start,"one-shot Kafka lifecycle");
        }
        check(consumer.closed()&&producer.closed(),"both Kafka clients close");
    }
    private static void redelivery(Path skills)throws Exception {
        TrackingConsumer consumer=new TrackingConsumer();AtomicInteger attempts=new AtomicInteger(),calls=new AtomicInteger();
        MockProducer<String,String> producer=new MockProducer<>(true,new StringSerializer(),new StringSerializer()) {
            @Override public synchronized Future<RecordMetadata> send(ProducerRecord<String,String> record){return attempts.incrementAndGet()==1?CompletableFuture.failedFuture(new IOException("broker unavailable")):super.send(record);}
        };
        AgentProcessor processor=new AgentProcessor("code-reviewer",skills,(p,c,t)->{calls.incrementAndGet();return response("{}");});ConsumerRecord<String,String> task=record(0,Json.stringify(invocation("code-reviewer","retry")));consumer.redelivery=task;
        try(KafkaAgent agent=new KafkaAgent(processor,consumer,producer)){consumer.prepare(List.of(task));agent.start();await(()->consumer.lastOffset.get()==1,"redelivery committed after publication");
            check(consumer.seeks.get()==1&&calls.get()==2&&attempts.get()==2,"publication failure retains and redelivers task");check(consumer.commits.equals(List.of(1L))&&producer.history().size()==1,"no commit or synthetic failure result before broker ack");}
    }
    private static void shutdown(Path skills)throws Exception {
        TrackingConsumer consumer=new TrackingConsumer();consumer.wakeupCommit=true;MockProducer<String,String> producer=new MockProducer<>(true,new StringSerializer(),new StringSerializer());CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1),closed=new CountDownLatch(1);
        AgentProcessor processor=new AgentProcessor("code-reviewer",skills,(p,c,t)->{entered.countDown();if(!release.await(3,TimeUnit.SECONDS))throw new AssertionError("Runner release timed out");return response("{}");});
        KafkaAgent agent=new KafkaAgent(processor,consumer,producer);consumer.prepare(List.of(record(0,Json.stringify(invocation("code-reviewer","drain")))));agent.start();check(entered.await(3,TimeUnit.SECONDS),"runner active before shutdown");
        Thread closer=new Thread(()->{agent.close();closed.countDown();});closer.start();Thread.sleep(20);check(!producer.closed()&&closed.getCount()==1,"shutdown keeps producer alive while active run drains");
        release.countDown();check(closed.await(3,TimeUnit.SECONDS),"shutdown settles after active publication");
        check(producer.history().size()==1&&consumer.lastOffset.get()==1&&consumer.commits.equals(List.of(1L)),"shutdown wakeup cannot lose active task's post-publication commit");
        check(consumer.closed()&&producer.closed(),"shutdown closes resources after drain");agent.close();rejects(agent::start,"closed agent cannot restart");
    }
    private static ConsumerRecord<String,String> record(long offset,String value){return new ConsumerRecord<>("agentweave.agent.code-reviewer.task",0,offset,"legacy-key",value);}
    private static final class TrackingConsumer extends MockConsumer<String,String> {
        final AtomicLong lastOffset=new AtomicLong(-1);final AtomicInteger seeks=new AtomicInteger();final List<Long> commits=new CopyOnWriteArrayList<>();boolean wakeupCommit;final AtomicBoolean wakeup=new AtomicBoolean();ConsumerRecord<String,String> redelivery;
        TrackingConsumer(){super(OffsetResetStrategy.LATEST);}
        void prepare(List<ConsumerRecord<String,String>> records){schedulePollTask(()->{TopicPartition partition=new TopicPartition("agentweave.agent.code-reviewer.task",0);rebalance(List.of(partition));updateBeginningOffsets(Map.of(partition,0L));updateEndOffsets(Map.of(partition,0L));seek(partition,0);for(ConsumerRecord<String,String> record:records)addRecord(record);seeks.set(0);});}
        @Override public synchronized void commitSync(Map<TopicPartition,OffsetAndMetadata> offsets){if(wakeupCommit&&wakeup.compareAndSet(true,false))throw new WakeupException();super.commitSync(offsets);long offset=offsets.values().iterator().next().offset();commits.add(offset);lastOffset.set(offset);}
        @Override public synchronized void seek(TopicPartition partition,long offset){super.seek(partition,offset);seeks.incrementAndGet();if(redelivery!=null&&offset==redelivery.offset()){ConsumerRecord<String,String> record=redelivery;redelivery=null;schedulePollTask(()->addRecord(record));}}
        @Override public synchronized void wakeup(){wakeup.set(true);super.wakeup();}
    }
    private static void await(java.util.function.BooleanSupplier ready,String label)throws Exception {long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(!ready.getAsBoolean()&&System.nanoTime()<deadline)Thread.sleep(5);check(ready.getAsBoolean(),label);}
    private static void rejects(Runnable run,String label){try{run.run();throw new AssertionError("Accepted "+label);}catch(IllegalArgumentException|IllegalStateException expected){checks++;}}
    private static void check(boolean value,String label){checks++;if(!value)throw new AssertionError(label);}
}
