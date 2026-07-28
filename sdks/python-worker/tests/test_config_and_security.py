from __future__ import annotations

import dataclasses
import math
from collections.abc import Mapping

import pytest

from tenvyr_worker import TenvyrWorkerConfig, define_agent
from tenvyr_worker._http.auth import authenticate_bearer
from tenvyr_worker._http.callback_policy import validate_callback_url


def _execute(context: object, value: object) -> object:
    return value


AGENT = define_agent(name="echo-agent", execute=_execute)


def _valid(**overrides: object) -> TenvyrWorkerConfig[object, object]:
    values: dict[str, object] = {
        "agent": AGENT,
        "bearer_token": "worker-token",
        "callback_keys": {"callback-v1": "callback-secret"},
        "allowed_callback_origins": ("https://orchestrator.example",),
    }
    values.update(overrides)
    return TenvyrWorkerConfig(**values)  # type: ignore[arg-type]


def test_config_applies_documented_seconds_defaults() -> None:
    config = _valid()
    assert config.callback_max_response_bytes == 64 * 1024
    assert config.execution_timeout_seconds == 15 * 60
    assert config.execution_concurrency == 4
    assert config.max_queued_runs == 100
    assert config.idempotency_ttl_seconds == 24 * 60 * 60
    assert config.idempotency_max_entries == 10_000
    assert config.callback_max_attempts == 8
    assert config.callback_initial_delay_seconds == 0.5
    assert config.callback_max_delay_seconds == 30
    assert config.callback_jitter_ratio == 0.2
    assert config.callback_request_timeout_seconds == 10
    assert config.max_request_bytes == 1024 * 1024
    assert config.shutdown_grace_seconds == 30


@pytest.mark.parametrize(
    "overrides",
    (
        {"bearer_token": ""},
        {"bearer_token": "   "},
        {"callback_keys": {}},
        {"callback_keys": {"": "secret"}},
        {"callback_keys": {"key": ""}},
        {"allowed_callback_origins": ()},
        {"allowed_callback_origins": ("not a URL",)},
        {"allowed_callback_origins": ("https://user@example.test",)},
        {"allowed_callback_origins": ("https://example.test/path",)},
        {"allowed_callback_origins": ("https://example.test?query",)},
        {"allowed_callback_origins": ("https://example.test#fragment",)},
        {"allowed_callback_origins": ("http://127.0.0.1:3000",)},
        {"execution_timeout_seconds": 0},
        {"execution_timeout_seconds": math.nan},
        {"execution_timeout_seconds": True},
        {"execution_concurrency": 0},
        {"execution_concurrency": 1.5},
        {"execution_concurrency": True},
        {"max_queued_runs": -1},
        {"max_queued_runs": 1.5},
        {"max_queued_runs": False},
        {"idempotency_ttl_seconds": 0},
        {"idempotency_max_entries": 0},
        {"callback_max_attempts": 0},
        {"callback_initial_delay_seconds": 0},
        {"callback_initial_delay_seconds": 31},
        {"callback_max_delay_seconds": 0},
        {"callback_jitter_ratio": -0.1},
        {"callback_jitter_ratio": 1.1},
        {"callback_jitter_ratio": math.inf},
        {"callback_jitter_ratio": True},
        {"callback_request_timeout_seconds": 0},
        {"callback_max_response_bytes": 0},
        {"callback_max_response_bytes": True},
        {"max_request_bytes": 0},
        {"shutdown_grace_seconds": 0},
        {"allow_insecure_http": 1},
        {"logger": object()},
        {"on_callback_delivery_failed": object()},
    ),
)
def test_config_rejects_invalid_values(overrides: dict[str, object]) -> None:
    with pytest.raises(
        (TypeError, ValueError), match="Invalid Tenvyr Worker configuration"
    ):
        _valid(**overrides)


def test_config_allows_zero_queue_boundary_jitter_and_explicit_http() -> None:
    config = _valid(
        max_queued_runs=0,
        callback_jitter_ratio=1,
        allow_insecure_http=True,
        allowed_callback_origins=("http://LOCALHOST:80/",),
    )
    assert config.max_queued_runs == 0
    assert config.callback_jitter_ratio == 1
    assert config.allowed_callback_origins == ("http://localhost",)
    assert config._normalized_callback_origins == (("http", "localhost", 80),)


