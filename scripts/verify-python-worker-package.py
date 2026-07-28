#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import threading
import urllib.request
import zipfile
from collections.abc import Callable, Iterable
from email.parser import BytesParser
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / "sdks" / "python-worker"
PACKAGE = SDK / "src" / "tenvyr_worker"
EXAMPLE = ROOT / "examples" / "python-http-worker" / "src" / "main.py"
DIST_NAME = "tenvyr_worker-0.1.0"

SCHEMAS = (
    "agent-event.v1.schema.json",
    "agent-invocation.v1.schema.json",
    "agent-result.v1.schema.json",
    "http-agent-run-accepted.v1.schema.json",
    "http-agent-run-request.v1.schema.json",
)

PACKAGE_FILES = {
    "tenvyr_worker/__init__.py",
    "tenvyr_worker/py.typed",
    *{f"tenvyr_worker/schema_json/{name}" for name in SCHEMAS},
    *{
        f"tenvyr_worker/{path}"
        for path in (
            "_callback/__init__.py",
            "_callback/delivery.py",
            "_callback/hooks.py",
            "_callback/retry.py",
            "_callback/signer.py",
            "_callback/types.py",
            "_http/__init__.py",
            "_http/auth.py",
            "_http/callback_policy.py",
            "_http/server.py",
            "_protocol/__init__.py",
            "_protocol/json_value.py",
            "_protocol/schemas.py",
            "_protocol/validation.py",
            "_public/__init__.py",
            "_public/agent.py",
            "_public/config.py",
            "_public/context.py",
            "_public/errors.py",
            "_public/types.py",
            "_public/worker.py",
            "_runtime/canonical_json.py",
            "_runtime/execution.py",
            "_runtime/idempotency.py",
            "_runtime/safe_logger.py",
            "_runtime/scheduler.py",
            "_runtime/worker.py",
        )
    },
}

WHEEL_FILES = PACKAGE_FILES | {
    f"{DIST_NAME}.dist-info/METADATA",
    f"{DIST_NAME}.dist-info/RECORD",
    f"{DIST_NAME}.dist-info/WHEEL",
}
SDIST_FILES = {
    f"{DIST_NAME}/.gitignore",
    f"{DIST_NAME}/PKG-INFO",
    f"{DIST_NAME}/pyproject.toml",
    *{f"{DIST_NAME}/src/{path}" for path in PACKAGE_FILES},
}

LEGACY_HEADERS = {
    "X-" + "Agent" + "Weave-Key-Id",
    "X-" + "Agent" + "Weave-Timestamp",
    "X-" + "Agent" + "Weave-Delivery-Id",
    "X-" + "Agent" + "Weave-Signature",
}
TEXT_SUFFIXES = {".json", ".py", ".toml", ".txt", ""}


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="tenvyr-worker-package-") as directory:
        temporary = Path(directory)
        built = temporary / "built"
        build(SDK, built)

        wheel = only(built.glob("*.whl"), "wheel")
        sdist = only(built.glob("*.tar.gz"), "sdist")
        verify_wheel(wheel)
        verify_sdist(sdist)
        rebuild_sdist(sdist, temporary)
        verify_external_install(wheel, temporary)

    print("Python Worker package verification passed")


def build(source: Path, output: Path, *kind: str) -> None:
    output.mkdir(parents=True)
    command = [
        sys.executable,
        "-m",
        "build",
        "--no-isolation",
        "--outdir",
        str(output),
        *kind,
        str(source),
    ]
    run(command, cwd=ROOT)


