# Python HTTP Worker Example

This framework-free `echo-analyzer` demonstrates a typed parser, an async handler,
structured success, explicit failure, cooperative cancellation checks, and
application-owned SIGINT/SIGTERM handling. It requires no model credentials or
internet access.

```bash
python3.13 -m venv .venv
.venv/bin/pip install -e 'sdks/python-worker[dev]'
cp examples/python-http-worker/.env.example examples/python-http-worker/.env
set -a && source examples/python-http-worker/.env && set +a
.venv/bin/python examples/python-http-worker/src/main.py
```

The process writes flushed NDJSON lifecycle events to stdout. The Worker exposes
`POST /v1/runs`, `/health/live`, and `/health/ready`. Production deployments should
use HTTPS at the ingress, inject secrets through a secret manager, and send SIGTERM
for graceful shutdown.