def test_config_is_frozen_snapshots_inputs_and_hides_secrets_from_repr() -> None:
    keys = {"callback-v1": "TOP_SECRET_CALLBACK"}
    origins = ["https://orchestrator.example"]
    config = _valid(
        bearer_token="TOP_SECRET_BEARER",
        callback_keys=keys,
        allowed_callback_origins=origins,
    )
    keys["callback-v2"] = "later"
    origins.append("https://later.example")

    assert dict(config.callback_keys) == {"callback-v1": "TOP_SECRET_CALLBACK"}
    assert config.allowed_callback_origins == ("https://orchestrator.example",)
    with pytest.raises(TypeError):
        config.callback_keys["later"] = "no"  # type: ignore[index]
    with pytest.raises(dataclasses.FrozenInstanceError):
        config.execution_concurrency = 8  # type: ignore[misc]
    rendered = repr(config)
    assert "TOP_SECRET_BEARER" not in rendered
    assert "TOP_SECRET_CALLBACK" not in rendered
    assert "callback-v1" not in rendered


def test_config_errors_never_include_secret_values() -> None:
    with pytest.raises(ValueError) as caught:
        _valid(
            bearer_token="TOP_SECRET_BEARER",
            callback_keys={"": "TOP_SECRET_CALLBACK"},
        )
    assert "TOP_SECRET_BEARER" not in str(caught.value)
    assert "TOP_SECRET_CALLBACK" not in str(caught.value)


class _ValidLogger:
    def debug(self, message: str, context: Mapping[str, object] | None = None) -> None:
        pass

    def info(self, message: str, context: Mapping[str, object] | None = None) -> None:
        pass

    def warning(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None:
        pass

    def error(self, message: str, context: Mapping[str, object] | None = None) -> None:
        pass


def test_logger_uses_python_warning_spelling_without_warn_alias() -> None:
    config = _valid(logger=_ValidLogger())
    assert config.logger is not None
    assert hasattr(config.logger, "warning")
    assert not hasattr(config.logger, "warn")


@pytest.mark.parametrize(
    "authorization",
    ("Bearer worker-token", "bearer worker-token", "BEARER worker-token"),
)
def test_bearer_accepts_case_insensitive_scheme(authorization: str) -> None:
    assert authenticate_bearer(authorization, "worker-token") is True


@pytest.mark.parametrize(
    "authorization",
    (
        None,
        "",
        "Basic worker-token",
        "Bearer",
        "Bearer ",
        "Bearer  worker-token",
        "Bearer worker-token ",
        "Bearer wrong-token",
    ),
)
def test_bearer_rejects_missing_malformed_or_wrong_tokens(
    authorization: str | None,
) -> None:
    assert authenticate_bearer(authorization, "worker-token") is False


def test_callback_policy_allows_paths_on_exact_normalized_origin() -> None:
    config = _valid(
        allowed_callback_origins=(
            "https://ORCHESTRATOR.example:443/",
            "https://orchestrator.example:8443",
        )
    )
    assert (
        validate_callback_url(
            "https://orchestrator.example/internal/callback",
            config._normalized_callback_origins,
            allow_insecure_http=False,
        )
        == "https://orchestrator.example/internal/callback"
    )


@pytest.mark.parametrize(
    "url",
    (
        "https://orchestrator.example.attacker.test/callback",
        "https://user:pass@orchestrator.example/callback",
        "https://orchestrator.example/callback?token=secret",
        "https://orchestrator.example/callback#fragment",
        "http://orchestrator.example/callback",
        "https://orchestrator.example:9443/callback",
        "ftp://orchestrator.example/callback",
    ),
)
def test_callback_policy_rejects_exact_origin_attacks(url: str) -> None:
    config = _valid()
    with pytest.raises(ValueError):
        validate_callback_url(
            url,
            config._normalized_callback_origins,
            allow_insecure_http=False,
        )
