package io.tenvyr.agents;

import io.tenvyr.platform.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.time.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.serialization.*;

/** Production agent code over a real Kafka broker; the model response is deterministic test input. */
public final class AgentIntegrationCheck {
    private static int checks;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    public static void main(String[] args)throws Exception {
        String brokers=System.getenv("TEST_KAFKA_BROKERS");if(brokers==null)throw new IllegalArgumentException("TEST_KAFKA_BROKERS is required (disposable broker)");
        Path root=Path.of(args.length>0?args[0]:".");String identity=UUID.randomUUID().toString();
        Properties send=new Properties();send.put("bootstrap.servers",brokers);send.put("key.serializer",StringSerializer.class.getName());send.put("value.serializer",StringSerializer.class.getName());
        Properties read=new Properties();read.put("bootstrap.servers",brokers);read.put("group.id","tenvyr-agent-integration-"+identity);read.put("auto.offset.reset","latest");read.put("enable.auto.commit","false");read.put("key.deserializer",StringDeserializer.class.getName());read.put("value.deserializer",StringDeserializer.class.getName());
        try(Admin admin=Admin.create(Map.of("bootstrap.servers",brokers));KafkaProducer<String,String> producer=new KafkaProducer<>(send);KafkaConsumer<String,String> consumer=new KafkaConsumer<>(read)){
            Set<String> existing=admin.listTopics().names().get(20,TimeUnit.SECONDS);List<NewTopic> topics=new ArrayList<>();
            for(String agent:List.of("code-reviewer","observability"))for(String type:List.of("task","result","event")){String topic="agentweave.agent."+agent+"."+type;if(!existing.contains(topic))topics.add(new NewTopic(topic,1,(short)1));}
            if(!topics.isEmpty())admin.createTopics(topics).all().get(20,TimeUnit.SECONDS);
            consumer.subscribe(List.of("agentweave.agent.code-reviewer.result","agentweave.agent.observability.result"));
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);while(consumer.assignment().isEmpty()&&System.nanoTime()<deadline)consumer.poll(Duration.ofMillis(100));check(!consumer.assignment().isEmpty(),"result observer assigned");
            for(String agent:List.of("code-reviewer","observability")){
                AgentProcessor processor=new AgentProcessor(agent,root.resolve("skills"),(prompt,context,timeout)->Json.object("data",Json.object("output",agent.equals("code-reviewer")?"{\"score\":95,\"findings\":[]}":"{\"status\":\"HEALTHY\",\"analysis\":\"ok\",\"latencySec\":0}","promptTokens",1,"completionTokens",2,"totalTokens",3)));
                try(KafkaAgent service=new KafkaAgent(processor,brokers)){
                    service.start();String group=agent.equals("code-reviewer")?"agentweave-reviewer-group":"agentweave-observability-group";
                    deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
                    while(System.nanoTime()<deadline){var members=admin.describeConsumerGroups(List.of(group)).all().get(5,TimeUnit.SECONDS).get(group).members();if(members.stream().anyMatch(m->!m.assignment().topicPartitions().isEmpty()))break;Thread.sleep(100);}
                    String invocation=identity+":"+agent;
                    ObjectNode task=Json.object("schemaVersion","1","invocationId",invocation,"executionId",identity,"stepExecutionId","step-"+agent,"stepId","step","target",Json.object("agent",agent),"input",Json.object("code","const ok = true","logs","ok"),"attempt",1,"createdAt",Protocol.jsInstant(Instant.now()),"trace",Json.object("traceId",identity,"correlationId",invocation));
                    producer.send(new ProducerRecord<>("agentweave.agent."+agent+".task",identity,"not JSON")).get(10,TimeUnit.SECONDS);
                    producer.send(new ProducerRecord<>("agentweave.agent."+agent+".task",identity,Json.stringify(Protocol.invocation(task)))).get(10,TimeUnit.SECONDS);
                    ObjectNode result=null;deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
                    while(result==null&&System.nanoTime()<deadline)for(var record:consumer.poll(Duration.ofMillis(100))){var parsed=Protocol.result(Json.parse(record.value()));if(parsed.path("invocationId").asText().equals(invocation)){check(record.key().equals(identity),"execution message key preserved");result=parsed;}}
                    check(result!=null,"real agent publishes result: "+agent);check(result.path("status").asText().equals("succeeded"),"agent result succeeds");check(result.path("usage").path("totalTokens").asInt()==3,"usage preserved");
                    deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);boolean committed=false;
                    while(!committed&&System.nanoTime()<deadline){committed=admin.listConsumerGroupOffsets(group).partitionsToOffsetAndMetadata().get(5,TimeUnit.SECONDS).values().stream().anyMatch(o->o.offset()>=2);if(!committed)Thread.sleep(50);}
                    check(committed,"poison and result publication commit real Kafka offsets");
                }
            }
        }
        System.out.println("AgentIntegrationCheck: "+checks+" real Kafka checks passed");
    }
}
