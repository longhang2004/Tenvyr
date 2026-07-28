from __future__ import annotations

import hmac
import re

_BEARER = re.compile(r"Bearer ([^\s]+)", re.IGNORECASE)


def authenticate_bearer(authorization: str | None, expected_token: str) -> bool:
    if not isinstance(authorization, str):
        return False
    match = _BEARER.fullmatch(authorization)
    if match is None:
        return False
    return hmac.compare_digest(
        match.group(1).encode("utf-8"), expected_token.encode("utf-8")
    )
