from __future__ import annotations

import hashlib
import hmac


def create_callback_signature(
    secret: str,
    timestamp: str,
    delivery_id: str,
    raw_body: bytes,
) -> str:
    signed = b".".join(
        (timestamp.encode("utf-8"), delivery_id.encode("utf-8"), raw_body)
    )
    digest = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"v1={digest}"
