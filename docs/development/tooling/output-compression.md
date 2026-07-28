---
title: Output Compression
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
  - scripts/rtk-compress.sh
  - scripts/test-rtk-compress.sh
---

# Output compression

RTK is optional external developer tooling for reducing repetitive command output before an agent consumes it. It is not a Tenvyr runtime dependency, and this repository has not established a general percentage-reduction guarantee.

The helper accepts a command and its arguments:

```bash
./scripts/rtk-compress.sh git diff
```

It also accepts piped input when invoked without a command:

```bash
pnpm test 2>&1 | ./scripts/rtk-compress.sh
```

## Behavior

When an `rtk` executable is present on `PATH`, command mode delegates with `exec rtk "$@"`. RTK's own installation and behavior are external to this repository. Piped-input mode remains local and deterministic whether or not RTK is installed.

When RTK is absent, the dependency-free fallback:

- passes the command and every argument directly, without `eval` or shell re-parsing;
- captures combined standard output and standard error in permission-restricted temporary files;
- removes adjacent duplicate lines and common download-progress noise;
- keeps the first and last 100 lines when filtered output exceeds 200 lines; and
- returns the wrapped command's exact exit status after printing the filtered output.

The file-backed path supports multiline and large output without environment-size coupling. Temporary files are removed on normal exit and common termination signals. Compression is intended for interactive readability; acceptance gates that require complete diagnostics should still run directly.

Run the offline regression check with:

```bash
./scripts/test-rtk-compress.sh
```
