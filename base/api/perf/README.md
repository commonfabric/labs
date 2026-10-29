# API Type Profiling Harness

This directory contains self‑contained TypeScript projects that measure how
expensive particular exported types from `base/api/index.ts` are to check. Each
scenario lives in its own `.ts` file with a matching `tsconfig.*.json` so that
we can profile the types independently.

`run-tsc.ts` resolves the TypeScript version from `base/api/deno.jsonc`, so the
harness uses the same compiler pin as the runtime packages. Follow the
[TypeScript dependency guide](../../../docs/development/DEPENDENCIES.md#typescript)
when rolling it.

The profiling projects use TypeScript's own module resolver rather than Deno's.
`tsconfig.base.json` therefore maps the workspace imports reached from the API
source. Add a path there when the API begins importing another workspace entry.
Its `target` is `ESNext`, matching the `esnext` lib the workspace's `deno.jsonc`
names. A narrower target rejects source that type-checks everywhere else in the
tree.

## Quick Metrics

Run the compiler with `--extendedDiagnostics` to get counts of type
instantiations, memory usage, etc.

```bash
deno run -A base/api/perf/run-tsc.ts \
  --project base/api/perf/tsconfig.key.json \
  --extendedDiagnostics --pretty false
```

Available projects:

- `tsconfig.baseline.json` – empty control case for the load cost of
  `base/api/index.ts`.
- `tsconfig.key.json` – stresses `KeyResultType` + branded cell keying.
- `tsconfig.anycell.json` – focuses on `AnyCellWrapping` write helpers.
- `tsconfig.schema.json` – exercises the JSON schema conversion helpers.
- `tsconfig.ikeyable-cell.json` – heavy `IKeyable<Cell<…>>` stress case.
- `tsconfig.ikeyable-schema.json` – `IKeyable` over `Cell<Schema<…>>`.
- `tsconfig.ikeyable-realistic.json` – representative nested record and cell
  shapes.

Each run prints metrics; compare the “Instantiations”, “Types”, and “Check time”
fields against the baseline to see relative cost.

## CPU Profiles

Use `--generateCpuProfile` to capture where the checker spends time. The profile
is a Chromium CPU profile you can open via DevTools ▸ Performance ▸ “Load
profile…”.

```bash
DENO_V8_FLAGS=--max-old-space-size=4096 \
deno run -A base/api/perf/run-tsc.ts \
  --project base/api/perf/tsconfig.ikeyable-cell.json \
  --generateCpuProfile base/api/perf/traces/ikeyable-cell.cpuprofile
```

Generated profiles are stored under `base/api/perf/traces/`. Existing ones
include:

- `ikeyable-cell.cpuprofile`
- `ikeyable-schema.cpuprofile`

## Event Traces (Caution: Large)

`--generateTrace <dir>` produces Chrome trace JSON (`trace.json`) plus a
snapshot of instantiated types (`types.json`). These files grow quickly and can
exceed V8’s heap limit on the heavy scenarios.

```bash
mkdir -p base/api/perf/traces/ikeyable-cell \
  && DENO_V8_FLAGS=--max-old-space-size=4096 \
     deno run -A base/api/perf/run-tsc.ts \
       --project base/api/perf/tsconfig.ikeyable-cell.json \
       --generateTrace base/api/perf/traces/ikeyable-cell
```

If you hit an “out of memory” crash, try:

- Lowering `max-old-space-size` so the compiler bails faster (you still get
  partial traces), or
- Splitting the stress test into smaller files and tracing each individually.

The lighter `tsconfig.ikeyable-cell-trace.json` target exists specifically for
trace generation; it keeps the scenario minimal enough to succeed.

## Scripts / Analysis

To run every scenario in one go (and print a short summary for each), run:

```bash
cd base/api
deno task profile-types
```

For ad-hoc inspection of trace files you can also use Deno directly:

```bash
deno eval 'import trace from "./base/api/perf/traces/ikeyable-cell/trace.json" assert { type: "json" };\
const totals = new Map();\
for (const e of trace) if (e.ph === "X") totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur);\
console.log([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));'
```

Feel free to add your own utilities here if repeated analyses become necessary.

## Tips

- Always compare against `tsconfig.baseline.json` to understand the fixed cost
  of loading the module.
- When experimenting with type changes, re-run the relevant scenario(s) to watch
  how instantiation counts and profile hotspots move.
- For long-running traces, add `DENO_V8_FLAGS=--max-old-space-size=<MB>` to
  increase Deno's V8 heap limit.
