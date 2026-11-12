---
title: "T03 — Implement sessions, CSRF, durable actors and visibility rules"
status: planned
audience:
  - developer
last_verified: 2026-11-11
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# T03: Implement sessions, CSRF, durable actors and visibility rules

Dependencies: T02. Estimate: 4–6 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: planned, not implemented.

## Deliverable and files

Implement review-api `ReviewSecurityConfiguration.java`,
`security/ActorResolver.java`, `security/BootstrapUsers.java`,
`AuthController.java`; add `ReviewSecurityTest`, `ReviewSecurityIT`,
`BootstrapUsersIT`. Add the explicit bootstrap option/configuration to the
review app. Keep business schema/DTO definitions from T02 unchanged unless a
reviewed correction is required.

## Interfaces

Consumes `ReviewTypes.Actor/Role` and tenvyr_review.users. Produces:
```java
Actor ActorResolver.current(org.springframework.security.core.Authentication authentication)
GET /api/v1/auth/csrf // {headerName,parameterName,token}, no-store
GET /api/v1/me        // {id,username,role}
POST /login          // standard form + CSRF, 204 / 401 JSON
POST /logout         // CSRF, invalidate, 204
```

Bootstrap input is an explicit local file of user entries
`{username,password,role}`; UUIDs are generated and persisted once. The app
loads it only when `review.bootstrap-users-file` is supplied. Existing user
records are never silently updated. No committed credentials or public signup.

## References to copy

Read official form-login/CSRF/JDBC authentication sources in DISCOVERY, then
copy Spring Security's standard form login and custom JdbcUserDetailsManager
queries for the PostgreSQL schema. Use PasswordEncoderFactories'
DelegatingPasswordEncoder; do not copy H2 varchar_ignorecase DDL.

## Steps and acceptance

- [ ] Add failing tests for anonymous 401 JSON, invalid credentials, disabled
  users, absent CSRF on login/logout/mutations, and new token after login.
- [ ] Implement stable Actor lookup by authenticated username and enabled user
  record; principal/body/query cannot substitute an owner UUID or role. Map
  stored SUBMITTER/REVIEWER to Spring ROLE_ authorities.
- [ ] Keep standard session fixation/logout mechanics. Configure API entry
  point/access-denied handlers with safe `{code,message,requestId}` errors.
  Callback exemption stays exact; all other unsafe endpoints retain CSRF.
- [ ] Implement explicit bootstrap with bcrypt hashes and strict manifest
  validation: missing values, duplicate usernames, unsupported roles and
  uppercase/invalid usernames fail. Never log password/hash/file contents.
  Existing users produce a clear conflict, not a reset or duplicate UUID.
- [ ] Test visibility policy using a minimal protected fixture route/service
  until T04 supplies actual requests. SUBMITTER A cannot impersonate B;
  REVIEWER has read scope but cannot submit. T04/T06 must repeat these checks
  against real repositories rather than treating matcher tests as sufficient.
- [ ] Run review unit/integration plus verifiers; document session restart
  re-login, cookie local-vs-HTTPS configuration and bootstrap use. Handoff.

Representative assertions:
```java
assertEquals(403, loginWithoutCsrf().statusCode());
assertEquals(204, loginWithValidCsrf().statusCode());
assertEquals(persistedUserUuid, actorResolver.current(authentication).id());
```

## Reject conditions

No custom JSON authentication controller, Basic fallback, JWT issuer, global
CSRF disable, wildcard CORS, hardcoded demo password, public user-management
API, or logging source/credentials. A successful login is not proof that
business object authorization works; that is explicitly retested in T04/T06.
