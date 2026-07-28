# TypeScript HTTP Worker Example

This runnable `echo-analyzer` shows a framework-free Tenvyr Worker with a custom input
parser, output parser, explicit success/failure, cooperative `AbortSignal`, and process-owned
signal handling. It does not require model credentials or internet access.

```bash
cp examples/typescript-http-worker/.env.example examples/typescript-http-worker/.env
pnpm --filter @tenvyr/example-typescript-http-worker build
set -a && source examples/typescript-http-worker/.env && set +a
node examples/typescript-http-worker/dist/index.js
```

The Worker exposes `POST /v1/runs`, `/health/live`, and `/health/ready` on port `8080`.
Production deployments should use HTTPS at the ingress, inject secrets through the platform
secret manager, keep `TENVYR_ALLOW_INSECURE_HTTP=false`, and send SIGTERM for graceful
shutdown.
