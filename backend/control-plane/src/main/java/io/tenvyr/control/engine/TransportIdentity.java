package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.JsonNode;
import io.tenvyr.platform.Json;

record TransportIdentity(String adapter,String scope,String messageId) {
  static TransportIdentity of(JsonNode transport){String adapter=Json.text(transport,"adapter");if(adapter==null||adapter.length()>50)throw new IllegalArgumentException("Transport adapter exceeds durable bound");String scope,message;
    if(adapter.equals("kafka")){String topic=Json.text(transport,"topic");scope=topic==null?null:topic+":"+transport.path("partition").asInt(0);if(scope!=null&&scope.length()>255)scope="kafka-sha256:"+Json.sha256(scope);message=Json.text(transport,"offset");}else{scope=Json.text(transport,"keyId");message=Json.text(transport,"deliveryId");}
    if(scope!=null&&scope.length()>255||message!=null&&message.length()>255)throw new IllegalArgumentException("Transport identity exceeds durable bound");return new TransportIdentity(adapter,scope,message);
  }
}
