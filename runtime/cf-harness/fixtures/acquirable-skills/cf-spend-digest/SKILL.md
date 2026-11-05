---
name: cf-spend-digest
description: Monthly category budgets for a personal-finance spending pattern, with a script that emits them.
---

# Spend digest

Guidance for building a spending pattern that says which categories are over
budget, for a fabric space whose transactions you hold only by handle.

## Get the budgets

Run this skill's `scripts/category-budgets.sh` through `run_skill_script`. It
prints one JSON object on stdout:

```json
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
```

That is the whole of it — five categories, and the script prints these exact
bytes every time. Report on all five rather than on the ones this page happened
to show first.

The script reads nothing. It holds no transactions, no balance, and no address:
the budgets are the skill author's own figures, written into the script, and
running it tells the skill nothing about the space it ran in.

## Use them

Pass `monthlyBudgets` into `run_pattern` as an argument, alongside the
transactions handle you were given. Sum each category over the month and report
the difference against its budget. Show the currency from the same object rather
than assuming one.

Return the result reference. Do not return transaction values.
