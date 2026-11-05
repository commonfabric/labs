# ts-transformer specs — map and ground rules

Documentation corpus for the CTS compile pipeline (`base/ts-transformers`)
and its schema companion (`base/schema-generator`). This README is the
entrypoint: what each document is, which ones win arguments, and what you must
update when behavior changes.

## The corpus

| Doc | Status | One line |
| --- | --- | --- |
| [`ts_transformers_target_pattern_language_spec.md`](ts_transformers_target_pattern_language_spec.md) | **Normative** | What pattern authors may write: Supported / Compatibility-only / Unsupported construct families |
| [`ts_transformers_lowering_contract.md`](ts_transformers_lowering_contract.md) | **Normative** | Ten semantic invariants every rewrite must preserve |
| [`ts_transformers_current_behavior_spec.md`](ts_transformers_current_behavior_spec.md) | **Descriptive** | What the pipeline actually does today, stage by stage; §21.1 maps enumerable claims to their canonical constants |
| [`ts_transformers_goals.md`](ts_transformers_goals.md) | Intent | Why the package exists; G-/NG-/C- numbered goals, non-goals, invariants |
| [`ts_transformers_design_deltas.md`](ts_transformers_design_deltas.md) | Roadmap/status | Deliberate behavior deltas: landed, partial, open (includes the live follow-up queue) |
| [`ts_transformers_type_driven_behavior_inventory.md`](ts_transformers_type_driven_behavior_inventory.md) | Descriptive (narrow) | Where checker/type information changes transformer behavior |
| [`cfc_authoring_contract.md`](cfc_authoring_contract.md) | Contract (core implemented) | CFC-aware authoring surface: alias set + lowering rules to `ifc.*`; see its status header for letter-vs-shipped deltas |
| [`cfc_ui_helper_contract.md`](cfc_ui_helper_contract.md) | Contract (implemented) | UiAction / UiPromptSlot / UiDisclosure JSX rewrite + `ifc.uiContract` hints |
| [`../schema-generator/ts_to_json_schema_mapping.md`](../schema-generator/ts_to_json_schema_mapping.md) | **Descriptive** | The TypeScript→JSON Schema mapping rules (the other half of the language contract) |
| [Historical records](../../history/INDEX.md) | Historical | Superseded designs and PR-scoped artifacts; nothing there describes the current system |

Related, outside this directory: [JSON Schema](../json_schema.md), the runtime
schema dialect these schemas target; the `JSONSchema` type in
`base/api/index.ts` is the authoritative field inventory. The
[pattern-construction specs](../pattern-construction/README.md) define the
runner-side builder and graph design. The
[compilation tutorial](../../tutorial/07-compilation.md) is the narrative
walkthrough and the best first read for humans and agents new to the system.
The per-package `AGENTS.md` files provide working guides, document maps,
instruments, and conventions.

## Which document wins

- **Normative docs win over the implementation.** If code disagrees with the
  target-language spec or the lowering contract, the code is wrong or the
  divergence must be recorded (design-deltas / current-behavior). Do not
  soften a normative spec to match an implementation accident.
- **The implementation wins over descriptive docs.** If code or passing tests
  disagree with the current-behavior spec or the mapping spec, the spec is
  stale: fix it, citing the constant/test that proves the behavior.
- Everything else (`docs/common/`, tutorials, in-package how-tos) teaches; it
  never overrules a spec. (This refines the repo-wide hierarchy in
  `skills/knowledge-base/SKILL.md`, which predates the normative/descriptive
  split.)

## Reading paths

- **"May authors write X?"** → target-language spec §4 matrix, then §4.1/§4.2.
- **"What will the compiler emit for X?"** → run
  `deno task cf check <file> --show-transformed --no-run` FIRST, then the
  current-behavior spec for the why.
- **"Is this emitted schema right?"** → schema-generator mapping spec +
  `json_schema.md` + the `JSONSchema` type in `base/api/index.ts`.
- **Reviewing a transformer PR** → lowering contract (which invariant is at
  stake?), then the current-behavior spec sections the diff touches, then the
  fixture suites named there.
- **New to all of this** → `docs/tutorial/07-compilation.md`, then the
  target-language spec.

## Keeping this corpus true

1. Behavior changes (including fixture-expectation changes) update the
   current-behavior spec in the same change. New diagnostics get a §6 entry;
   new pipeline stages get §3; new runtime exports get §5 + the registry.
2. Enumerable facts cite their canonical source (constant / function / test)
   rather than restating it — see §21.1. The load-bearing enumerations are
   pinned by `base/ts-transformers/test/spec-sync.test.ts`; extend it when
   you add one.
3. Prose lists are labeled "as of this writing". Status headers say what kind
   of document you're in. Docs whose content is superseded move to
   [`docs/history/`](../../history/README.md) per the repo-wide
   [live/historical rules](../../README.md) — they do not linger unlabeled.
4. Periodic verification: run the `spec-audit` skill (`skills/spec-audit/`)
   after major landings or quarterly. It maps claim-level checks of this corpus
   to the relevant authority, code, tests, fixtures, and runtime seams. The
   2026-07 audit found the
   corpus denying a subsystem (`ifc.*` lowering) that had been implemented and
   fixture-pinned for ~3 months; assume drift accumulates silently.
