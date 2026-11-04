# Diagnostic probes

This directory holds one-shot diagnostic scripts used during transformer
investigations. **They are not tests.** They don't assert anything and they
don't run in CI. They walk the fixture tree, ask focused questions, and emit
TSV/CSV summaries you can re-slice with `awk` / `grep` / spreadsheet tools.

The probes are kept in-tree because:

- They proved useful enough during their original investigation that we'd like
  the next person facing a similar question to have a head start.
- The setup boilerplate (loading fixtures into a `ts.Program` via
  `batchTypeCheckFixtures`, walking expected files with the TS parser,
  classifying identifier positions) is non-trivial to reproduce from scratch
  each time.
- They serve as worked examples of the "investigate at population scale before
  changing code" technique.

The probes are **allowed to bit-rot.** They might break when fixture loaders
change, when import paths move, or when the analyzer interface evolves. We're
not promising they'll always work — only that if a similar question arises,
they're a starting point you can revive or copy-paste from.

If you find yourself updating a probe to keep it running, ask first whether the
question it answers is still active. If yes, fix it. If no, delete it.

## Running them

From `base/ts-transformers/`:

```sh
deno run --allow-read --allow-env test/diagnostics/probe-element-param-analyzer.ts > /tmp/probe.tsv
```

Each prints a header row to stdout, then one data row per finding. A summary
goes to stderr.

## What's here

### `probe-element-param-analyzer.ts`

For each `arr.map((p, …) => …)` callback in fixture inputs, asks the dataflow
analyzer what it reports for every read of `p`, `p.x`, `p.x.y`, etc. inside the
body. Output classifies each access by:

- `kind` — identifier-only vs property-access
- `in_jsx`, `in_method_call` — syntactic position
- `opaque`, `requires_rewrite`, `dataflows` — analyzer verdict
- `reactive_map` — heuristic: does the corresponding `.expected.*` file contain
  `mapWithPattern` / `filterWithPattern` / `flatMapWithPattern`?

Used during the element-binding analyzer fix (PR #3550) to scope the bug:
identified 16 cases the analyzer was silent on across the fixture suite, of
which PR #3539 covered only 1.

(Two former probes from the PR #3550 derive closure-capture investigations —
`probe-derive-closure-captures.ts` and `probe-derive-callback-captures.ts` —
were deleted after the `derive` builder was retired in CT-1643; the pipeline no
longer emits `__cfHelpers.derive(...)`, so the question they answered is closed.
Recover them from git history if a similar capture audit is needed for the
lift-applied form.)

### `probe-array-method-owner-names.ts`

Runs the full pipeline on every fixture input with temporary instrumentation in
call-kind's `isMethodDeclarationOwnedBy` (see the probe header for the patch)
and records every array-method-named owner check: which owner name the
declaration resolved to, against which owner set, and whether it matched.

Used to retire `OPAQUE_REF_OWNER_NAMES` (the OpaqueRefMethods/OpaqueRef
method-owner set from the pre-#3153 api shape): across 347 fixtures it never
matched. The same run showed 29 `.map` checks resolving to owner `IDerivable` —
in neither owner set — yet classified correctly via other paths; adding
`IDerivable` to the owner set changed no golden, confirming the owner check is
redundant for branded receivers, not silently load-bearing.

## When to add a new probe

Good candidates:

- The question has a measurable answer across many similar instances (fixtures,
  files, occurrences of a pattern).
- You catch yourself wanting to "spot-check a few cases" — that's the signal.
- The investigation would otherwise produce a tiny biased sample.

Bad candidates:

- One-off questions answerable by reading 2-3 files.
- Things that should be real tests with assertions.
- Things that need ongoing CI enforcement (promote those to real tests).
