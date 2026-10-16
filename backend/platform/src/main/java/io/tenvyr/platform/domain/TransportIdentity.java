package io.tenvyr.platform.domain;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Json;
public final class TransportIdentity {
    public static final int MAX_SOURCE_ADAPTER_LENGTH=50,MAX_SOURCE_SCOPE_LENGTH=255,MAX_SOURCE_MESSAGE_ID_LENGTH=255;
    private TransportIdentity(){}
    public static String boundedKafkaScope(String raw){return raw.length()<=255?raw:"kafka-sha256:"+Json.sha256(raw);}
    public static ObjectNode durableTransportIdentity(JsonNode transport){String adapter=Json.text(transport,"adapter");if(adapter==null)throw new IllegalArgumentException("Transport adapter is required");if(adapter.length()>50)throw new IllegalArgumentException("Transport adapter \""+adapter+"\" exceeds the 50-character durable bound");String scope,message;
        if(adapter.equals("kafka")){String topic=Json.text(transport,"topic");scope=topic==null?null:boundedKafkaScope(topic+":"+Json.integer(transport,"partition",0));message=Json.text(transport,"offset");if(message!=null&&message.length()>255)throw new IllegalArgumentException("Kafka offset exceeds the 255-character durable bound");}
        else{scope=Json.text(transport,"keyId");message=Json.text(transport,"deliveryId");if(scope!=null&&scope.length()>255)throw new IllegalArgumentException("Transport scope exceeds the 255-character durable bound");if(message!=null&&message.length()>255)throw new IllegalArgumentException("Transport message id exceeds the 255-character durable bound");}
        return Json.object("adapter",adapter,"scope",scope,"messageId",message);
    }
}
