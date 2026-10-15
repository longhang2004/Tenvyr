package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import java.util.List;
import java.util.regex.*;

public final class Templates {
  private static final Pattern EXACT=Pattern.compile("^\\s*\\{\\{\\s*([^{}]+?)\\s*}}\\s*$"), EMBEDDED=Pattern.compile("\\{\\{\\s*([^{}]+?)\\s*}}");
  private Templates() {}
  public static ObjectNode context(JsonNode input,List<ObjectNode> steps){ObjectNode table=Json.object();for(ObjectNode step:steps){ObjectNode value=Json.object("result",step.get("output"),"output",step.get("output"),"status",step.get("status"),"error",step.get("error"),"attempt",step.get("attempt"));table.set(step.path("stepId").asText(),value);}return Json.object("pipeline",Json.object("input",input),"steps",table);}
  public static JsonNode resolve(JsonNode value,JsonNode context){
    if(value==null)return NullNode.instance;
    if(value.isArray()){ArrayNode out=Json.array();for(JsonNode n:value)out.add(resolve(n,context));return out;}
    if(value.isObject()){ObjectNode out=Json.object();value.fields().forEachRemaining(e->out.set(e.getKey(),resolve(e.getValue(),context)));return out;}
    if(!value.isTextual())return value.deepCopy();
    Matcher exact=EXACT.matcher(value.textValue());if(exact.matches()){JsonNode n=path(context,exact.group(1));return n.isMissingNode()?NullNode.instance:n.deepCopy();}
    Matcher matches=EMBEDDED.matcher(value.textValue());StringBuffer out=new StringBuffer();while(matches.find()){JsonNode n=path(context,matches.group(1));String text=n.isMissingNode()||n.isNull()?"":n.isTextual()?n.textValue():Json.stringify(n);matches.appendReplacement(out,Matcher.quoteReplacement(text));}matches.appendTail(out);return TextNode.valueOf(out.toString());
  }
  private static JsonNode path(JsonNode n,String path){for(String part:path.trim().split("\\.")){if(n==null||n.isNull()||n.isMissingNode())return MissingNode.getInstance();if(n.isArray()&&part.matches("\\d+")){try{n=n.path(Integer.parseInt(part));}catch(NumberFormatException e){return MissingNode.getInstance();}}else n=n.path(part);}return n;}
  public static long durationMs(JsonNode value){if(value==null||value.isNull())return 0;if(value.isNumber())return value.doubleValue()>0?(long)value.doubleValue():0;Matcher m=Pattern.compile("^(\\d+(?:\\.\\d+)?)(ms|s|m|h)?$",Pattern.CASE_INSENSITIVE).matcher(value.asText().trim());if(!m.matches())return 0;double multiplier=switch(m.group(2)==null?"ms":m.group(2).toLowerCase()){case "s"->1000;case "m"->60000;case "h"->3600000;default->1;};return (long)(Double.parseDouble(m.group(1))*multiplier);}
}
