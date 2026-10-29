# @commonfabric/ts-transformers

TypeScript AST transformers that bridge authored TypeScript patterns and the
Common Fabric runtime. Pattern authors write natural TypeScript; the transformer
pipeline rewrites supported reactive constructs into explicit schema-annotated
form for reactivity and information-flow control.

## What It Does

The transformers analyze TypeScript at compile time and:

1. **Convert TypeScript types to JSON Schemas** -
   `interface State { items: Array<{ price: number }> }` becomes a
   runtime-inspectable schema
2. **Make closure captures explicit** - Hidden variable captures become explicit
   parameters with schemas
3. **Annotate data flow boundaries** - Every `lift` / `computed`, `handler`, and
   `mapWithPattern` gets input/output schemas

Example transformation (illustrative; trimmed for readability — use
`--show-transformed` below for the full output):

```tsx
// Input: Natural TypeScript inside a pattern
items.map((item) => item.price * discount);

// Output: the reactive collection call becomes a hoisted, schema-annotated
// mapWithPattern over a module-scope pattern, with closure captures threaded as
// params and reactive reads lowered to `.key(...)`:
const __cfPattern_1 = __cfHelpers.pattern(
  (__cf_pattern_input) => {
    const item = __cf_pattern_input.key("element");
    const discount = __cf_pattern_input.key("params", "discount");
    return item.key("price") * discount;
  },
  /* element + params input schema */ {
    /* … */
  } as const satisfies __cfHelpers.JSONSchema,
  /* result schema */ {
    type: "number",
  } as const satisfies __cfHelpers.JSONSchema,
);
// …used at the original site as:
items.mapWithPattern(__cfPattern_1, { params: { discount } });
// …and registered for content-addressed identity at module end:
__cfReg({ __cfPattern_1 });
```

Note the shape that current `main` actually emits: builder calls (`pattern` /
`lift` / `handler`) are hoisted to module-scope consts and registered with a
single trailing `__cfReg({ … })` (see the current-behavior spec §11);
`computed`/`derive`-style computations lower to the lift-applied form rather
than the retired `derive(...)` helper.

## Review First

For the current shape, start at the spec-corpus map instead of inferring
architecture from older implementation notes:

- `docs/specs/ts-transformer/README.md` — corpus map, authority rules, read
  order
- `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`
- `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`

## Development

### Commands

```bash
deno task test              # Run all tests
deno task check             # Type-check sources
deno task fmt               # Format code
deno task lint              # Lint code
```

### Fixture-Based Testing

Tests are driven by input/expected file pairs in `test/fixtures/`:

```
test/fixtures/closures/
├── map-single-capture.input.tsx      # What the pattern author writes
├── map-single-capture.expected.jsx   # What the transformer produces
├── handler-event-param.input.tsx
├── handler-event-param.expected.jsx
└── ... (many more closure fixtures)
```

To run a specific fixture:

```bash
env FIXTURE=map-single-capture deno task test
```

To regenerate expected files after an intentional behavior change (this is a
spec change — see the current-behavior spec §21):

```bash
env UPDATE_GOLDENS=1 deno task test
```

To see transformed output:

```bash
deno task cf check --show-transformed [--no-run] patterns/apps/lunch-poll/main.tsx
```

Run it from the repository root, targeting a pattern that lives in the workspace
(the path is repo-root-relative, e.g. `patterns/apps/lunch-poll/main.tsx`):
`deno task cf` resolves the pattern against the workspace to execute the
transform. Add `--no-run` to emit the transformed output without running the
pattern.

### Unit Tests

Most other `*.test.ts` files under `test/` are unit tests that drive a single
transformer function or the full pipeline directly and assert on the result,
rather than comparing against a golden file. See
[test/README.md](test/README.md) for the two harnesses (driving an exported
function directly vs. `transformSource`/`validateSource`) and the convention for
asserting on emitted code: parse the output back into an AST via
`test/transformed-ast.ts` and assert on real nodes or evaluated schema values,
not printed-text substrings.

### Adding New Transformations

1. Create `test/fixtures/closures/my-new-case.input.tsx` with the natural
   TypeScript
2. Create `test/fixtures/closures/my-new-case.expected.jsx` with the desired
   output (the driver derives `.expected.jsx` / `.expected.js` — not `.tsx`)
3. Run `env FIXTURE=my-new-case deno task test` to iterate until it passes

## Architecture

### Pipeline

An ordered multi-stage pipeline (order is behavior) implementing five jobs:
validation → JSX routing and early rewriting → lift/closure lowering → schema
injection, builder hoisting + `__cfReg` registration, and schema generation →
module-scope finalization (identity naming, `__cf_data` wrapping, coverage, SES
hardening).

