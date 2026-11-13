package io.tenvyr.review;

import io.tenvyr.control.ControlPlaneRuntime;
import io.tenvyr.control.engine.HttpAgentAdapter;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;

/**
 * Controller for signed HTTP agent callbacks.
 * Enforces raw bounded streaming body (<=1 MiB), HMAC authentication delegation,
 * and status code mapping.
 */
@RestController
public class AgentCallbackController {

    private static final int MAX_CALLBACK_BODY_BYTES = 1024 * 1024; // 1 MiB bound
    private static final String CODE_REVIEWER_AGENT = "code-reviewer";

    private final ControlPlaneRuntime engineRuntime;

    @Autowired
    public AgentCallbackController(ControlPlaneRuntime engineRuntime) {
        this.engineRuntime = engineRuntime;
    }

    @PostMapping("/internal/agent-callbacks/http/code-reviewer")
    public ResponseEntity<Void> handleCodeReviewerCallback(HttpServletRequest request) {
        String keyId = request.getHeader(HttpAgentAdapter.KEY_ID);
        String timestamp = request.getHeader(HttpAgentAdapter.TIMESTAMP);
        String deliveryId = request.getHeader(HttpAgentAdapter.DELIVERY_ID);
        String signature = request.getHeader(HttpAgentAdapter.SIGNATURE);
        String remoteAddress = request.getRemoteAddr();

        long contentLength = request.getContentLengthLong();
        if (contentLength > MAX_CALLBACK_BODY_BYTES) {
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).build();
        }

        byte[] rawBytes;
        try {
            rawBytes = request.getInputStream().readNBytes(MAX_CALLBACK_BODY_BYTES + 1);
        } catch (IOException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).build();
        }

        if (rawBytes.length > MAX_CALLBACK_BODY_BYTES) {
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).build();
        }

        try {
            engineRuntime.callbacks().handleCallback(
                    CODE_REVIEWER_AGENT, keyId, timestamp, deliveryId, signature, rawBytes, remoteAddress, null);
            return ResponseEntity.noContent().build();
        } catch (Throwable error) {
            int status = engineRuntime.callbacks().callbackStatus(error);
            return ResponseEntity.status(status).build();
        }
    }
}
