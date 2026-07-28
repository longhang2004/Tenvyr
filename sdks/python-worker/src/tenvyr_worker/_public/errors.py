from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from .._protocol.json_value import to_json_value


@dataclass(frozen=True)
class AgentFailureOptions:
    code: str
    message: str
    retryable: bool
    details: Mapping[str, object] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.code, str) or not self.code.strip():
            raise ValueError("Agent failure code must be a non-empty string")
        if not isinstance(self.message, str) or not self.message.strip():
            raise ValueError("Agent failure message must be a non-empty string")
        if type(self.retryable) is not bool:
            raise TypeError("Agent failure retryable must be boolean")
        if self.details is not None:
            if not isinstance(self.details, Mapping):
                raise TypeError("Agent failure details must be a JSON object")
            converted = to_json_value(dict(self.details))
            if not isinstance(converted, dict):
                raise TypeError("Agent failure details must be a JSON object")
            object.__setattr__(self, "details", converted)


class AgentExecutionError(Exception):
    def __init__(self, failure: AgentFailureOptions) -> None:
        if not isinstance(failure, AgentFailureOptions):
            raise TypeError("failure must be AgentFailureOptions")
        super().__init__(failure.message)
        self.failure = failure