The stage list and order are deliberately **not** restated here: the canonical
source is `CFC_TRANSFORMER_STAGES` in `src/cf-pipeline.ts`, documented stage by
stage in `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
(§3 and onward), and pinned to the constant by `test/spec-sync.test.ts`.

### Representative Rewrites

| Input Pattern         | Output                                    | Purpose                    |
| --------------------- | ----------------------------------------- | -------------------------- |
| `array.map(fn)`       | `array.mapWithPattern(pattern, captures)` | Explicit closure captures  |
| `expr1 * expr2`       | `lift(schema, schema, fn)(inputs)`        | Data flow boundary         |
| `onClick={() => ...}` | `handler(eventSchema, stateSchema, fn)`   | Handler with dual schemas  |
| `assert(() => expr)`  | a `computed` whose body records operands  | Test assertion diagnostics |
| `Cell<T>`             | `{ type: "...", asCell: ["cell"] }`       | Writable reactive ref      |
| `Reactive<T>`         | structural schema without `asOpaque`      | Read-only reactive ref     |

### Assertion diagnostics

`AssertDiagnostics` rewrites the body of an `assert(...)` call — the builder
pattern tests use for assertions — so that a failure can report its operands
instead of only `false`:

```tsx
// Input
assert(() => a + b <= c);

// Output (outline): each operand of the top-level operator is recorded under
// its authored source text, and `assertCapture` returns it unchanged.
assert((): { ok: boolean; source: string; parts: ... } => {
  const __cfAssertParts: { src: string; value: unknown }[] = [];
  const __cfAssertOk: boolean =
    __cfHelpers.assertCapture(__cfAssertParts, "a + b", a + b) <=
    __cfHelpers.assertCapture(__cfAssertParts, "c", c);
  return {
    ok: __cfAssertOk,
    source: "a + b <= c",
    parts: __cfHelpers.assertRenderParts(__cfAssertOk, __cfAssertParts),
  };
});
```

`assertCapture` stashes each operand's resolved value rather than rendering it.
`assertRenderParts` renders those values into the record's `parts`, but only
when the assertion failed: it returns an empty list when `ok` is true. A passing
assertion — the common case — therefore never renders an operand it would not
report, which keeps assertion-heavy tests from paying a diagnostics cost on
every evaluation.

Recorded: the operands of a comparison or arithmetic operator, the arguments of
a call, the operand of `!`, and, for `&&`, `||`, `??` and `?:`, each side along
with what is inside it. Wrapping an operand in a call that returns it unchanged
leaves evaluation alone, so short-circuiting still holds and an operand that
never runs is never recorded. Left alone: literal and function operands, whose
values say nothing the source text does not — for a call whose arguments are all
of those, the receiver is recorded instead, since `items.every((i) => i.ok)` is
really a question about `items`. A spread argument is also left alone: the
recording call takes the operand as one fixed parameter, so wrapping `f(...xs)`
would pass `xs[0]` where the whole of it belongs and change the call's arity.

Every `return` in the body is rewritten, not just a trailing one, so a body that
returns early still produces a record. The two locals go through
`createUniqueName`, so they carry a counter in the real output and a body that
already binds one of those names keeps its own.

Three things about the stage are load-bearing:

- It runs **before** `LiftLowering`, so the operand labels are the author's own
  source text. After lowering the same operand would read `a.get() + b.get()`.
  The lowering that follows rewrites the operands inside the capture calls as it
  would any other reactive expression.
- The callback gets an **explicit return type annotation**, because schema
  injection uses a callback's annotation directly when it has one. An inferred
  `unknown` return would give the assertion `{ type: "unknown" }`, and a field
  with that schema is not materialized: it reads back as an opaque reference
  carrying none of the value's properties.
- The record shape is emitted **unconditionally**, since `assert` declares that
  it returns an `AssertRecord` and the value has to match the declared type.
  `TransformationOptions.assertDiagnostics: false` drops the recording calls and
  keeps the shape.

The stage rewrites `assert(...)` calls and nothing else, so output for code that
does not use `assert` is unchanged. See
`docs/common/workflows/pattern-testing.md` for the authoring side.

## Additional Documentation

- `docs/specs/ts-transformer/README.md` - corpus map, authority rules, and read
  order (replaces the retired PR-3154 review guide, now in `docs/history/`)
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md` -
  implemented behavior inventory
- `docs/specs/ts-transformer/ts_transformers_design_deltas.md` - hardening
  follow-ups and historical deltas (includes the live follow-up queue)
- `AGENTS.md` - working guide for agents: doc map, instruments, conventions

## Why This Matters

The schemas enable:

- **Reactivity** - Runtime knows which values to track for re-computation
- **Taint tracking** - If secret data enters a computation, the output is
  tainted
- **Access control** - Can this computation see this data?
- **Audit trails** - How did this value get computed?

Pattern authors write natural TypeScript. The transformers handle the complexity
of making it secure and reactive.
