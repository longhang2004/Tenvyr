package io.tenvyr.platform;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.math.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.text.Collator;
import java.util.*;

/** The one JSON representation used at transport, domain and persistence boundaries. */
public final class Json {
    public static final ObjectMapper MAPPER = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final ThreadLocal<Collator> COLLATOR=ThreadLocal.withInitial(()->{Collator c=Collator.getInstance(Locale.US);c.setStrength(Collator.TERTIARY);c.setDecomposition(Collator.CANONICAL_DECOMPOSITION);return c;});
    private Json() {}
    public static JsonNode parse(String text) {
        try { JsonNode out=MAPPER.readTree(text);if(out==null||out.isMissingNode())throw new IllegalArgumentException("JSON text is empty");return out; } catch (Exception e) { throw new IllegalArgumentException("Invalid JSON", e); }
    }
    public static JsonNode value(Object value) { return value instanceof JsonNode n ? n : MAPPER.valueToTree(value); }
    public static ObjectNode object() { return MAPPER.createObjectNode(); }
    public static ObjectNode object(Object... pairs) {
        if (pairs.length % 2 != 0) throw new IllegalArgumentException("Expected key/value pairs");
        ObjectNode out = object();
        for (int i=0;i<pairs.length;i+=2) out.set((String)pairs[i], value(pairs[i+1]));
        return out;
    }
    public static ArrayNode array(Object... values) { ArrayNode out=MAPPER.createArrayNode(); for(Object value: values) out.add(value(value)); return out; }
    public static ObjectNode requireObject(JsonNode n, String name) { if(n==null || !n.isObject()) throw new IllegalArgumentException(name+" must be an object"); return (ObjectNode)n; }
    public static String text(JsonNode n, String key) { return text(n,key,null); }
    public static String text(JsonNode n, String key, String fallback) { JsonNode v=n==null?null:n.get(key); return v==null || v.isNull()?fallback:v.asText(); }
    public static int integer(JsonNode n,String key,int fallback) { JsonNode v=n==null?null:n.get(key); return v==null || v.isNull()?fallback:v.asInt(); }
    public static long longValue(JsonNode n,String key,long fallback) { JsonNode v=n==null?null:n.get(key); return v==null || v.isNull()?fallback:v.asLong(); }
    public static double number(JsonNode n,String key,double fallback) { JsonNode v=n==null?null:n.get(key); return v==null || v.isNull()?fallback:v.asDouble(); }
    public static boolean bool(JsonNode n,String key,boolean fallback) { JsonNode v=n==null?null:n.get(key); return v==null || v.isNull()?fallback:v.asBoolean(); }
    public static JsonNode get(JsonNode n,String key) { JsonNode v=n==null?null:n.get(key); return v==null?NullNode.instance:v; }
    public static String stringify(JsonNode n) { return serialize(n,false); }
    public static String canonical(JsonNode n) { return serialize(n,true); }
    public static String hash(JsonNode n) { return sha256(canonical(n)); }
    public static String sha256(String text) { return sha256(text.getBytes(StandardCharsets.UTF_8)); }
    public static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); } catch(NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    public static int bytes(JsonNode n) { return canonical(n).getBytes(StandardCharsets.UTF_8).length; }
    public static JsonNode copy(JsonNode n) { return n==null?NullNode.instance:n.deepCopy(); }
    public static List<String> keys(JsonNode n) { List<String> out=new ArrayList<>(); if(n!=null) n.fieldNames().forEachRemaining(out::add); return out; }
    public static int localeCompare(String a,String b) { return COLLATOR.get().compare(a,b); }
    private static String serialize(JsonNode n,boolean canonical) {
        if(n==null || n.isNull() || n.isMissingNode()) return "null";
        if(n.isObject()) {
            List<String> keys=keys(n); if(canonical) keys.sort(Json::localeCompare);
            else keys.sort((a,b)-> { long x=arrayIndex(a),y=arrayIndex(b); return x>=0?(y>=0?Long.compare(x,y):-1):(y>=0?1:0); });
            StringJoiner out=new StringJoiner(",","{","}"); for(String key:keys) out.add(quote(key)+":"+serialize(n.get(key),canonical)); return out.toString();
        }
        if(n.isArray()) { StringJoiner out=new StringJoiner(",","[","]"); for(JsonNode child:n) out.add(serialize(child,canonical)); return out.toString(); }
        if(n.isTextual()) return quote(n.textValue());
        if(n.isNumber()) return jsNumber(n.doubleValue());
        if(n.isBoolean()) return n.booleanValue()?"true":"false";
        throw new IllegalArgumentException("Non-JSON node");
    }
    private static long arrayIndex(String s) { try { long n=Long.parseLong(s); return n>=0 && n<4294967295L && Long.toString(n).equals(s)?n:-1; } catch(NumberFormatException e) { return -1; } }
    public static String quote(String s) {
        StringBuilder out=new StringBuilder("\"");
        for(int i=0;i<s.length();i++) { char c=s.charAt(i); switch(c) {
            case '"' -> out.append("\\\""); case '\\' -> out.append("\\\\"); case '\b' -> out.append("\\b"); case '\f' -> out.append("\\f"); case '\n' -> out.append("\\n"); case '\r' -> out.append("\\r"); case '\t' -> out.append("\\t");
            default -> { if(c<32 || (Character.isSurrogate(c) && !(Character.isHighSurrogate(c) && i+1<s.length() && Character.isLowSurrogate(s.charAt(i+1))) && !(Character.isLowSurrogate(c) && i>0 && Character.isHighSurrogate(s.charAt(i-1))))) out.append(String.format("\\u%04x",(int)c)); else out.append(c); }
        }} return out.append('"').toString();
    }
    /** ECMAScript shortest round-trip number rendering, including fixed/exponent cutovers. */
    public static String jsNumber(double d) {
        if(!Double.isFinite(d)) return "null"; if(d==0) return "0";
        boolean negative=d<0; double abs=Math.abs(d); BigDecimal exact=new BigDecimal(abs),shortest=null;
        for(int precision=1;precision<=17;precision++) {
            BigDecimal candidate=exact.round(new MathContext(precision,RoundingMode.HALF_EVEN));
            if(Double.parseDouble(candidate.toString())==abs) { shortest=candidate.stripTrailingZeros(); break; }
        }
        if(shortest==null) shortest=BigDecimal.valueOf(abs).stripTrailingZeros();
        int exponent=shortest.precision()-shortest.scale()-1;
        String result;
        if(exponent>=-6 && exponent<21) result=shortest.toPlainString();
        else { String digits=shortest.unscaledValue().abs().toString(); result=digits.charAt(0)+(digits.length()>1?"."+digits.substring(1):"")+"e"+(exponent>=0?"+":"")+exponent; }
        return negative?"-"+result:result;
    }
}
