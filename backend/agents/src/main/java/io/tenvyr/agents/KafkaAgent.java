package io.tenvyr.agents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.errors.WakeupException;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/** Kafka delivery owns offsets: malformed tasks are permanent; publication failures redeliver. */
public final class KafkaAgent implements AutoCloseable {
    @FunctionalInterface public interface Publisher {void publish(String key,ObjectNode result)throws Exception;}
    private final AgentProcessor processor;
    private final Consumer<String,String> consumer;
    private final Producer<String,String> producer;
    private final String resultTopic;
    private volatile boolean running;
    private boolean started,closed;
    private Thread thread;
    private final CompletableFuture<Void> ready=new CompletableFuture<>();
    public KafkaAgent(AgentProcessor processor,String brokers) {
        this.processor=processor;String agent=processor.agent();
        Properties properties=new Properties();properties.put("bootstrap.servers",brokers);properties.put("client.id","agent-"+agent);
        properties.put("key.serializer",StringSerializer.class.getName());properties.put("value.serializer",StringSerializer.class.getName());
        producer=new KafkaProducer<>(properties);resultTopic="agentweave.agent."+agent+".result";
        Properties read=new Properties();read.put("bootstrap.servers",brokers);read.put("client.id","agent-"+agent);read.put("group.id",agent.equals("code-reviewer")?"agentweave-reviewer-group":"agentweave-observability-group");
        read.put("key.deserializer",StringDeserializer.class.getName());read.put("value.deserializer",StringDeserializer.class.getName());read.put("enable.auto.commit","false");read.put("auto.offset.reset","latest");read.put("max.poll.records","1");read.put("max.poll.interval.ms",Integer.toString(Integer.MAX_VALUE));
        consumer=new KafkaConsumer<>(read);consumer.subscribe(List.of("agentweave.agent."+agent+".task"));
    }
    KafkaAgent(AgentProcessor processor,Consumer<String,String> consumer,Producer<String,String> producer) {
        this.processor=processor;this.consumer=consumer;this.producer=producer;resultTopic="agentweave.agent."+processor.agent()+".result";
        consumer.subscribe(List.of("agentweave.agent."+processor.agent()+".task"));
    }
    public synchronized void start() {
        if(started||closed)throw new IllegalStateException("Agent lifecycle already started or closed");
        producer.partitionsFor(resultTopic);running=true;started=true;thread=new Thread(this::consume,"kafka-"+processor.agent());thread.start();
        try{ready.get(30,TimeUnit.SECONDS);}catch(Exception failure){close();if(failure instanceof InterruptedException)Thread.currentThread().interrupt();throw new IllegalStateException("Kafka agent did not obtain a task assignment",failure);}
    }
    private void consume() {
        try {
            while(running) {
                ConsumerRecords<String,String> records=consumer.poll(Duration.ofSeconds(1));
                if(!consumer.assignment().isEmpty())ready.complete(null);
                for(ConsumerRecord<String,String> record:records) {
                    if(!running)break;
                    TopicPartition partition=new TopicPartition(record.topic(),record.partition());
                    try {
                        deliver(processor,record.value(),record.timestamp(),record.key(),(key,result)->producer.send(new ProducerRecord<>(resultTopic,key,Json.stringify(result))).get());
                        Map<TopicPartition,OffsetAndMetadata> offsets=Map.of(partition,new OffsetAndMetadata(record.offset()+1));
                        try {consumer.commitSync(offsets);}
                        catch(WakeupException e) {if(running)throw e;consumer.commitSync(offsets);}
                    }catch(Exception e) {consumer.seek(partition,record.offset());System.err.println("Agent task delivery failed; retaining offset for redelivery: "+AgentProcessor.message(e));break;}
                }
            }
        }catch(WakeupException e) {if(running){ready.completeExceptionally(e);throw e;}}catch(RuntimeException failure){ready.completeExceptionally(failure);throw failure;}finally {ready.completeExceptionally(new IllegalStateException("Kafka consumer stopped before assignment"));consumer.close();}
    }
    public static void deliver(AgentProcessor processor,String bytes,long timestamp,String messageKey,Publisher publisher)throws Exception {
        if(bytes==null||bytes.isEmpty())return;
        JsonNode value=null;ObjectNode invocation;
        try {value=Json.parse(bytes);invocation=processor.normalize(value,timestamp);}
        catch(RuntimeException error) {
            if(error instanceof Protocol.ValidationError validation)System.err.println("Rejected invalid "+processor.agent()+" invocation: "+Json.stringify(Json.object("contract",validation.contract,"issues",validation.issues,"executionId",value==null?null:value.get("executionId"),"messageKey",messageKey)));
            else System.err.println("Rejected unreadable "+processor.agent()+" invocation: "+Json.stringify(Json.object("contract","AgentInvocationV1","issues",Json.array(Json.object("path","/","message",AgentProcessor.message(error))),"executionId",value==null?null:value.get("executionId"),"messageKey",messageKey)));
            return;
        }
        ObjectNode result=processor.process(invocation);
        // Publication is outside execution's failure conversion. A broker failure cannot become a second result.
        publisher.publish(result.path("executionId").asText(),result);
    }
    @Override public synchronized void close() {
        if(closed)return;
        running=false;consumer.wakeup();boolean interrupted=false;
        // Keep the producer alive until the active runner, result publication and offset commit settle.
        if(thread!=null)while(thread.isAlive())try{thread.join();}catch(InterruptedException e){interrupted=true;}
        else consumer.close();
        try {producer.close(Duration.ofSeconds(5));}finally {closed=true;if(interrupted)Thread.currentThread().interrupt();}
    }
}
