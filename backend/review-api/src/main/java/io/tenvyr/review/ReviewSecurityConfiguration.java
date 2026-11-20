package io.tenvyr.review;

import io.tenvyr.platform.Json;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.DisabledException;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.JdbcUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;

import javax.sql.DataSource;
import java.io.IOException;
import java.util.List;
import java.util.UUID;

/**
 * Spring Security configuration for review API boundary.
 * Configures standard form login with session establishment, CSRF protection,
 * JdbcUserDetailsManager queries, session fixation defense, safe JSON error responses,
 * and dynamic database-backed authorization for REVIEWER metrics.
 */
@Configuration
@EnableWebSecurity
public class ReviewSecurityConfiguration {

    private record UserStatus(String role, boolean enabled) {}

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http, JdbcTemplate jdbcTemplate) throws Exception {
        http
                .csrf(csrf -> csrf
                        .ignoringRequestMatchers(new AntPathRequestMatcher("/internal/agent-callbacks/http/code-reviewer", "POST"))
                )
                .formLogin(form -> form
                        .loginProcessingUrl("/login")
                        .successHandler((request, response, authentication) -> {
                            response.setStatus(HttpServletResponse.SC_NO_CONTENT);
                        })
                        .failureHandler((request, response, exception) -> {
                            writeSafeError(response, HttpServletResponse.SC_UNAUTHORIZED, "UNAUTHORIZED", "Authentication required");
                        })
                        .permitAll()
                )
                .logout(logout -> logout
                        .logoutUrl("/logout")
                        .logoutSuccessHandler((request, response, authentication) -> {
                            response.setStatus(HttpServletResponse.SC_NO_CONTENT);
                        })
                        .invalidateHttpSession(true)
                        .deleteCookies("JSESSIONID")
                        .permitAll()
                )
                .httpBasic(AbstractHttpConfigurer::disable)
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(AntPathRequestMatcher.antMatcher(HttpMethod.GET, "/actuator/health/**")).permitAll()
                        .requestMatchers(AntPathRequestMatcher.antMatcher(HttpMethod.POST, "/internal/agent-callbacks/http/code-reviewer")).permitAll()
                        .requestMatchers(AntPathRequestMatcher.antMatcher(HttpMethod.GET, "/api/v1/auth/csrf")).permitAll()
                        .requestMatchers(
                                AntPathRequestMatcher.antMatcher(HttpMethod.GET, "/actuator/metrics"),
                                AntPathRequestMatcher.antMatcher(HttpMethod.GET, "/actuator/metrics/**")
                        ).access((authentication, context) -> {
                            Authentication a = authentication.get();
                            if (a == null || !a.isAuthenticated() || a instanceof AnonymousAuthenticationToken) {
                                return new AuthorizationDecision(false);
                            }
                            String username = a.getName();
                            if (username == null || username.isBlank()) {
                                return new AuthorizationDecision(false);
                            }
                            List<UserStatus> rows = jdbcTemplate.query(
                                    "SELECT role, enabled FROM tenvyr_review.users WHERE username = ?",
                                    (rs, rowNum) -> new UserStatus(rs.getString("role"), rs.getBoolean("enabled")),
                                    username
                            );
                            if (rows.isEmpty() || !rows.get(0).enabled()) {
                                throw new DisabledException("User account is disabled or missing: " + username);
                            }
                            if (!"REVIEWER".equalsIgnoreCase(rows.get(0).role())) {
                                return new AuthorizationDecision(false);
                            }
                            return new AuthorizationDecision(true);
                        })
                        .requestMatchers(AntPathRequestMatcher.antMatcher("/api/v1/**")).authenticated()
                        .anyRequest().denyAll()
                )
                .exceptionHandling(ex -> ex
                        .authenticationEntryPoint((request, response, authException) -> {
                            writeSafeError(response, HttpServletResponse.SC_UNAUTHORIZED, "UNAUTHORIZED", "Authentication required");
                        })
                        .accessDeniedHandler((request, response, accessDeniedException) -> {
                            writeSafeError(response, HttpServletResponse.SC_FORBIDDEN, "FORBIDDEN", "Access denied");
                        })
                );

        return http.build();
    }

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        JdbcTemplate jdbcTemplate = new JdbcTemplate(dataSource);
        jdbcTemplate.setQueryTimeout(5);
        return jdbcTemplate;
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return PasswordEncoderFactories.createDelegatingPasswordEncoder();
    }

    @Bean
    public UserDetailsService userDetailsService(JdbcTemplate jdbcTemplate) {
        JdbcUserDetailsManager manager = new JdbcUserDetailsManager();
        manager.setJdbcTemplate(jdbcTemplate);
        manager.setUsersByUsernameQuery(
                "SELECT username, password_hash AS password, enabled FROM tenvyr_review.users WHERE username = ?"
        );
        manager.setAuthoritiesByUsernameQuery(
                "SELECT username, 'ROLE_' || role AS authority FROM tenvyr_review.users WHERE username = ?"
        );
        return manager;
    }

    private static void writeSafeError(HttpServletResponse response, int status, String code, String message) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        String json = Json.stringify(Json.object(
                "code", code,
                "message", message,
                "requestId", UUID.randomUUID().toString()
        ));
        response.getWriter().write(json);
    }
}
