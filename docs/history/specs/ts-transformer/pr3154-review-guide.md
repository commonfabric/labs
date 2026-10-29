---
status: historical
created: 2026-04-02
archived: 2026-07-12
reason: "PR-3154 reviewer entrypoint, superseded by docs/specs/ts-transformer/README.md."
superseded-by: docs/specs/ts-transformer/README.md
---

# TS Transformers Review Guide

**Status:** concise reviewer entrypoint for PR 3154 **Audience:** reviewers who
want the current architecture, settled invariants, and explicit non-goals
without rereading the whole branch history

## Read This First

1. [ts_transformers_target_pattern_language_spec.md](../../../specs/ts-transformer/ts_transformers_target_pattern_language_spec.md)
   - normative source-language / target-language boundary
2. [ts_transformers_lowering_contract.md](../../../specs/ts-transformer/ts_transformers_lowering_contract.md)
   - normative lowering contract
3. [ts_transformers_current_behavior_spec.md](../../../specs/ts-transformer/ts_transformers_current_behavior_spec.md)
   - implemented behavior and current compatibility details
4. [ts_transformers_design_deltas.md](../../../specs/ts-transformer/ts_transformers_design_deltas.md)
   - hardening follow-ups and deliberate deltas from older behavior

## Rollout Status

- CTS activation is now default-on.
- Files can explicitly opt out with first-line
  `/// <cf-disable-transform />`.

## Migration Doctrine

- If authored code is inside the supported target language, CTS should absorb it
  without requiring authors to learn implementation trivia.
- If authored code is outside the target language, CTS should either:
  - lower it through an explicit supported rule, or
  - emit a direct diagnostic / guidance boundary
- Review first-party pattern edits in this PR as:
  - evidence about the current supported boundary
  - not automatically as the desired permanent authoring style unless the spec
    says so explicitly

## Construct Buckets

Use the target-language spec as the normative source. The practical review split
for this PR is:

- **Supported**
  - local reactive value expressions in JSX
  - authored helper control flow (`ifElse`, `when`, `unless`)
  - explicit computation callbacks (`computed`, `action`, `lift`,
    `handler`)
  - supported reactive collection callbacks (`map` / `filter` / `flatMap`)
  - top-level pattern-body lowerable value-expression sites such as returned
    object property values, variable initializers, call arguments, array
    elements, return expressions, direct property/element access, and direct
    receiver-method roots
  - callback-local lowerable value-expression sites inside supported reactive
    collection callbacks
  - JSX sink chains over structural array values, for example
    `.filter(...).join(", ")`
  - true-cell `.key(...)`, plus true-cell `.get()` only inside JSX, authored
    helper control flow, or an explicit computation callback
- **Compatibility-only**
  - residual invalid-program callback-container pass-through if an already
    invalid foreign container still survives as plain JS in current emitted
    output
- **Unsupported**
  - foreign callback / imperative container roots like
    `[0, 1].forEach(() => list.map(...))`
  - direct top-level `.get()` reads in pattern-owned code
  - bare top-level dynamic-key traversal like `input[key]`
  - optional-call on reactive receivers
  - statement-boundary imperative structure in top-level pattern-owned code

The key nuance for reviewers: an explicit wrapper such as `computed(() => ...)`
creates a supported computation boundary around the inner value expression. That
does **not** make foreign callback containers themselves part of the language.

## Architecture In One Pass

- JSX is no longer the semantics engine. It is mostly a routing / ownership
  sink.
- Validation and lowering now share more real policy seams instead of
  rediscovering support independently.
- Compute-context interprocedural capability summaries are intentionally
  limited to same-source-file concrete helper bodies; broader expansion is
  deferred.
- Schema behavior is now explicitly split between:
  - inferred `pattern()` result `any` / `unknown` -> diagnostic unless output
    type is explicit
  - semantic `any` / `unknown` is still representable elsewhere when that
    boundary is explicit
  - unresolved generic definition-site type params -> `{ type: "unknown" }`
- `pattern-callback-lowering.ts` is no longer the central junk drawer; major
  responsibilities are split into focused policy and transform files.

## Files To Review

First diagnostic command when a transformer behavior is surprising:

```bash
deno task cf check <pattern-or-fixture>.tsx --show-transformed --no-run
```

- [expression-site-policy.ts](../../../../base/ts-transformers/src/transformers/expression-site-policy.ts)
  - shared expression-site handling decision
- [call-kind.ts](../../../../base/ts-transformers/src/ast/call-kind.ts)
  - call family / ownership / callback-container classification
- [callback-boundary.ts](../../../../base/ts-transformers/src/policy/callback-boundary.ts)
  - shared callback-boundary semantics for context + validation
- [pattern-context-validation.ts](../../../../base/ts-transformers/src/transformers/pattern-context-validation.ts)
  - restricted-context validation and builder placement
- [pattern-body-reactive-root-lowering.ts](../../../../base/ts-transformers/src/transformers/pattern-body-reactive-root-lowering.ts)
  - remaining tracked-reactive body rewrite seam
- [schema-injection.ts](../../../../base/ts-transformers/src/transformers/schema-injection.ts)
  - schema injection, fallback policy, registry-aware recovery

## Compact Schema Matrix

| Case                                                                          | Current rule                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pattern()` result inferred as `any`                                          | error unless an explicit Output type/schema is provided                  |
| `pattern()` result inferred as `unknown`                                      | error unless an explicit Output type/schema is provided                  |
| inline-destructured `pattern(({...}: T) => ...)` vs `pattern<T>(...)`         | equivalent input/result schemas                                          |
| generic helper definition site `wish<T>` / `generateObject<T>` / `new Cell<T>` | degrade unresolved type params to `{ type: "unknown" }`                 |
| explicit-generic builder definition site `lift<T, U>` / `handler<E, S>`       | degrade unresolved type params to `{ type: "unknown" }`                  |
| transformed structural cell values                                            | preserve recovered structure rather than collapsing to `any` / `unknown` |
| reactive array element access `items[index]`                                  | preserve `string \| undefined` precision                                 |
| boolean result schemas                                                        | normalized as plain `type: "boolean"` in current supported cases         |

Primary proof surface:

- [schema-shrink-validation.test.ts](../../../../base/ts-transformers/test/schema-shrink-validation.test.ts)
- [validation.test.ts](../../../../base/ts-transformers/test/validation.test.ts)
- [fixtures/schema-injection/](../../../../base/ts-transformers/test/fixtures/schema-injection/)
- [fixtures/schema-transform/](../../../../base/ts-transformers/test/fixtures/schema-transform/)

## Current Open Review Question

- JSX / render-node schema verbosity
  - current output is semantically consistent, but repeated render-node shapes
    and local `$defs` are still noisy
  - the remaining question is presentation/canonicalization, not core
    correctness

## Explicitly Not In This PR

- removing `/// <cf-disable-transform />` as an explicit opt-out
- call-site specialization for generic helpers
- broader interprocedural capability-analysis expansion beyond the current
  same-source-file concrete-helper slice
- removing deprecated bare `cell(...)` compatibility support

## Fast Review Path

1. Read the two normative specs.
2. Skim this matrix to see the settled schema invariants.
3. Review `expression-site-policy.ts`, `call-kind.ts`, `callback-boundary.ts`,
   and `schema-injection.ts` as the main semantic sources of truth.
4. Use the schema/validation tests and schema fixture directories above as the
   compact proof surface.
