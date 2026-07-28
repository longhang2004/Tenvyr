from __future__ import annotations

import ast
import json
import tomllib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = PROJECT_ROOT / "src" / "tenvyr_worker"
REPO_ROOT = PROJECT_ROOT.parents[1]


def test_metadata_declares_only_the_two_approved_runtime_dependency_families() -> None:
    project = tomllib.loads(
        (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )
    assert project["build-system"] == {
        "requires": ["hatchling>=1.27,<2"],
        "build-backend": "hatchling.build",
    }
    metadata = project["project"]
    assert metadata["name"] == "tenvyr-worker"
    assert metadata["version"] == "0.1.0"
    assert metadata["requires-python"] == ">=3.11"
    assert metadata["dependencies"] == [
        "aiohttp>=3.12,<4",
        "jsonschema[format-nongpl]>=4.23,<5",
    ]
    assert "Private :: Do Not Upload" in metadata["classifiers"]
    assert "license" not in metadata


def test_package_does_not_import_forbidden_frameworks() -> None:
    forbidden = {
        "django",
        "fastapi",
        "flask",
        "multiprocessing",
        "pydantic",
        "signal",
        "starlette",
    }
    for path in PACKAGE_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        imports = _top_level_imports(tree)
        assert imports.isdisjoint(forbidden), path


def test_third_party_imports_stay_inside_approved_boundaries() -> None:
    for path in PACKAGE_ROOT.rglob("*.py"):
        relative = path.relative_to(PACKAGE_ROOT).as_posix()
        imports = _top_level_imports(
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        )
        if "jsonschema" in imports or "referencing" in imports:
            assert relative.startswith("_protocol/"), relative
        if "aiohttp" in imports:
            assert relative.startswith(("_http/", "_callback/")) or relative == (
                "_runtime/worker.py"
            ), relative


def test_root_exports_only_public_definitions_and_resources_are_installed() -> None:
    root = ast.parse((PACKAGE_ROOT / "__init__.py").read_text(encoding="utf-8"))
    imports = [node for node in root.body if isinstance(node, ast.ImportFrom)]
    assert imports
    assert all(
        node.level == 1 and (node.module or "").startswith("_public.")
        for node in imports
    )

    assert (PACKAGE_ROOT / "py.typed").is_file()
    assert sorted(
        path.name for path in (PACKAGE_ROOT / "schema_json").glob("*.json")
    ) == [
        "agent-event.v1.schema.json",
        "agent-invocation.v1.schema.json",
        "agent-result.v1.schema.json",
        "http-agent-run-accepted.v1.schema.json",
        "http-agent-run-request.v1.schema.json",
    ]


def test_schema_loader_is_resource_only_and_deprecated_resolver_is_absent() -> None:
    schemas = (PACKAGE_ROOT / "_protocol" / "schemas.py").read_text(encoding="utf-8")
    package_text = "\n".join(
        path.read_text(encoding="utf-8") for path in PACKAGE_ROOT.rglob("*.py")
    )
    assert "resources.files" in schemas
    assert "__file__" not in schemas
    assert "RefResolver" not in package_text
    assert "web.run_app" not in package_text


def test_parity_ledger_has_machine_readable_per_feature_entries() -> None:
    ledger = json.loads(
        (
            REPO_ROOT / "docs" / "architecture" / "workers" / "worker-sdk-parity.json"
        ).read_text(encoding="utf-8")
    )
    required_keys = {
        "feature",
        "typescript_status",
        "python_status",
        "shared_test_or_fixture",
        "intentional_difference",
        "reason",
    }
    assert ledger["features"]
    assert all(set(entry) == required_keys for entry in ledger["features"])
    assert ledger["sharedConformanceCaseCount"] == 73


def test_internal_import_graph_is_acyclic() -> None:
    paths: dict[str, Path] = {}
    for path in PACKAGE_ROOT.rglob("*.py"):
        parts = list(path.relative_to(PACKAGE_ROOT).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts.pop()
        paths[".".join(parts)] = path

    graph = {module: set() for module in paths}
    for module, path in paths.items():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.level == 0:
                continue
            package = (
                module.split(".")
                if path.name == "__init__.py"
                else module.split(".")[:-1]
            )
            remove = node.level - 1
            base = package[: len(package) - remove] if remove else package
            target = ".".join((*base, *(node.module or "").split("."))).strip(".")
            if target in graph:
                graph[module].add(target)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(module: str) -> None:
        assert module not in visiting, f"cyclic internal import through {module}"
        if module in visited:
            return
        visiting.add(module)
        for dependency in graph.get(module, ()):
            visit(dependency)
        visiting.remove(module)
        visited.add(module)

    for module in graph:
        visit(module)


def _top_level_imports(tree: ast.AST) -> set[str]:
    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imports.add(node.module.split(".", 1)[0])
    return imports
