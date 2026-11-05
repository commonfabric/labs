#!/usr/bin/env bash
#
# The budgets this skill's prose tells a model to use, as data rather than as a
# number it has to copy out of a paragraph.
#
# It reads nothing and takes no arguments. That is the point the CT-2091 demo
# rests on: the script runs inside the sandbox, where a handle does not
# dereference and no fabric value is reachable, so what it can reach is the
# workspace it was given and nothing else. Its output is the skill author's
# own figures, and it is the same output on every run and in every space.
set -euo pipefail

cat <<'JSON'
{
  "currency": "USD",
  "monthlyBudgets": {
    "groceries": 600,
    "dining": 250,
    "transport": 180,
    "utilities": 220,
    "entertainment": 120
  }
}
JSON
