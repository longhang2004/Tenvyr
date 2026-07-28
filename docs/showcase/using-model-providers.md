---
title: Using Model Providers
status: current
audience:
  - developer
  - operator
last_verified: 2026-07-28
sources:
  - services/agent-runner/src/main/java
  - services/agent-runner/src/test/java
  - sdks/python-worker/src/tenvyr_worker
---

# Using model providers

Tenvyr's control plane is provider-neutral. Provider calls belong in the Java
Runner or Worker application, after `AgentInvocationV1` arrives and before the
application returns `AgentResultV1`.

## Pattern A: existing Java Agent Runner

Run these commands from `services/agent-runner`. Real-provider mode derives
`fail` when `LLM_FAILURE_MODE` is unset, so missing credentials or provider
errors are visible.

```bash
LLM_PROVIDER=mock LLM_FAILURE_MODE=mock mvn spring-boot:run
```

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY='<your-key>'
export OPENAI_MODEL='<model-id-available-to-your-account>'
unset LLM_FAILURE_MODE
mvn spring-boot:run
```

```bash
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY='<your-key>'
export ANTHROPIC_MODEL='<model-id-available-to-your-account>'
unset LLM_FAILURE_MODE
mvn spring-boot:run
```

```bash
export LLM_PROVIDER=ollama
export OLLAMA_API_URL='http://localhost:11434'
export OLLAMA_MODEL='<model-id-available-to-your-account>'
unset LLM_FAILURE_MODE
mvn spring-boot:run
```

For the Compose stack, export the same variables before `pnpm showcase:up`.
The command ignores a provider value that Compose only auto-loads from `.env`;
`LLM_PROVIDER` must exist in the invoking shell to opt into a real call. Keys
are never required for the default mock showcase and must not be committed.
Export `LLM_FAILURE_MODE=mock` with a real provider only when an explicitly
labeled, deterministic fallback is desired.

Runner results include `provider`, `model`, `fallbackUsed`, and
`usageSource=estimated`. The current token counts are estimates, not
provider-reported billing data. Tests use mocked HTTP responses; CI does not
call live provider APIs.

## Pattern B: provider inside a Worker

Any provider SDK can be called inside a Python or TypeScript Worker. Install it
as an application dependency, not as a dependency of `tenvyr-worker` or
`@tenvyr/worker`.

Minimal OpenAI Responses handler:

```python
from openai import OpenAI

client = OpenAI()


async def execute(context, value):
    context.raise_if_cancelled()
    response = client.responses.create(
        model="<model-id-available-to-your-account>",
        input=str(value),
    )
    return context.success(
        output={
            "text": response.output_text,
            "_tenvyr": {"provider": "openai", "model": response.model},
        }
    )
```

Minimal Anthropic Messages handler:

```python
from anthropic import Anthropic

client = Anthropic()


async def execute(context, value):
    context.raise_if_cancelled()
    message = client.messages.create(
        model="<model-id-available-to-your-account>",
        max_tokens=512,
        messages=[{"role": "user", "content": str(value)}],
    )
    return context.success(
        output={
            "text": message.content[0].text,
            "_tenvyr": {"provider": "anthropic", "model": message.model},
        }
    )
```

These snippets show only the provider call. Register the handler with
`define_agent` and configure the Worker as described in the
[Python Worker guide](../architecture/workers/python-worker-sdk.md). In a real
application, avoid blocking the event loop by using an async client or a thread
boundary for synchronous SDK calls.

Gemini, Azure OpenAI, Bedrock, Vertex AI, vLLM, LM Studio, OpenRouter, and
OpenAI-compatible endpoints follow the same application pattern. They are not
first-class automated v0.1.0 integrations; authentication, error mapping,
cancellation, and metadata remain the application's responsibility.
