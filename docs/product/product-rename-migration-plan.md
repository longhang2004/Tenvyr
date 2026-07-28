# Tenvyr Product Rename Migration Status

## Status and scope

- Target identity: **Tenvyr**.
- Local repository migration: **implemented**.
- Decision status: **Owner-approved for repository implementation**.
- Private local Python Worker SDK: **implemented with separate owner authorization**.
- External reservations, public license, legal clearance, repository rename,
  and publication: **owner action required**.
- Local package manifests were intentionally renamed to the Tenvyr identity;
  no external package-registry publication, image-registry, domain, or remote
  repository mutation was performed.
- No ADR was added because this repository has no ADR convention.

This status report records the hard rename of public identity while preserving
compatibility-sensitive wire and deployment identifiers. It is not
authorization to publish packages or images, rename the remote repository,
reserve identities, or publish the Python SDK.

## Canonical target identity

| Surface                       | Target                                      | Status                |
| ----------------------------- | ------------------------------------------- | --------------------- |
| Product                       | `Tenvyr`                                    | Implemented           |
| Repository slug               | `tenvyr`                                    | Owner action required |
| npm scope                     | `@tenvyr`                                   | Implemented locally   |
| TypeScript contracts package  | `@tenvyr/contracts`                         | Implemented locally   |
| TypeScript Worker package     | `@tenvyr/worker`                            | Implemented locally   |
| Python distribution           | `tenvyr-worker`                             | Implemented privately |
| Python import                 | `tenvyr_worker`                             | Implemented locally   |
| Future TypeScript packages    | `@tenvyr/cli`, `@tenvyr/otel`               | Not implemented       |
| Public Worker factory         | `createTenvyrWorker`                        | Implemented           |
| Public Worker interface       | `TenvyrWorker`                              | Implemented           |
| Public Worker configuration   | `TenvyrWorkerConfig`                        | Implemented           |
| Internal Worker runtime       | `TenvyrWorkerRuntime`                       | Implemented           |
| Environment prefix            | `TENVYR_`                                   | Implemented           |
| Telemetry namespace           | `tenvyr.*`                                  | Reserved for future   |
| Container registry pattern    | `ghcr.io/<approved-org>/tenvyr-*`           | Owner action required |
| Preferred domain proposal     | `tenvyr.dev` (unreserved)                   | Owner action required |
| Future protocol header prefix | `X-Tenvyr-*`, reserved for protocol v2 only | Not implemented       |

Registry absence is not proof of availability, ownership, reservability, or
legal clearance. `<approved-org>` and every external identity remain
owner-controlled decisions.

## Migration order and status

### 1. Owner approval — implemented

The owner approved Tenvyr for local repository implementation. That approval
does not include external reservation, publication, or public release.

### 2. Reserve identity — owner action required

The owner must confirm and reserve, as applicable, the `@tenvyr` npm scope,
`tenvyr-worker` PyPI distribution, GitHub organization/repository identity,
preferred domain or approved fallback, and GHCR organization. No reservation
or control is inferred from a 404, an empty search result, or the screening
evidence in the identity decision.

### 3. Select public license — owner action required

The packages remain `private: true` and `UNLICENSED`. The owner must select a
license before any public release. Local package manifests intentionally have
no `repository` or `publishConfig` fields until an external repository and
release policy are approved.

### 4. Rename branch — implemented locally

The rename was implemented on the existing owner-approved local branch without
renaming the repository directory or Git remote. The pre-rename inventory is
retained as a legacy migration ledger; its locations are audited touchpoints,
not claims that an old value remains active.

### 5. Branding — implemented

Active README, package documentation, architecture/product/roadmap/developer
documentation, frontend metadata and copy, service descriptions, controller
health text, comments, logs, and test descriptions use Tenvyr.

Historical references remain only where needed to explain the former internal
name, the independent public AgentWeave project, dated Worker design records,
or this rename audit. AgentWeave is not an active alias.

