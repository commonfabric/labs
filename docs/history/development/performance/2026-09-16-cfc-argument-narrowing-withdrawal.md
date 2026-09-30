---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "PR 7604 integration regression investigation and withdrawal of callback argument narrowing."
---

# Callback argument narrowing withdrawal

PR 7604 withdrew its change to `inferListOpArgumentUsage` after the
server-execution integration lane exposed a regression. The CFC preparation
caches, indexes, and schema-admission corrections remained in the change.

At `3c75f1c31f8af0767885bdc23dd66e573689b331`, the Lunch Poll two-user test
reached the correct shared vote count but displayed no voter swatches in either
browser. CI and focused local runs failed the cross-browser swatch assertion at
`packages/patterns/integration/lunch-poll-vote.test.ts:383`. The same test
passed on parent `e4f878a03e5b42fade599dd917fbeb91c854823b` with
`EXPERIMENTAL_SERVER_EXECUTION=true`; restoring only
`packages/runner/src/builtins/list-op-argument-usage.ts` to that parent also
passed on the PR. Retaining `index` and captured `params` while still omitting
the undeclared `array` input failed.

Captured callback graphs contained no authored reads of `array`: the outer
callback passed `element.voters` to its nested map, and the inner callback read
voter fields from `element`. Schema projection therefore did not prove that
removing an argument was safe for the runtime. Runner family detection and
pre-sync also walk supplied and stored argument links; a removed link can change
hydration and setup. The exact failing dependency was not established, and no
speculative synchronization change was included.

The existing two-user integration test guards the observed behavior. The
synthetic argument-selection tests introduced with narrowing were removed
because their asserted optimization was withdrawn.

The
[initial browser measurements](2026-09-16-cfc-commit-preparation-round2/browser.json)
and [cache follow-up](2026-09-16-cfc-prepare-cache-followup/browser.json) remain
records of their measured snapshots, both of which included narrowing. Their
elapsed-time improvements, scaling fits, and CFC shares are not measurements of
the final PR. The unit preparation benchmarks do not exercise callback argument
inference, but no new final-head browser performance claim was made. Further
work on argument elimination needs a focused hydration/setup regression and new
end-to-end measurements before it can ship.
