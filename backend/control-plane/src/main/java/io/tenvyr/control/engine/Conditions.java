package io.tenvyr.control.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import io.tenvyr.platform.Json;
import java.util.Set;
import java.util.regex.*;

/** Declarative condition language. Missing references remain distinct from explicit JSON null. */
public final class Conditions {
  private static final Pattern REFERENCE = Pattern.compile("^(?:pipeline\\.input|steps\\.[a-zA-Z0-9_-]+\\.(?:result|output|status|error|attempt))(?:\\.[a-zA-Z0-9_-]+)*$");
  private static final Pattern COMPARISON = Pattern.compile("^\\s*([^\\s]+)\\s*(===|!==|==|!=|>=|<=|>|<)\\s*(.+?)\\s*$");
  public JsonNode compile(JsonNode condition) {
    JsonNode result = condition;
    if (condition.isTextual()) {
      String text = condition.textValue();
      Matcher wrap=Pattern.compile("^\\s*\\{\\{\\s*([\\s\\S]+?)\\s*}}\\s*$").matcher(text);
      if(wrap.matches())text=wrap.group(1);
      Matcher m=COMPARISON.matcher(text);
      if(!m.matches())throw new IllegalArgumentException("Legacy condition must be one comparison between a supported reference and a literal/reference");
      String op=switch(m.group(2)){case "===","=="->"eq";case "!==","!="->"ne";case ">"->"gt";case ">="->"gte";case "<"->"lt";default->"lte";};
      result=Json.object("op",op,"left",legacyOperand(m.group(1)),"right",legacyOperand(m.group(3)));
    }
    validate(result,"condition",1); return result.deepCopy();
  }
  private JsonNode legacyOperand(String text) {
    text=text.trim(); if(REFERENCE.matcher(text).matches())return Json.object("ref",text);
    if(text.matches("^'(?:[^'\\\\]|\\\\.)*'$"))return TextNode.valueOf(text.substring(1,text.length()-1).replace("\\'","'").replace("\\\\","\\"));
    try {JsonNode n=Json.parse(text);if(n==null||n.isValueNode())return n==null?NullNode.instance:n;}catch(IllegalArgumentException ignored){}
    throw new IllegalArgumentException("Unsupported legacy condition operand: "+text);
  }
  private void validate(JsonNode n,String path,int depth) {
    if(depth>20)throw new IllegalArgumentException("Condition exceeds depth 20");
    if(!n.isObject()||!n.path("op").isTextual())throw new IllegalArgumentException(path+" must be a declarative condition object");
    switch(n.path("op").asText()) {
      case "and","or" -> {JsonNode list=n.path("conditions");if(!list.isArray()||list.isEmpty())throw new IllegalArgumentException(path+".conditions must be a non-empty array");int i=0;for(JsonNode child:list)validate(child,path+".conditions["+(i++)+"]",depth+1);}
      case "not" -> validate(n.path("condition"),path+".condition",depth+1);
      case "exists" -> operand(n.path("value"),path+".value");
      case "in" -> {operand(n.path("value"),path+".value");JsonNode values=n.path("values");if(values.isArray()){if(values.isEmpty())throw new IllegalArgumentException(path+".values must not be empty");for(JsonNode item:values)operand(item,path+".values");}else reference(values,path+".values");}
      case "eq","ne","gt","gte","lt","lte" -> {operand(n.path("left"),path+".left");operand(n.path("right"),path+".right");}
      default -> throw new IllegalArgumentException(path+".op is not supported");
    }
  }
  private void operand(JsonNode n,String path){if(n.isNull()||n.isTextual()||n.isNumber()||n.isBoolean())return;reference(n,path);}
  private void reference(JsonNode n,String path){if(!n.isObject()||!n.path("ref").isTextual()||!REFERENCE.matcher(n.path("ref").asText()).matches())throw new IllegalArgumentException(path+" must be a supported context reference");}
  public boolean evaluate(JsonNode expression,JsonNode context) {
    String op=expression.path("op").asText();
    if(op.equals("and")){for(JsonNode n:expression.path("conditions"))if(!evaluate(n,context))return false;return true;}
    if(op.equals("or")){for(JsonNode n:expression.path("conditions"))if(evaluate(n,context))return true;return false;}
    if(op.equals("not"))return !evaluate(expression.path("condition"),context);
    if(op.equals("exists"))return !resolve(expression.path("value"),context).isMissingNode();
    if(op.equals("in")){JsonNode value=resolve(expression.path("value"),context),values=expression.path("values");if(values.isArray()){for(JsonNode n:values)if(strictEquals(value,resolve(n,context)))return true;}else{JsonNode resolved=resolve(values,context);if(resolved.isArray())for(JsonNode n:resolved)if(strictEquals(value,n))return true;}return false;}
    JsonNode left=resolve(expression.path("left"),context),right=resolve(expression.path("right"),context);
    if(op.equals("eq"))return strictEquals(left,right);if(op.equals("ne"))return !strictEquals(left,right);
    int compared;
    if(left.isNumber()&&right.isNumber())compared=Double.compare(left.doubleValue(),right.doubleValue());
    else if(left.isTextual()&&right.isTextual())compared=left.textValue().compareTo(right.textValue());else return false;
    return switch(op){case "gt"->compared>0;case "gte"->compared>=0;case "lt"->compared<0;case "lte"->compared<=0;default->false;};
  }
  private JsonNode resolve(JsonNode operand,JsonNode context){if(!operand.isObject()||!operand.has("ref"))return operand;JsonNode n=context;for(String p:operand.path("ref").asText().split("\\.")){if(!n.isObject())return MissingNode.getInstance();n=n.path(p);}return n;}
  private boolean strictEquals(JsonNode a,JsonNode b){if(a.isContainerNode()||b.isContainerNode())return a==b;if(a.isNumber()&&b.isNumber())return a.doubleValue()==b.doubleValue();return a.equals(b);}
}
