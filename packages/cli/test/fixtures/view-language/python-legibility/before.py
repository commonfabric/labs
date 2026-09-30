"""What a reader sees: artifact labels, evidence bounds, and coverage dates."""

from __future__ import annotations

from datetime import datetime, timedelta

COMMON_ORG = "commonfabric"
INLINE_EVIDENCE_LIMIT = 3


def display_date(value: datetime) -> str:
    return f"{value.strftime('%B')} {value.day}, {value.year}"


def coverage_dates(start: datetime, end: datetime) -> str:
    """The local dates a half-open ``[start, end)`` window covers."""
    inclusive_end = end - timedelta(microseconds=1)
    if start.date() == inclusive_end.date():
        return display_date(start)
    return f"{display_date(start)}–{display_date(inclusive_end)}"


def repository_name(scope_ref: str) -> str:
    """Shorten the common org; retain every other org to avoid ambiguity."""
    parts = scope_ref.strip("/").split("/")
    if len(parts) != 2 or not all(parts):
        raise ValueError(f"invalid GitHub repository scope: {scope_ref!r}")
    org, repo = parts
    return repo if org == COMMON_ORG else f"{org}/{repo}"
