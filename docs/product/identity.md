---
title: Product Identity
status: current
audience:
  - product
  - developer
last_verified: 2026-07-28
sources:
  - package.json
  - packages/contracts/package.json
  - packages/worker/package.json
  - sdks/python-worker/pyproject.toml
  - scripts/verify-product-identity.mjs
---

# Product Identity

The owner-approved private repository identity is **Tenvyr**. The current private
packages are `@tenvyr/contracts`, `@tenvyr/worker`, and the Python distribution
`tenvyr-worker`; the repository root is also private. This local identity decision
does not establish ownership of an npm scope, PyPI name, domain, remote repository,
or container namespace.

The owner selected the MIT License for the repository and its package artifacts.
Registry publication remains blocked by name reservation, trademark/legal
review, repository and redirect work, and explicit publication approval. The
Python package additionally declares `Private :: Do Not Upload`.

The v0.1.0 source release is authorized because the license is recorded and the
exact merged `main` commit passed the release workflow. Its source tag does not
authorize npm or PyPI publication; those packages remain private and
unpublished.

Protocol and deployment compatibility remain intentionally separate from product
branding. Protocol v1 still uses the four exact `X-AgentWeave-*` HMAC headers;
Kafka identifiers, the PostgreSQL database identity, Compose resources, and the
Java namespace `com.agentweave` also remain unchanged pending separately approved
migrations.

Historical evidence is preserved in the dated
[identity evaluation](../archive/decisions/2026-07-27-product-identity-evaluation.md)
and [rename migration record](../archive/migrations/2026-07-28-agentweave-to-tenvyr.md).
The machine inventory is [maintained separately](../reference/product-name-inventory.json).
