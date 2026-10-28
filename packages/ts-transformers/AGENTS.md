# @commonfabric/ts-transformers — Agent Guide

TypeScript AST transformer pipeline that compiles the CTS dialect (natural
TS/JSX pattern source) into explicit, schema-annotated reactive form for the
Common Fabric runtime. 25 ordered stages (`CFC_TRANSFORMER_STAGES`,
`src/cf-pipeline.ts`): validation → JSX routing → lift/closure lowering → schema
injection → builder hoisting + `__cfReg` registration → schema generation →
module-scope hardening.

## Where answers live

| Question                                                 | Read                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| What may pattern authors write? (normative)              | `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`                                      |
| What must lowering preserve? (normative)                 | `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`                                                 |
| What does the pipeline actually do today?                | `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md` — start at its §21.1 sources-of-truth table |
| Why does the package exist / goal numbering (G-/C-/NG-)  | `docs/specs/ts-transformer/ts_transformers_goals.md`                                                             |
| What changed deliberately / what's still open            | `docs/specs/ts-transformer/ts_transformers_design_deltas.md`                                                     |
| Human-narrative intro to the whole compile story         | `docs/tutorial/07-compilation.md`                                                                                |
| How types become schemas (the other half)                | `packages/schema-generator/` + its mapping spec; runtime dialect: `docs/specs/json_schema.md`                    |
| Add a type-arg→schema lowering (e.g. `sqliteQuery<Row>`) | `docs/adding-type-arg-schema-lowering.md`                                                                        |
| Array-method callback internals                          | `docs/array-method-callback-pipeline.md`                                                                         |
| Fixture test workflow                                    | `test/fixtures/README.md`                                                                                        |
| Unit-test harnesses + assertion helpers                  | `test/README.md`                                                                                                 |
| Investigation probes (not tests)                         | `test/diagnostics/README.md`                                                                                     |

Authority rule: the two normative specs win over the implementation (fix the
code or record the delta); the current-behavior spec loses to code/tests (fix
the spec). `docs/common/` is author-facing teaching material, lowest authority.

## Instruments

- See what the transformer emits (always do this before inferring from source):
  `deno task cf check <pattern-or-fixture>.tsx --show-transformed --no-run` —
  pipe through `| deno task cf view` for a syntax-aware pager.
- Run one fixture: `env FIXTURE=<name> deno task test`. Regenerate goldens:
  `UPDATE_GOLDENS=1` (runner in `packages/test-support`). Fixture suites live
  under `test/fixtures/<suite>/` as `*.input.tsx` / `*.expected.jsx` pairs;
  `closures/` is by far the largest.
- Population-scale questions ("how often does the analyzer say X across
  fixtures?") → write/revive a probe, `test/diagnostics/README.md`.

## Local facts that will bite you

- Bare `node.getText()` throws on synthetic nodes; the repo lint rule
  `lint-plugins/no-node-get-text.ts` forbids it in src. Use `getNodeText()` /
  `getExpressionText()` (`src/ast/utils.ts`).
- Stage order is behavior (invariant C-002). Notably BuilderCallHoisting runs
  AFTER SchemaInjection so hoists are schema-transparent; hoisted consts flush
  before their owning statement for TDZ reasons (spec §11).
- Cross-stage communication goes through `CrossStageState` only
  (`src/core/cross-stage-state.ts`); `typeRegistry` + `schemaHints` are bare
  WeakMaps because schema-generator (separate package) reads them; the
  `schemaInjected` marker deliberately has NO `getOriginalNode` fallback.
- Call detection is provenance-first via `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY`
  (`src/core/commonfabric-runtime-registry.ts`); a guard test asserts it covers
  every callable the runner's builder factory injects. New runtime export ⇒ add
  a registry entry and decide `reactiveOrigin` explicitly.
- Write visitors with `visitEachChildWithJsx` (`src/ast/utils.ts`), not raw
  `ts.visitEachChild` — the stock visitor skips `JsxExpression.expression`, so a
  raw visitor silently misses JSX subtrees.
- The module-scope stages' emitted shapes (`__cf_data` wrapping, hardening
  helpers, the single trailing `__cfReg`) are pattern-matched by the runner's
  sandbox verifier (`@commonfabric/utils/sandbox-contract`). Changing what they
  emit is a cross-package contract change — module loading breaks until the
  verifier agrees.
- Emitted synthetic identifiers use the `__cf` prefix (`__cfLift_1`,
  `__cf_pattern_input`); `__`-prefixed params are skipped by shrink validation.
  (`__ct*`-prefixed names you'll see in `packages/api` type brands are a
  separate, older convention — don't unify without a decision.)
- Terminology: CTS = the TypeScript dialect this package compiles (glossary:
  "Common Fabric TypeScript"). CFC = Contextual Flow Control, the
  information-flow security model (`specs` repo `cfc/`). The pipeline constant
  prefix `CFC_TRANSFORMER_*` predates this split — it names the CTS pipeline.

## When you change behavior

Fixture-expectation or transformer changes ARE spec changes: update
`ts_transformers_current_behavior_spec.md` in the same change (its §21 says so;
`test/spec-sync.test.ts` enforces the enumerable parts). New diagnostic ⇒ spec
§6 entry. New pipeline stage ⇒ spec §3 (the sync test will fail until you do).
Deliberate language-boundary changes ⇒ target-language spec + design-deltas.
