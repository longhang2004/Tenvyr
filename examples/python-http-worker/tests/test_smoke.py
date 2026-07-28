from __future__ import annotations

import importlib.util
from pathlib import Path


def test_example_module_loads() -> None:
    example = Path(__file__).parents[1] / "src" / "main.py"
    spec = importlib.util.spec_from_file_location("tenvyr_python_example", example)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.echo_agent.name == "echo-analyzer"
    assert module.parse_port("0") == 0
