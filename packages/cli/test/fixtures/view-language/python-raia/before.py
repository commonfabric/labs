#!/usr/bin/env python3
"""Analyze RAIA oracle-sweep runs."""
import json, statistics
from collections import defaultdict
from pathlib import Path

BENCH = Path(__file__).resolve().parent
RUNS = BENCH / "results" / "runs.jsonl"
P_SOLVE = 0.8


def load():
    if not RUNS.exists():
        return []
    return [json.loads(l) for l in RUNS.read_text().splitlines() if l.strip()]


def short(m):
    return m.replace("claude-", "")


def fail_vec(runs, model):
    """{(task, seed): 1 if hidden-fail else 0} for one model."""
    return {(r["task"], r["seed"]): (0 if r["hidden_pass"] else 1)
            for r in runs if r["model"] == model}


def solve_rate(runs):
    by_tier = defaultdict(list)
    for run in runs:
        by_tier[short(run["model"])].append(1 if run["hidden_pass"] else 0)
    return {tier: statistics.mean(flags) for tier, flags in by_tier.items()}
