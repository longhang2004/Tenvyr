---
title: Package Verification
status: current
audience:
  - developer
  - release-engineer
last_verified: 2026-07-28
sources:
  - scripts/verify-package-packs.mjs
  - scripts/verify-python-worker-package.py
  - packages/contracts/package.json
  - packages/worker/package.json
  - sdks/python-worker/pyproject.toml
---

# Package verification

Tenvyr's SDK packages are private verification artifacts. Packaging checks prove archive and consumer behavior; they do not authorize publication.

Provider libraries remain application dependencies. The Worker package
verifiers enforce the core dependency boundary; OpenAI, Anthropic, Ollama, and
framework SDKs are not bundled into either Worker runtime.

## TypeScript packages

```bash
pnpm verify:package-packs
```

The verifier builds and packs `@tenvyr/contracts` and `@tenvyr/worker` into an operating-system temporary directory. It then:

- checks exact archive allowlists and package metadata;
- verifies the Worker's packed dependency resolves to the matching Contracts version rather than `workspace:*`;
- compares packed contract schemas byte-for-byte with `contracts/schemas`;
- installs tarballs into a clean external consumer, compiles it, runs the built consumer and real health smoke, and stops the Worker;
- proves legacy package names, removed APIs, and internal deep imports fail while scanning archives for unauthorized legacy identity.

The verifier deletes its temporary directory in a `finally` block. It does not use an editable workspace import as proof of package behavior.

## Python package

```bash
python scripts/verify-python-worker-package.py
```

The Python verifier builds both wheel and sdist with the selected interpreter, enforces explicit member allowlists, rebuilds a wheel from the extracted sdist outside the monorepo, and compares all five packaged schemas byte-for-byte with the canonical contract schemas.

It creates an external virtual environment with an empty `PYTHONPATH`, installs the wheel with its development extra, and verifies:

- root import, exact public API, `py.typed`, and installed resource loading;
- strict mypy use by an external consumer;
- real Worker health/start/stop behavior and the Python example's process lifecycle;
- absence of legacy imports/APIs and unauthorized branding;
- private metadata, the two allowed runtime dependency families, and the absence of a license declaration.

Schema drift is also available as a fast, non-mutating check:

```bash
python scripts/sync-python-worker-schemas.py check
```

## Publication boundary

`@tenvyr/contracts` and `@tenvyr/worker` are marked `private` and `UNLICENSED`. `tenvyr-worker` is classified `Private :: Do Not Upload` and declares no license. npm/PyPI organization and name reservation, domain/repository decisions, legal/trademark review, license selection, and explicit owner release approval remain blockers. Do not run publish commands from this repository.

The v0.1.0 release candidate changes neither boundary: no registry publication is
part of showcase verification, and the missing owner-approved license blocks a
final public package or repository release.
