#!/usr/bin/env python3
"""Fail closed on common private markers in a candidate public tree."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


PATTERNS = (
    re.compile(re.escape("/" + "Users" + "/"), re.I),
    re.compile(r"BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY"),
    re.compile(r"(?:api[_-]key|access[_-]token|refresh[_-]token|client[_-]secret)\s*[:=]", re.I),
    re.compile(r"Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{12,}", re.I),
)
SKIP_DIRS = {".git", ".pnpm", ".cache", ".remotion", "build", "dist", "node_modules", "out"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument(
        "--private-marker",
        action="append",
        default=[],
        help="Additional private marker to reject; pass it only during a local audit.",
    )
    args = parser.parse_args()
    private_markers = [marker.casefold() for marker in args.private_marker if marker]
    private_patterns = [re.compile(re.escape(marker), re.I) for marker in args.private_marker if marker]
    failures: list[str] = []
    for path in args.root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if any(marker in str(path.relative_to(args.root)).casefold() for marker in private_markers):
            failures.append(f"path:{path}")
            continue
        if not path.is_file() or path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".apk", ".aab"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if any(pattern.search(line) for pattern in (*PATTERNS, *private_patterns)):
                failures.append(f"{path}:{line_number}")
    if failures:
        print("public tree scan failed:")
        print("\n".join(failures[:80]))
        return 1
    print(f"public tree scan passed: {args.root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
