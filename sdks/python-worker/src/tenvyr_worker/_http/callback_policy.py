from __future__ import annotations

from collections.abc import Collection
from typing import TypeAlias, cast
from urllib.parse import SplitResult, urlsplit

NormalizedOrigin: TypeAlias = tuple[str, str, int]


def normalize_callback_origin(
    value: object, allow_insecure_http: bool
) -> NormalizedOrigin:
    parsed = _parse_url(value, allow_insecure_http)
    if parsed.path not in ("", "/"):
        raise ValueError("callback origin must not contain a path, query, or fragment")
    return _origin(parsed)


def validate_callback_url(
    value: object,
    allowed_origins: Collection[NormalizedOrigin],
    *,
    allow_insecure_http: bool,
) -> str:
    parsed = _parse_url(value, allow_insecure_http)
    if _origin(parsed) not in allowed_origins:
        raise ValueError("callback URL origin is not allowed")
    return cast(str, value)


def canonical_origin(origin: NormalizedOrigin) -> str:
    scheme, hostname, port = origin
    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    default_port = 443 if scheme == "https" else 80
    suffix = "" if port == default_port else f":{port}"
    return f"{scheme}://{rendered_host}{suffix}"


def _parse_url(value: object, allow_insecure_http: bool) -> SplitResult:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("callback URL must be a valid absolute URL")
    if any(ord(character) <= 32 or ord(character) == 127 for character in value):
        raise ValueError("callback URL must be a valid absolute URL")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        raise ValueError("callback URL must be a valid absolute URL") from None
    if not parsed.scheme or not parsed.netloc or hostname is None:
        raise ValueError("callback URL must be a valid absolute URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("callback URL must not contain credentials")
    if "?" in value.split("#", 1)[0]:
        raise ValueError("callback URL must not contain a query")
    if "#" in value:
        raise ValueError("callback URL must not contain a fragment")
    scheme = parsed.scheme.lower()
    if scheme != "https" and not (scheme == "http" and allow_insecure_http):
        raise ValueError(
            "callback URL requires HTTPS unless insecure HTTP is explicitly allowed"
        )
    if port is None and parsed.netloc.endswith(":"):
        raise ValueError("callback URL must be a valid absolute URL")
    return parsed


def _origin(parsed: SplitResult) -> NormalizedOrigin:
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname
    assert hostname is not None
    return scheme, hostname.lower(), parsed.port or (443 if scheme == "https" else 80)
