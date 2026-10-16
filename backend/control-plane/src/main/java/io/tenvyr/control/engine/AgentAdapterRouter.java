package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.node.ObjectNode;

public final class AgentAdapterRouter implements AgentAdapter {
  private final AgentAdapter kafka,http;private final AgentTransportConfig config;private volatile boolean started;
  public AgentAdapterRouter(AgentAdapter kafka,AgentAdapter http,AgentTransportConfig config){this.kafka=kafka;this.http=http;this.config=config;}
  public String kind(){return "router";}
  public synchronized void start(Handlers handlers)throws Exception{if(started)return;boolean connected=false;try{kafka.start(handlers);connected=true;http.start(handlers);started=true;}catch(Exception error){if(connected)try{kafka.close();}catch(Exception ignored){}throw new AdapterError("ADAPTER_START_FAILED",true,"Agent adapter router failed to start",0,error);}}
  public ObjectNode invoke(ObjectNode invocation,ObjectNode pinned)throws Exception{if(!started)throw new AdapterError("ADAPTER_NOT_STARTED",true,"Adapter router is not started");String kind=pinned==null?config.forAgent(invocation.path("target").path("agent").asText()).path("kind").asText():pinned.path("kind").asText();if(kind.equals("http")){if(pinned!=null&&!pinned.has("httpProfile"))throw new AdapterError("EXECUTOR_PROFILE_MISMATCH",false,"Pinned HTTP executor descriptor is missing routing profile");return http.invoke(invocation,pinned);}return kafka.invoke(invocation,pinned);}
  public synchronized void close()throws Exception{if(!started)return;Exception first=null;try{http.close();}catch(Exception e){first=e;}try{kafka.close();}catch(Exception e){if(first==null)first=e;}if(first!=null)throw new AdapterError("ADAPTER_STOP_FAILED",true,"Adapter router failed to stop",0,first);started=false;}
}