def verify_wheel(wheel: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        files = {name for name in archive.namelist() if not name.endswith("/")}
        exact(files, WHEEL_FILES, "wheel")
        verify_metadata(archive.read(f"{DIST_NAME}.dist-info/METADATA"), "wheel")
        verify_schema_bytes(
            lambda path: archive.read(path), "tenvyr_worker/schema_json"
        )
        verify_branding({name: archive.read(name) for name in files}, "wheel")


def verify_sdist(sdist: Path) -> None:
    with tarfile.open(sdist, "r:gz") as archive:
        members = {member.name: member for member in archive if member.isfile()}
        exact(set(members), SDIST_FILES, "sdist")
        verify_metadata(read_tar(archive, members[f"{DIST_NAME}/PKG-INFO"]), "sdist")
        verify_schema_bytes(
            lambda path: read_tar(archive, members[path]),
            f"{DIST_NAME}/src/tenvyr_worker/schema_json",
        )
        verify_branding(
            {name: read_tar(archive, member) for name, member in members.items()},
            "sdist",
        )


def rebuild_sdist(sdist: Path, temporary: Path) -> None:
    extracted = temporary / "extracted"
    extracted.mkdir()
    with tarfile.open(sdist, "r:gz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise AssertionError(f"unsafe sdist member: {member.name}")
        if sys.version_info >= (3, 12):
            archive.extractall(extracted, filter="data")
        else:
            archive.extractall(extracted)
    rebuilt = temporary / "rebuilt"
    build(extracted / DIST_NAME, rebuilt, "--wheel")
    verify_wheel(only(rebuilt.glob("*.whl"), "rebuilt wheel"))


def verify_schema_bytes(reader: Callable[[str], bytes], prefix: str) -> None:
    for filename in SCHEMAS:
        packaged = reader(f"{prefix}/{filename}")
        canonical = (ROOT / "contracts" / "schemas" / filename).read_bytes()
        if packaged != canonical:
            raise AssertionError(f"packaged schema differs: {filename}")


def verify_metadata(raw: bytes, archive_name: str) -> None:
    metadata = BytesParser().parsebytes(raw)
    expected = {
        "Name": "tenvyr-worker",
        "Version": "0.1.0",
        "Requires-Python": ">=3.11",
    }
    for field, value in expected.items():
        if metadata.get(field) != value:
            raise AssertionError(
                f"{archive_name} metadata {field} is {metadata.get(field)!r}"
            )
    if "Private :: Do Not Upload" not in metadata.get_all("Classifier", []):
        raise AssertionError(f"{archive_name} metadata is not private")
    if metadata.get("License") or metadata.get("License-Expression"):
        raise AssertionError(f"{archive_name} metadata unexpectedly declares a license")
    runtime_requirements = {
        requirement.replace(" ", "")
        for requirement in metadata.get_all("Requires-Dist", [])
        if "extra==" not in requirement.replace(" ", "")
    }
    if runtime_requirements != {
        "aiohttp<4,>=3.12",
        "jsonschema[format-nongpl]<5,>=4.23",
    }:
        raise AssertionError(
            f"{archive_name} runtime requirements differ: {runtime_requirements}"
        )


def verify_branding(files: dict[str, bytes], archive_name: str) -> None:
    header_path_suffix = "tenvyr_worker/_callback/delivery.py"
    header_counts = dict.fromkeys(LEGACY_HEADERS, 0)
    for path, raw in files.items():
        if Path(path).suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for header in LEGACY_HEADERS:
            if header in text:
                if not path.endswith(header_path_suffix):
                    raise AssertionError(
                        f"legacy header is outside wire module: {path}"
                    )
                header_counts[header] += text.count(header)
                text = text.replace(header, "")
        if re.search("agent" + "weave", text, re.IGNORECASE):
            raise AssertionError(f"legacy branding entered {archive_name}: {path}")
    if set(header_counts.values()) != {1}:
        raise AssertionError(f"{archive_name} does not preserve exactly four headers")


def verify_external_install(wheel: Path, temporary: Path) -> None:
    environment_dir = temporary / "external-venv"
    run(
        [sys.executable, "-m", "venv", str(environment_dir)],
        cwd=temporary,
    )
    python = environment_dir / (
        "Scripts/python.exe" if os.name == "nt" else "bin/python"
    )
    clean_environment = {
        **os.environ,
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PYTHONPATH": "",
    }
    run(
        [str(python), "-m", "pip", "install", f"{wheel}[dev]"],
        cwd=temporary,
        env=clean_environment,
    )

    consumer = temporary / "consumer.py"
    consumer.write_text(EXTERNAL_CHECK, encoding="utf-8")
    run([str(python), str(consumer)], cwd=temporary, env=clean_environment)

    typed_consumer = temporary / "typed_consumer.py"
    typed_consumer.write_text(TYPED_CONSUMER, encoding="utf-8")
    run(
        [str(python), "-m", "mypy", "--strict", str(typed_consumer)],
        cwd=temporary,
        env=clean_environment,
    )
    verify_example(python, clean_environment)


def verify_example(python: Path, environment: dict[str, str]) -> None:
    child = subprocess.Popen(
        [str(python), str(EXAMPLE)],
        cwd=ROOT,
        env={
            **environment,
            "TENVYR_WORKER_TOKEN": "package-example-token",
            "TENVYR_CALLBACK_KEY_ID": "package-v1",
            "TENVYR_CALLBACK_SECRET": "package-example-secret",
            "TENVYR_CALLBACK_ORIGIN": "http://127.0.0.1:1",
            "TENVYR_ALLOW_INSECURE_HTTP": "true",
            "TENVYR_WORKER_HOST": "127.0.0.1",
            "TENVYR_WORKER_PORT": "0",
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        ready_line = wait_for_line(child)
        ready = json.loads(ready_line)
        if ready.get("event") != "tenvyr.worker.ready":
            raise AssertionError(f"unexpected example event: {ready_line}")
        health_url = f"http://{ready['host']}:{ready['port']}/health/live"
        with urllib.request.urlopen(health_url, timeout=2) as response:
            if response.status != 200 or json.load(response) != {"status": "ok"}:
                raise AssertionError("example liveness response is invalid")
        child.send_signal(signal.SIGTERM)
        stdout, stderr = child.communicate(timeout=5)
        stopped = json.loads(stdout.strip())
        if stopped != {"event": "tenvyr.worker.stopped", "executions": 0}:
            raise AssertionError(f"unexpected stop event: {stdout}")
        if child.returncode != 0:
            raise AssertionError(f"example failed: {stderr}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()


def wait_for_line(child: subprocess.Popen[str], timeout: float = 5) -> str:
    if child.stdout is None or child.stderr is None:
        raise AssertionError("example pipes are unavailable")
    lines: queue.Queue[str] = queue.Queue(maxsize=1)
    threading.Thread(
        target=lambda: lines.put(child.stdout.readline()), daemon=True
    ).start()
    try:
        line = lines.get(timeout=timeout)
    except queue.Empty:
        raise AssertionError("timed out waiting for example ready event") from None
    if not line:
        raise AssertionError(f"example exited early: {child.stderr.read()}")
    return line


def exact(actual: set[str], expected: set[str], archive_name: str) -> None:
    if actual == expected:
        return
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    raise AssertionError(
        f"{archive_name} allowlist mismatch; missing={missing}, extra={extra}"
    )


def only(paths: Iterable[Path], label: str) -> Path:
    values = list(paths)
    if len(values) != 1:
        raise AssertionError(f"expected one {label}, found {len(values)}")
    return values[0]


def read_tar(archive: tarfile.TarFile, member: tarfile.TarInfo) -> bytes:
    extracted = archive.extractfile(member)
    if extracted is None:
        raise AssertionError(f"could not read {member.name}")
    return extracted.read()


def run(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> None:
    completed = subprocess.run(command, cwd=cwd, env=env, text=True, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


EXTERNAL_CHECK = textwrap.dedent(
    """
    import asyncio
    import importlib.resources
    import importlib.util
    import json
    import urllib.request

    import tenvyr_worker
    from tenvyr_worker import TenvyrWorkerConfig, create_tenvyr_worker, define_agent
    from tenvyr_worker._protocol.validation import parse_agent_invocation

    EXPECTED = [
        "AgentDefinition", "AgentExecutionContext", "AgentExecutionError",
        "AgentExecutionSuccess", "AgentFailureOptions", "TenvyrWorker",
        "TenvyrWorkerConfig", "WorkerAddress", "WorkerLifecycleState",
        "WorkerLogger", "create_tenvyr_worker", "define_agent",
    ]

    class Parser:
        def parse(self, value: object) -> dict[str, object]:
            if not isinstance(value, dict):
                raise ValueError("input must be an object")
            return value

    async def execute(context, value):
        return context.success(output=value)

    async def main():
        assert tenvyr_worker.__all__ == EXPECTED
        assert importlib.util.find_spec("agent" + "weave_worker") is None
        assert not hasattr(tenvyr_worker, "create_" + "agent" + "weave_worker")
        agent = define_agent(
            name="package-smoke", input_parser=Parser(), execute=execute
        )
        assert agent.input_parser.parse({"ok": True}) == {"ok": True}
        package = importlib.resources.files("tenvyr_worker")
        assert package.joinpath("py.typed").is_file()
        schemas = package.joinpath("schema_json")
        assert len(
            [item for item in schemas.iterdir() if item.name.endswith(".json")]
        ) == 5
        parsed = parse_agent_invocation({
            "schemaVersion": "1",
            "invocationId": "package-smoke:1",
            "executionId": "package-execution",
            "stepExecutionId": "package-step",
            "stepId": "package-agent",
            "target": {"agent": "package-smoke"},
            "input": {"message": "ok"},
            "attempt": 1,
            "createdAt": "2026-07-28T00:00:00.000Z",
            "trace": {
                "traceId": "package-execution",
                "correlationId": "package-smoke:1",
            },
        })
        assert parsed["invocationId"] == "package-smoke:1"
        worker = create_tenvyr_worker(TenvyrWorkerConfig(
            agent=agent,
            bearer_token="package-token",
            callback_keys={"package-v1": "package-secret"},
            allowed_callback_origins=["http://127.0.0.1:1"],
            allow_insecure_http=True,
        ))
        address = await worker.start(port=0)
        def health():
            with urllib.request.urlopen(
                f"http://{address.host}:{address.port}/health/ready", timeout=2
            ) as response:
                return response.status, json.load(response)
        assert await asyncio.to_thread(health) == (200, {"status": "ok"})
        await worker.stop()

    asyncio.run(main())
    """
).strip()

TYPED_CONSUMER = textwrap.dedent(
    """
    from tenvyr_worker import (
        AgentDefinition,
        AgentExecutionContext,
        TenvyrWorker,
        TenvyrWorkerConfig,
        WorkerAddress,
        create_tenvyr_worker,
        define_agent,
    )

    async def execute(
        context: AgentExecutionContext, value: dict[str, object]
    ) -> dict[str, object]:
        context.raise_if_cancelled()
        return value

    def parse_output(value: object) -> dict[str, object]:
        if not isinstance(value, dict):
            raise TypeError("output must be an object")
        return value

    agent: AgentDefinition[dict[str, object], dict[str, object]] = define_agent(
        name="typed-consumer", execute=execute, output_parser=parse_output
    )
    config: TenvyrWorkerConfig[dict[str, object], dict[str, object]] = (
        TenvyrWorkerConfig(
            agent=agent,
            bearer_token="typed-token",
            callback_keys={"typed-v1": "typed-secret"},
            allowed_callback_origins=["https://callbacks.example.test"],
        )
    )
    worker: TenvyrWorker = create_tenvyr_worker(config)

    async def start() -> WorkerAddress:
        return await worker.start(port=0)
    """
).strip()


if __name__ == "__main__":
    main()
