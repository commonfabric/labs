---
status: historical
created: 2026-05-06
archived: 2026-10-29
reason: "Guide for agents in the Build phase of Pattern Factory, whose repository was archived on 2026-10-29."
---

# Pattern Factory Build Guide

This guide is for agents implementing the Build phase in a Pattern Factory
workspace. It complements the general pattern development and testing guides.

## Build Contract

Pattern Factory Build turns an existing brief, spec, UX design, and UI design
into a top-level pattern deliverable:

- `pattern/main.tsx`
- `pattern/main.test.tsx`
- `notes/pattern-maker.md`
- `reviews/test-report.md`

Treat the design inputs as the product contract. Treat the loaded skills and
their referenced docs as the implementation contract.

Before writing build artifacts, read the `Read First` references from the
configured build skills that apply to the current work. At minimum this means:

- the shared pattern development guide
- the shared testing guide
- `docs/common/concepts/reactivity.md`
- `docs/common/patterns/new-cells.md`
- type/schema docs for `Default<>`, `Writable<>`, and pattern Input/Output
- action/handler docs when the pattern has interactions or local state changes
- UI/component docs when implementing the visual design
- for any pattern with multiple people or a "current user":
  `docs/common/components/COMPONENTS.md` (Identity components) and
  `docs/common/patterns/multi-user-patterns.md` (Presenting Identity) — resolve
  the viewer via `#profile`, store each participant's live profile cell in the
  shared `PerSpace` roster on join, render **every** participant with
  `cf-profile-badge` bound to that cell (`cf-avatar` + snapshot only as an offline
  fallback), key membership by cell reference with `equals()`, and never use a
  typed-name field as identity
- debugging docs after any compile, test, or runtime failure that is not
  immediately obvious

Treat `reactivity.md` and `new-cells.md` as baseline Build reads, not optional
references. Pattern Factory outputs are reactive patterns; top-level patterns
commonly render reactive fields, create local draft state, and bind controls.

Record the docs consulted in `notes/pattern-maker.md` so the run is auditable.

## Top-Level Pattern Mode

Pattern Factory create-mode deliverables are usually top-level patterns, not
only reusable sub-patterns.

For a top-level pattern:

- make the pattern usable when invoked by itself with sensible defaults
- own local state inside the pattern unless the spec explicitly requires
  caller-owned cells, linking, or embedding
- expose user-triggered behaviors as typed `Stream<T>` outputs when tests or
  other patterns need to drive them
- return an output shape that mirrors the user-visible state and actions
- include `[UI]` in the output when the pattern renders UI

Use sub-pattern conventions when you intentionally build a nested reusable
piece. Sub-patterns often receive caller-owned writable inputs and must include
`[NAME]`/`[UI]` for composition. Do not let those conventions force the
top-level deliverable to require external writable inputs when the brief expects
a standalone pattern.

## Top-Level State Ownership

Decide what owns state before creating cells. Pattern Factory Build usually
produces a top-level pattern whose inputs and outputs are the pattern contract.
Those input fields are already reactive at runtime.

Do not mirror reactive pattern inputs into new local cells during pattern
initialization. In particular, do not write `new Writable(input.field)`,
`new Writable(input.field || fallback)`, `new Cell(input.field)`, or helper calls
around `input.field` inside `new Writable(...)`. `new Writable()` and `new Cell()`
are only for new pattern-owned cells initialized from static values.

Wrong:

```tsx
// Shown at module scope.
export default pattern<DeviceInput>((input) => {
  const name = new Writable(input.name || ""); // input.name is reactive
  const capabilities = new Writable(input.capabilities || []);
  // ...
});
```

Prefer one of these designs instead:

- If the field is the pattern's primary state, model it in the input/output
  contract with `Default<>` and `Writable<>` as needed, then use that reactive
  input cell directly.
- If the field is independent local UI state, initialize it from a static value:
  `new Writable("")`, `new Writable(false)`, or `new Writable<Item[]>([])`.
- If the field is draft/editing state seeded from input state, initialize the
  draft from a static value and copy the current input value inside an `action()`
  or another valid event/reactive context.

Example:

```tsx
// Shown at module scope.
interface DeviceInput {
  name: Writable<string | Default<"">>;
}

export default pattern<DeviceInput, DeviceOutput>(({ name }) => {
  const draftName = new Writable("");

  const startEditing = action(() => {
    draftName.set(name.get());
  });

  const saveDraft = action(() => {
    name.set(draftName.get());
  });

  return {
    name,
    startEditing,
    saveDraft,
    [UI]: <cf-input $value={draftName} />,
  };
});
```

## Build Verification

Build is complete only when the generated pattern compiles and its pattern tests
pass.

Use the `cf` skill for exact CLI syntax. The normal gate is:

```bash
deno task cf check <pattern>.tsx --no-run
deno task cf test <pattern>.test.tsx
```

If either command fails, continue repair work. A failing compile, typecheck, or
pattern test is not by itself a valid completion state. Hand off with unmet
gates only when the available tools or context are genuinely insufficient to
continue, or when the surrounding harness imposes an explicit turn/time
boundary; record the exact evidence and required next input.

## Failure Recovery Discipline

After any failed `cf check`, `cf test`, CLI runtime check, or browser smoke:

1. Preserve the exact failing command and relevant output in
   `reviews/test-report.md`.
2. Read `docs/development/debugging/README.md`.
3. Match the exact error text or symptom to the matrix and read the linked
   gotcha, workflow, or topic page before making the next repair.
4. If the failure mentions Cell, Writable, `new Cell()`, `new Writable()`,
   reactive references, `.get()`, or a plain JavaScript string/array method
   failing on a field, reread:
   - `docs/common/concepts/reactivity.md`
   - `docs/common/patterns/new-cells.md`
5. Form a narrow hypothesis, make a targeted edit, and rerun the failed gate.

Record any additional docs consulted in `notes/pattern-maker.md`.

When stuck:

- inspect the relevant skill/docs path instead of guessing
- use `cf check --show-transformed` or `--verbose-errors` when compiler
  lowering or error simplification is ambiguous
- simplify to the smallest failing pattern or test step when a test failure is
  unclear
- repair either the implementation or an invalid test contract, then rerun the
  gate

After compile and pattern tests pass, use local runtime, CLI state checks, and
browser smoke checks when the surrounding task asks for them.

## Test Coverage

Pattern Factory Build tests should exercise the pattern contract, not only the
golden path. Prefer coverage for:

- first-run/default and sparse input states
- primary add, remove, edit, toggle, or submit flows
- repeated actions and state transitions
- important validation, empty, partial, or edge-case branches from the spec
- helper or wrapper behavior that would otherwise only be tested manually

Avoid padding tests with assertions that only restate static markup. If a
behavior is easier and more meaningful to verify with CLI or browser runtime
checks, record that in the test report.
