package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.*;
import java.util.*;

public final class PipelineService {
  private final Db db; private final EngineAuthority authority; private final Conditions conditions;
  public PipelineService(Db db,EngineAuthority authority,Conditions conditions){this.db=db;this.authority=authority;this.conditions=conditions;}
  public ObjectNode create(JsonNode input){ObjectNode definition=validate(input);definition.put("schemaVersion",1);definition.put("contentHash",Json.hash(validate(input)));return db.insert("pipelines",definition);}
  public ObjectNode findOne(String id){ObjectNode p=db.one("SELECT * FROM pipelines WHERE id=?",id);if(p!=null)p.set("steps",validate(p).get("steps"));return p;}
  public List<ObjectNode> findAll(){return db.query("SELECT * FROM pipelines ORDER BY \"createdAt\" DESC");}
  public ObjectNode validate(JsonNode input){ObjectNode n=Json.requireObject(input,"Pipeline");ObjectNode out=Json.object("name",string(n.get("name"),"name",255,false),"version",string(n.get("version"),"version",50,false),"steps",validateSteps(n.get("steps")));if(n.hasNonNull("description"))out.put("description",string(n.get("description"),"description",10000,true));JsonNode budget=authority.validatePipelineBudget(n.get("budget"));if(budget!=null&&!budget.isNull())out.set("budget",budget);return out;}
  public ArrayNode validateSteps(JsonNode steps){if(steps==null||!steps.isArray()||steps.isEmpty())throw new IllegalArgumentException("Plan must contain at least one step");if(steps.size()>100)throw new IllegalArgumentException("Plan exceeds 100 steps");ArrayNode out=Json.array();int i=0;for(JsonNode step:steps)out.add(validateStep(step,i++));validateGraph(out);return out;}
  private ObjectNode validateStep(JsonNode node,int index){String path="steps["+index+"]";ObjectNode n=Json.requireObject(node,path);String id=string(n.get("id"),path+".id",100,false);if(!identifier(id))throw new IllegalArgumentException(path+".id is not a valid identifier");ObjectNode out=Json.object("id",id,"agent",string(n.get("agent"),path+".agent",100,false));
    if(n.has("dependsOn")){JsonNode deps=n.get("dependsOn");if(!deps.isArray())throw new IllegalArgumentException(path+".dependsOn must contain valid step identifiers");for(JsonNode d:deps)if(!d.isTextual()||!identifier(d.asText()))throw new IllegalArgumentException(path+".dependsOn must contain valid step identifiers");out.set("dependsOn",deps.deepCopy());}
    if(n.has("retries")){double retry;try{JsonNode v=n.get("retries");retry=v.isNull()?0:v.isBoolean()?(v.asBoolean()?1:0):v.isTextual()?(v.asText().trim().isEmpty()?0:Double.parseDouble(v.asText())):v.doubleValue();}catch(Exception e){retry=-1;}if(!Double.isFinite(retry)||retry<0||retry!=Math.floor(retry)||retry>Integer.MAX_VALUE-1)throw new IllegalArgumentException(path+".retries must be a non-negative integer");out.put("retries",(int)retry);}
    if(n.has("onFailure")){if(!n.get("onFailure").isTextual()||!Set.of("continue","stop","retry").contains(n.get("onFailure").asText()))throw new IllegalArgumentException(path+".onFailure is not supported");out.set("onFailure",n.get("onFailure"));}
    if(n.has("timeout")){JsonNode t=n.get("timeout");if((!t.isNumber()&&!t.isTextual())||Templates.durationMs(t)<=0)throw new IllegalArgumentException(path+".timeout must be a positive duration");out.set("timeout",t);}
    for(String key:List.of("input","metadata"))if(n.has(key))out.set(key,Json.requireObject(n.get(key),path+"."+key).deepCopy());
    if(n.has("condition"))out.set("condition",conditions.compile(n.get("condition")));
    if(n.has("planner")){if(!n.get("planner").isBoolean()||!n.get("planner").asBoolean())throw new IllegalArgumentException(path+".planner must be true when present");out.put("planner",true);}
    if(n.has("delegation")){if(!n.get("delegation").isTextual()||!Set.of("opaque","observed").contains(n.get("delegation").asText()))throw new IllegalArgumentException(path+".delegation must be one of opaque, observed");out.set("delegation",n.get("delegation"));}
    if(n.has("contextProjection"))out.set("contextProjection",authority.validateProjection(n.get("contextProjection")));
    if(n.has("stateWrites"))out.set("stateWrites",authority.validateStateWrites(n.get("stateWrites")));
    JsonNode budget=authority.validateStepBudget(n.get("budget"));if(budget!=null&&!budget.isNull())out.set("budget",budget);
    return out;
  }
  private void validateGraph(ArrayNode steps){Map<String,JsonNode> byId=new LinkedHashMap<>();Map<String,Integer> fanout=new HashMap<>();for(JsonNode step:steps){String id=step.path("id").asText();if(byId.put(id,step)!=null)throw new IllegalArgumentException("Duplicate step id: "+id);Set<String> seen=new HashSet<>();for(JsonNode d:step.path("dependsOn"))if(!seen.add(d.asText()))throw new IllegalArgumentException("Step "+id+" contains a duplicate dependency");}
    for(JsonNode step:steps)for(JsonNode d:step.path("dependsOn")){if(!byId.containsKey(d.asText()))throw new IllegalArgumentException("Step "+step.path("id").asText()+" depends on missing step "+d.asText());if(fanout.merge(d.asText(),1,Integer::sum)>20)throw new IllegalArgumentException("Step "+d.asText()+" exceeds fanout 20");}
    Map<String,Integer> depths=new HashMap<>();for(String id:byId.keySet())depth(id,byId,depths,new HashSet<>());
    Map<String,List<String>> writers=new HashMap<>();for(JsonNode step:steps){String id=step.path("id").asText();for(JsonNode a:step.path("contextProjection").path("artifacts")){String source=a.path("fromStep").asText();if(source.equals(id)||!transitive(id,source,byId,new HashSet<>()))throw new IllegalArgumentException("Step "+id+" projects artifacts from "+source+", which is not a transitive dependency");}for(JsonNode write:step.path("stateWrites"))writers.computeIfAbsent(write.path("key").asText(),k->new ArrayList<>()).add(id);}
    for(var entry:writers.entrySet()){List<String> ids=entry.getValue();for(int a=0;a<ids.size();a++)for(int b=a+1;b<ids.size();b++)if(!transitive(ids.get(a),ids.get(b),byId,new HashSet<>())&&!transitive(ids.get(b),ids.get(a),byId,new HashSet<>()))throw new IllegalArgumentException("Steps "+ids.get(a)+" and "+ids.get(b)+" both write state key \""+entry.getKey()+"\" without proven ordering");}
  }
  private int depth(String id,Map<String,JsonNode> steps,Map<String,Integer> depths,Set<String> visiting){if(depths.containsKey(id))return depths.get(id);if(!visiting.add(id))throw new IllegalArgumentException("Pipeline contains a cycle at step "+id);int value=1;for(JsonNode d:steps.get(id).path("dependsOn"))value=Math.max(value,1+depth(d.asText(),steps,depths,visiting));visiting.remove(id);if(value>20)throw new IllegalArgumentException("Pipeline exceeds graph depth 20");depths.put(id,value);return value;}
  private boolean transitive(String id,String source,Map<String,JsonNode> steps,Set<String> seen){if(!seen.add(id))return false;for(JsonNode d:steps.get(id).path("dependsOn")){if(d.asText().equals(source)||transitive(d.asText(),source,steps,seen))return true;}return false;}
  private static boolean identifier(String value){return value.matches("^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$");}
  private String string(JsonNode n,String path,int max,boolean empty){if(n==null||!n.isTextual()||(!empty&&n.asText().trim().isEmpty())||n.asText().length()>max)throw new IllegalArgumentException(path+" must be "+(empty?"a":"a non-empty")+" string no longer than "+max+" characters");return n.asText();}
}
