from __future__ import annotations

import argparse
import shutil
from pathlib import Path

SCHEMA_FILENAMES = (
    "agent-event.v1.schema.json",
    "agent-invocation.v1.schema.json",
    "agent-result.v1.schema.json",
    "http-agent-run-accepted.v1.schema.json",
    "http-agent-run-request.v1.schema.json",
)
REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE = REPO_ROOT / "contracts" / "schemas"
DESTINATION = (
    REPO_ROOT / "sdks" / "python-worker" / "src" / "tenvyr_worker" / "schema_json"
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Synchronize the tracked Python Worker schema resources"
    )
    parser.add_argument("mode", choices=("sync", "check"))
    arguments = parser.parse_args()
    return sync() if arguments.mode == "sync" else check()


def check() -> int:
    actual = {path.name for path in DESTINATION.glob("*.json")}
    expected = set(SCHEMA_FILENAMES)
    mismatches = sorted(actual ^ expected)
    for filename in SCHEMA_FILENAMES:
        source = SOURCE / filename
        destination = DESTINATION / filename
        if not destination.is_file() or destination.read_bytes() != source.read_bytes():
            mismatches.append(filename)
    if mismatches:
        print("Python Worker schema resources are out of sync:")
        for filename in sorted(set(mismatches)):
            print(f"- {filename}")
        return 1
    print("Python Worker schema resources are in sync (5/5).")
    return 0


def sync() -> int:
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for extra in set(DESTINATION.glob("*.json")) - {
        DESTINATION / filename for filename in SCHEMA_FILENAMES
    }:
        extra.unlink()
    for filename in SCHEMA_FILENAMES:
        shutil.copyfile(SOURCE / filename, DESTINATION / filename)
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
