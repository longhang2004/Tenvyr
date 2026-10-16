package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.node.ObjectNode;

public interface AgentAdapter extends AutoCloseable {
  interface Handlers { void result(ObjectNode result,ObjectNode transport) throws Exception; void event(ObjectNode event,ObjectNode transport) throws Exception; }
  String kind();
  void start(Handlers handlers) throws Exception;
  ObjectNode invoke(ObjectNode invocation,ObjectNode frozenExecutor) throws Exception;
  default ObjectNode cancel(ObjectNode request)throws Exception{return io.tenvyr.platform.Json.object("delivered",false,"message","unsupported");}
  @Override void close() throws Exception;
}
