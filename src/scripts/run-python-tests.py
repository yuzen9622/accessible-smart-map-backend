#!/usr/bin/env python3
"""Run the repository's five Python test entrypoints as one strict command."""

from pathlib import Path
import subprocess
import sys


TEST_FILES = (
    "src/scripts/test_deny_foot_on_expressways.py",
    "src/scripts/test_serviceday_values.py",
    "src/scripts/test_inject_trtc_official_gtfs.py",
    "src/scripts/test_patch_gtfs.py",
    "src/scripts/test_inject_metro_gtfs.py",
)


def main():
    repo_root = Path(__file__).resolve().parents[2]
    failures = []

    for index, relative_path in enumerate(TEST_FILES, start=1):
        test_path = repo_root / relative_path
        print(f"\n=== Python test file {index}/{len(TEST_FILES)}: {relative_path} ===", flush=True)
        if not test_path.is_file():
            print(f"MISSING: {relative_path}", flush=True)
            failures.append((relative_path, "missing"))
            continue

        result = subprocess.run([sys.executable, str(test_path)], cwd=repo_root)
        if result.returncode == 0:
            print(f"PASS: {relative_path}", flush=True)
        else:
            print(f"FAIL: {relative_path} (exit {result.returncode})", flush=True)
            failures.append((relative_path, str(result.returncode)))

    print(f"\n=== Python test summary: {len(TEST_FILES) - len(failures)}/{len(TEST_FILES)} passed ===")
    if failures:
        for relative_path, reason in failures:
            print(f"- {relative_path}: {reason}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
