package io.tenvyr.control;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.*;
import io.tenvyr.agents.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.serialization.StringSerializer;

/** Real API -> PostgreSQL claim/outbox -> Kafka -> production Java agents -> durable result/event inbox. */
public final class ControlKafkaIntegrationCheck {
    private static int checks,port;
    private static void check(boolean ok,String label){checks++;if(!ok)throw new AssertionError(label);}
    private static JsonNode api(String path,JsonNode body)throws Exception {
        var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).timeout(Duration.ofSeconds(10));
        if(body!=null)builder.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(Json.stringify(body)));
        var response=HttpClient.newHttpClient().send(builder.build(),HttpResponse.BodyHandlers.ofString());JsonNode value=Json.parse(response.body());
        check(response.statusCode()<300&&value.path("success").asBoolean(),"Kafka API "+path+": "+value);return value.path("data");
    }
    public static void main(String[] args)throws Exception {
        String brokers=System.getenv("TEST_KAFKA_BROKERS");if(brokers==null)throw new IllegalArgumentException("TEST_KAFKA_BROKERS is required");
        Path root=Path.of(args.length>0?args[0]:".");
        AgentProcessor.Runner model=(prompt,context,timeout)->Json.object("data",Json.object("output",context.has("code")?"{\"score\":95,\"findings\":[]}":"{\"status\":\"HEALTHY\",\"analysis\":\"checked\",\"latencySec\":0}","promptTokens",1,"completionTokens",2,"totalTokens",3));
        try(IntegrationDatabase fixture=new IntegrationDatabase();KafkaAgent reviewer=new KafkaAgent(new AgentProcessor("code-reviewer",root.resolve("skills"),model),brokers);KafkaAgent observer=new KafkaAgent(new AgentProcessor("observability",root.resolve("skills"),model),brokers)){
            reviewer.start();observer.start();
            // No sleeps/group-assignment workaround: production start() itself must be ready before admission.
            try(ServerSocket socket=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){port=socket.getLocalPort();}
            Map<String,String> env=Map.of("ORCHESTRATOR_PORT",Integer.toString(port),"KAFKA_BROKERS",brokers,"GATEWAY_URL","http://127.0.0.1:1","AGENT_TRANSPORT_CONFIG",Json.stringify(Json.object("code-reviewer",Json.object("kind","kafka"),"observability",Json.object("kind","kafka"))));
            try(Main control=new Main(fixture.db,env)){
                control.start();
                JsonNode pipeline=api("/pipelines",Json.object("name","real-kafka","steps",Json.array(Json.object("id","review","agent","code-reviewer","input",Json.object("code","const checked = true")),Json.object("id","observe","agent","observability","dependsOn",Json.array("review"),"input",Json.object("logs","fixture","findings","{{steps.review.result.findings}}")))));
                JsonNode execution=api("/executions",Json.object("pipelineId",pipeline.get("id")));String id=execution.path("id").asText();long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(25);
                do{execution=api("/executions/"+id,null);if(Set.of("COMPLETED","FAILED").contains(execution.path("status").asText()))break;Thread.sleep(50);}while(System.nanoTime()<deadline);
                check(execution.path("status").asText().equals("COMPLETED"),"real Kafka DAG completes: "+execution);
                check(execution.path("output").path("review").path("score").asInt()==95&&execution.path("output").path("observe").path("status").asText().equals("HEALTHY"),"both specialized production processors preserve result shapes");
                check(fixture.db.one("SELECT count(*) n FROM result_inbox WHERE \"sourceAdapter\"='kafka'").path("n").asInt()==2,"two durable Kafka results");
                check(fixture.db.one("SELECT count(*) n FROM dispatch_outbox WHERE status='COMPLETED'").path("n").asInt()==2,"two completed durable Kafka outbox handoffs");
                JsonNode attempt=fixture.db.one("SELECT * FROM step_attempts WHERE \"executionId\"=? ORDER BY \"createdAt\" LIMIT 1",id);
                var event=Json.object("schemaVersion","1","eventId","kafka-progress","invocationId",attempt.get("invocationId"),"executionId",id,"stepExecutionId",attempt.get("logicalStepId"),"sequence",0,"type","progress","payload",Json.object("percent",100),"trace",Json.object("traceId",id,"correlationId",attempt.get("invocationId")),"occurredAt",Protocol.jsInstant(Instant.now()));
                Properties properties=new Properties();properties.put("bootstrap.servers",brokers);properties.put("key.serializer",StringSerializer.class.getName());properties.put("value.serializer",StringSerializer.class.getName());
                try(KafkaProducer<String,String> producer=new KafkaProducer<>(properties)){
                    for(int duplicate=0;duplicate<2;duplicate++)producer.send(new ProducerRecord<>("agentweave.agent.code-reviewer.event",id,Json.stringify(Protocol.event(event)))).get(10,TimeUnit.SECONDS);
                    event.put("eventId","conflicting-sequence");producer.send(new ProducerRecord<>("agentweave.agent.code-reviewer.event",id,Json.stringify(event))).get(10,TimeUnit.SECONDS);
                }
                deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while(fixture.db.one("SELECT count(*) n FROM agent_event_conflicts").path("n").asInt()==0&&System.nanoTime()<deadline)Thread.sleep(50);
                check(fixture.db.one("SELECT count(*) n FROM agent_events").path("n").asInt()==1,"real Kafka event redelivery idempotent");
                check(fixture.db.one("SELECT count(*) n FROM agent_event_conflicts").path("n").asInt()==1,"Kafka sequence conflict remains durable evidence");
                check(fixture.db.one("SELECT status FROM step_attempts WHERE id=?",attempt.get("id")).path("status").asText().equals("SUCCESS"),"late event cannot resurrect terminal attempt");
            }
        }
        System.out.println("ControlKafkaIntegrationCheck: "+checks+" real PostgreSQL/Kafka/DAG/event checks passed");
    }
}
