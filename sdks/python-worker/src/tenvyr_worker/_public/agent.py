from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Generic, Protocol, TypeAlias, TypeVar

from .context import AgentExecutionContext, AgentExecutionSuccess

InputT = TypeVar("InputT")
OutputT = TypeVar("OutputT")
ParsedT = TypeVar("ParsedT")
ParsedT_co = TypeVar("ParsedT_co", covariant=True)


class _ParserObject(Protocol[ParsedT_co]):
    def parse(self, value: object) -> ParsedT_co: ...


ValueParser: TypeAlias = Callable[[object], ParsedT] | _ParserObject[ParsedT]
AgentReturn: TypeAlias = OutputT | AgentExecutionSuccess[OutputT]
AgentExecuteFunction: TypeAlias = Callable[
    [AgentExecutionContext, InputT],
    AgentReturn[OutputT] | Awaitable[AgentReturn[OutputT]],
]


@dataclass(frozen=True)
class AgentDefinition(Generic[InputT, OutputT]):
    name: str
    execute: AgentExecuteFunction[InputT, OutputT] = field(repr=False)
    version: str | None = None
    input_parser: ValueParser[InputT] | None = field(default=None, repr=False)
    output_parser: ValueParser[OutputT] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("Agent name must be a non-empty string")
        if not callable(self.execute):
            raise TypeError("Agent execute handler must be callable")
        _validate_parser(self.input_parser, "input_parser")
        _validate_parser(self.output_parser, "output_parser")


def define_agent(
    *,
    name: str,
    execute: AgentExecuteFunction[InputT, OutputT],
    version: str | None = None,
    input_parser: ValueParser[InputT] | None = None,
    output_parser: ValueParser[OutputT] | None = None,
) -> AgentDefinition[InputT, OutputT]:
    return AgentDefinition(
        name=name,
        execute=execute,
        version=version,
        input_parser=input_parser,
        output_parser=output_parser,
    )


def parse_value(parser: ValueParser[ParsedT], value: object) -> ParsedT:
    if callable(parser):
        return parser(value)
    return parser.parse(value)


def _validate_parser(parser: object | None, field_name: str) -> None:
    if parser is None or callable(parser):
        return
    if not callable(getattr(parser, "parse", None)):
        raise TypeError(f"Agent {field_name} must be callable or expose callable parse")