### 6. Packages, imports, API, and schemas — implemented

The coordinated hard rename changed:

- root package `agentweave` to `tenvyr`;
- private packages to `@tenvyr/contracts` and `@tenvyr/worker`;
- the example to `@tenvyr/example-typescript-http-worker`;
- Worker symbols to `createTenvyrWorker`, `TenvyrWorker`,
  `TenvyrWorkerConfig`, and internal `TenvyrWorkerRuntime`; and
- package filters, workspace dependencies, imports, tests, documentation,
  Docker build filters, pack verification, and the pnpm lockfile.

No old package or API alias, deprecation shim, or compatibility dependency was
added. The public Worker root exposes only the approved runtime and type-only
surface; the internal runtime is not exported.

The five private v1 schemas now use:

- `urn:tenvyr:schema:agent-invocation:v1`;
- `urn:tenvyr:schema:agent-result:v1`;
- `urn:tenvyr:schema:agent-event:v1`;
- `urn:tenvyr:schema:http-agent-run-request:v1`; and
- `urn:tenvyr:schema:http-agent-run-accepted:v1`.

The HTTP request schema's external reference is
`urn:tenvyr:schema:agent-invocation:v1`. The old
`https://agentweave.dev/contracts/...` identities were removed without
changing payload fields, local references, validation behavior, or
`schemaVersion` values.

### 7. Configuration and runtime metadata — implemented

The eight documentation/example environment keys use `TENVYR_*`. Worker core
still accepts typed configuration and does not load environment variables, so
no fallback, compatibility layer, warning, or secret logging was added.
Existing deployments must map their configuration during rollout.

User-Agent values are `Tenvyr-Worker/1.0.0` and
`Tenvyr-Orchestrator/1.0.0`.

The following identities are **preserved for compatibility**:

- the exact four `X-AgentWeave-*` HMAC headers in protocol v1;
- all Kafka v1 task/result/analytics topics, consumer groups, retained client
  IDs, message keys, offsets, and serialization;
- PostgreSQL database/default `agentweave`, schemas, tables, and data;
- Java namespace and source tree `com.agentweave`; and
- Compose service keys, `agentweave-*` container names, `agentweave-net`,
  `postgres_data`, and `redis_data`.

There is no dual-send, dual-publish, dual-subscribe, silent header alias,
database migration, Java namespace migration, Docker recreation, or volume
deletion. A future protocol, Kafka, Java namespace, or deployment-identity
migration requires a separate owner-approved plan. Never use
`docker compose down -v` for a branding change.

### 8. Verification — implemented locally

The repository identity guard classifies every remaining legacy identifier as
wire protocol v1, Kafka runtime v1, persistent deployment, historical,
compatibility test, or identity inventory. It fails on an unclassified active
old package, API, environment, User-Agent, branding, schema-domain, or
repository-metadata reference.

The rename verification covers contracts schema identity, Worker public API
and callback behavior, Orchestrator HTTP/Kafka compatibility, example smoke,
Java compatibility, Compose configuration, formatting, whitespace, and
package packing.

### 9. Repository rename — owner action required

After external identity reservation, the owner may rename or create
`<approved-org>/tenvyr`, then:

- update the local remote and any package repository metadata;
- verify redirects, fresh clone, branches, pull requests, issues, releases,
  branch protection, security/support links, and docs URLs;
- update CI secrets/environments, badges, issue/PR templates, npm provenance,
  trusted publishers, GHCR permissions, and image references; and
- document required old-to-new URL redirects.

No repository URL should be added to package metadata before the target exists
and is owner-controlled.

### 10. External pack and install — implemented locally; publish owner action required

The package verifier builds and packs the two private `@tenvyr/*` packages,
checks their exact manifests and tarball allowlists, installs them into an
external temporary consumer, compiles and runs `createTenvyrWorker`, exercises
`/health/live`, and shuts the Worker down within a timeout.

