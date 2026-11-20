package io.tenvyr.review;

import io.tenvyr.platform.Json;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.FilterConfig;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Servlet filter enforcing strict 1 MiB (1,048,576 bytes) request body limit.
 * Operates during streaming before JSON allocation or Spring MVC argument binding.
 * Does not trust misleading declared Content-Length headers and bounds chunked/raw input.
 * Returns HTTP 413 Payload Too Large with safe error JSON when exceeded.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestBodyLimitFilter implements Filter {

    public static final int MAX_BODY_BYTES = 1024 * 1024; // 1 MiB = 1,048,576 bytes

    public RequestBodyLimitFilter() {}

    @Override
    public void init(FilterConfig filterConfig) {}

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        if (!(request instanceof HttpServletRequest httpRequest) || !(response instanceof HttpServletResponse httpResponse)) {
            chain.doFilter(request, response);
            return;
        }

        String path = httpRequest.getRequestURI();
        if (path == null || !path.startsWith("/api/v1/reviews")) {
            chain.doFilter(request, response);
            return;
        }

        String method = httpRequest.getMethod();
        boolean hasPotentialBody = "POST".equalsIgnoreCase(method)
                || "PUT".equalsIgnoreCase(method)
                || "PATCH".equalsIgnoreCase(method);

        if (!hasPotentialBody) {
            chain.doFilter(request, response);
            return;
        }

        long declaredLength = httpRequest.getContentLengthLong();
        if (declaredLength > MAX_BODY_BYTES) {
            write413Response(httpResponse);
            return;
        }

        // Bounded stream read: enforce 1 MiB limit before JSON allocation
        ServletInputStream is = httpRequest.getInputStream();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int totalRead = 0;
        int read;

        while ((read = is.read(buffer)) != -1) {
            totalRead += read;
            if (totalRead > MAX_BODY_BYTES) {
                write413Response(httpResponse);
                return;
            }
            baos.write(buffer, 0, read);
        }

        byte[] bodyBytes = baos.toByteArray();
        HttpServletRequest wrappedRequest = new BoundedHttpServletRequestWrapper(httpRequest, bodyBytes);
        chain.doFilter(wrappedRequest, response);
    }

    @Override
    public void destroy() {}

    private void write413Response(HttpServletResponse response) throws IOException {
        if (response.isCommitted()) {
            return;
        }
        response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
        response.setContentType("application/json;charset=UTF-8");
        Map<String, String> err = ReviewErrors.error("PAYLOAD_TOO_LARGE", "Request body exceeds maximum allowed size (1 MiB)");
        String body = Json.stringify(Json.value(err));
        response.getWriter().write(body);
    }

    private static class BoundedHttpServletRequestWrapper extends HttpServletRequestWrapper {
        private final byte[] body;

        BoundedHttpServletRequestWrapper(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream bais = new ByteArrayInputStream(body);
            return new DelegatingByteArrayServletInputStream(bais);
        }

        @Override
        public BufferedReader getReader() {
            return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
        }

        @Override
        public int getContentLength() {
            return body.length;
        }

        @Override
        public long getContentLengthLong() {
            return body.length;
        }
    }

    private static class DelegatingByteArrayServletInputStream extends ServletInputStream {
        private final InputStream source;

        DelegatingByteArrayServletInputStream(InputStream source) {
            this.source = source;
        }

        @Override
        public boolean isFinished() {
            try {
                return source.available() == 0;
            } catch (IOException e) {
                return true;
            }
        }

        @Override
        public boolean isReady() {
            return true;
        }

        @Override
        public void setReadListener(ReadListener readListener) {}

        @Override
        public int read() throws IOException {
            return source.read();
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            return source.read(b, off, len);
        }
    }
}
