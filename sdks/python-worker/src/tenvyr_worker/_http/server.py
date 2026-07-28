"""Small aiohttp helpers shared by the Worker HTTP boundary."""

from __future__ import annotations

import re
from collections.abc import Mapping

from aiohttp import web

_JSON_CONTENT_TYPE = re.compile(r"application/json(?:\s*;.*)?\Z", re.IGNORECASE)


class RequestBodyTooLarge(ValueError):
    pass


def is_json_content_type(value: str | None) -> bool:
    return isinstance(value, str) and _JSON_CONTENT_TYPE.fullmatch(value) is not None


async def read_request_body(request: web.Request, limit: int) -> bytes:
    content_length = request.content_length
    if content_length is not None and content_length > limit:
        raise RequestBodyTooLarge

    chunks: list[bytes] = []
    size = 0
    async for chunk in request.content.iter_chunked(min(64 * 1024, limit + 1)):
        size += len(chunk)
        if size > limit:
            raise RequestBodyTooLarge
        chunks.append(chunk)
    return b"".join(chunks)


def json_response(status: int, value: object) -> web.Response:
    return web.json_response(value, status=status, dumps=_compact_json)


def error_response(
    status: int,
    code: str,
    message: str,
    *,
    headers: Mapping[str, str] | None = None,
) -> web.Response:
    response = json_response(status, {"error": {"code": code, "message": message}})
    if headers is not None:
        response.headers.update(headers)
    return response


def _compact_json(value: object) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
