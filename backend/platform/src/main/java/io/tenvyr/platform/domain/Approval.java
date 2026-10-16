package io.tenvyr.platform.domain;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.tenvyr.platform.Json;
import java.time.Instant;
import java.util.List;
public final class Approval {
    public static final long DEFAULT_EXPIRY_MS=7L*24*60*60*1000,MAX_EXPIRY_MS=90L*24*60*60*1000;
    public static final int NOTE_MAX_LENGTH=255,EXPIRE_SWEEP_BATCH=100;
    public static final List<String> STATUSES=List.of("PENDING","APPROVED","DENIED","EXPIRED");
    private Approval(){}
    public static ObjectNode assertApprovalTransition(String from,String to){if(!"PENDING".equals(from))throw invalid("Approval request is "+from+"; only PENDING requests can transition");if(!List.of("APPROVED","DENIED","EXPIRED").contains(to))throw invalid("No transition from "+from+" to "+to);return Json.object("from",from,"to",to);}
    public static Instant approvalExpiry(Instant now,long expiresInMs){if(expiresInMs<=0||expiresInMs>MAX_EXPIRY_MS)throw invalid("expiresInMs must be an integer between 1 and "+MAX_EXPIRY_MS);return now.plusMillis(expiresInMs);}
    public static String boundedApprovalNote(JsonNode note){if(note==null||note.isNull()||note.isMissingNode())return null;if(!note.isTextual()||note.asText().trim().isEmpty()||note.asText().length()>NOTE_MAX_LENGTH)throw invalid("approval note must be 1-"+NOTE_MAX_LENGTH+" characters");return note.asText();}
    private static DomainError invalid(String message){return new DomainError("POLICY_CONFIG_INVALID",message);}
}
