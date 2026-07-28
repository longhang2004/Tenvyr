# Python Worker Conformance

The Python SDK consumes the canonical repository fixtures directly during
tests; fixtures are not copied into the wheel or sdist.

| Fixture area               | Valid | Invalid/other |  Total |
| -------------------------- | ----: | ------------: | -----: |
| Run requests               |     2 |             4 |      6 |
| Run acceptances            |     1 |             3 |      4 |
| Agent results              |     4 |             3 |      7 |
| HMAC signature vectors     |     8 |             0 |      8 |
| Callback HTTP status cases |    15 |             0 |     15 |
| Retry classification cases |    12 |             0 |     12 |
| Retry-After cases          |     5 |             8 |     13 |
| JSON number documents      |     3 |             5 |      8 |
| **Total**                  |       |               | **73** |

The conformance tests also prove five packaged schemas are byte-identical to
the canonical files, all schema URNs resolve from an offline registry, format
checking is enabled, non-finite JSON is rejected, issue paths remain readable
for special keys, validators do not mutate inputs, and integral values outside
the JavaScript safe-integer range are rejected before fingerprinting or callback
serialization.

Additional Python-only tests cover the exact root API, frozen and secret-safe
configuration, bearer and origin policy, FIFO scheduling, process-local
idempotency, execution/cancellation, callback retry/signing, lifecycle and
resource ownership, package archives, and an explicit real cross-language
loopback.

The dedicated loopback is intentionally excluded from normal Orchestrator
Jest discovery. Run it with an installed wheel interpreter:

```bash
TENVYR_PYTHON_EXECUTABLE=/path/to/venv/bin/python \
  pnpm --filter orchestrator test:python-worker-loopback
```

The command fails if `TENVYR_PYTHON_EXECUTABLE` is absent. A passing local
Python 3.13 run does not claim the 3.11–3.14 matrix; those versions are reported
only by CI jobs that actually execute them.