It rejects deep imports, the old Worker API from `@tenvyr/worker`, and
resolution of `@agentweave/worker`. Packed artifacts reject the old
scope/API/User-Agent while allowing the protocol v1 HMAC strings. A successful
pack/install check is not permission to publish.

### 11. Python Worker SDK — implemented privately; publish blocked

The owner separately authorized the local private implementation. Distribution
`tenvyr-worker`, import `tenvyr_worker`, the framework-free example, package
verifier, 52 shared conformance cases, and explicit Orchestrator loopback are
implemented without publication. `Private :: Do Not Upload`, absent license
metadata, and the remaining registry/legal/repository gates continue to block
PyPI and every public release.

## Compatibility and data-safety record

| Identifier                                                                          | Action                                                                                                    | Reason                                                                                                                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Root and three private TypeScript package names                                     | Renamed to `tenvyr`, `@tenvyr/contracts`, `@tenvyr/worker`, and `@tenvyr/example-typescript-http-worker`  | The packages are private and unpublished, so the repository uses one final identity without aliases or deprecation shims.                      |
| Branded public Worker API and internal runtime                                      | Renamed to `createTenvyrWorker`, `TenvyrWorker`, `TenvyrWorkerConfig`, and internal `TenvyrWorkerRuntime` | The branded TypeScript API was hard-renamed before public release; behavior and generics remain unchanged.                                     |
| Worker and Orchestrator User-Agent values                                           | Renamed to `Tenvyr-Worker/1.0.0` and `Tenvyr-Orchestrator/1.0.0`                                          | User-Agent values are runtime product metadata, not protocol-v1 authentication identifiers.                                                    |
| Four protocol-v1 HMAC headers listed in section 7                                   | Preserved for protocol v1                                                                                 | The four byte-exact names are part of the signed HMAC wire contract. No new-prefix alias is sent or accepted.                                  |
| Kafka v1 task, result, analytics, and lifecycle topics listed in section 7          | Preserved for Kafka runtime v1                                                                            | Topic identity, message routing, and retained lifecycle/analytics compatibility must remain byte-for-byte unchanged; there is no dual-publish. |
| Four Kafka v1 consumer groups locked by compatibility tests                         | Preserved for Kafka runtime v1                                                                            | Renaming consumer groups would create new offsets and change delivery behavior.                                                                |
| Two retained Kafka client IDs locked by compatibility tests                         | Preserved for Kafka runtime v1                                                                            | Client IDs are operational compatibility identifiers, not active product branding.                                                             |
| PostgreSQL database/default, existing schemas, tables, and data listed in section 7 | Preserved as persistent deployment identity                                                               | The product rename does not include a database or schema migration.                                                                            |
| Eleven explicit Compose container names locked by compatibility tests               | Preserved as persistent deployment identity                                                               | Reusing the established container names avoids stack recreation and is explicitly outside the branding rename.                                 |
| Explicit Compose network and the `postgres_data` and `redis_data` volumes           | Preserved as persistent deployment identity                                                               | Network and volume identity remains stable; no stack teardown, volume deletion, or data operation was performed.                               |
| Maven group, Java package declarations, and Java source tree listed in section 7    | Preserved as persistent deployment identity                                                               | A Java namespace change requires an owner-controlled reverse-DNS namespace and a separate coordinated source migration.                        |

Deployment configuration uses the new documented/example `TENVYR_*` names
directly. Operators control secret and configuration mapping during rollout.

- The user-owned untracked `AgentWeave.zip` and `scripts/compress.sh` artifacts
  were excluded from the rename and were not modified.

## Remaining release gates

Public release remains blocked on owner-controlled reservation, counsel-led
trademark review, license selection, repository/redirect work, and explicit
publication approval. Packages remain private and no GitHub, npm, PyPI,
domain, GHCR, CI secret, issue-template, badge, provenance, or redirect
mutation has been performed.
