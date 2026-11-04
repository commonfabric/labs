#!/usr/bin/env python3
"""Architecture checker for the cfc/formal Lean development."""

from __future__ import annotations

import re
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNRESTRICTED_IMPORTERS = {"Cfc.All", "Main"}
EXAMPLE_COMPONENT = re.compile(r".*Examples?$")


def module_name(path: Path) -> str:
    return str(path.relative_to(ROOT).with_suffix("")).replace("/", ".")


def closure(imports: dict[str, list[str]], root: str) -> set[str]:
    seen = {root}
    queue = deque([root])
    while queue:
        module = queue.popleft()
        for imported in imports.get(module, []):
            if imported not in seen:
                seen.add(imported)
                queue.append(imported)
    return seen
