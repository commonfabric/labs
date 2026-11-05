---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Measurement behind removing the pattern-level CFC output walk: where its `setSchema` was swallowed, what the swallow was hiding, and what the three affected patterns lost."
---

# The pattern-level CFC output walk (#7220 follow-up)

`applyInputIfcToOutput` walks a value tree and writes the least upper bound of
its inputs' `ifc.confidentiality` onto the link schema of every `Cell` it
reaches, through `Cell.setSchema`. It had three callers: one per node, from
`connectInputAndOutputs`, and two per pattern, from `pattern()` and from
`factoryFromPattern`. Inside the walk, `setSchema` was wrapped in a bare
`catch {}` whose comment said the cell was a computed or derived output whose
schema had been fixed at construction.

This records what measurement found, and why the two pattern-level calls went
the way of the result-schema root join that
[`pattern-result-ifc-contract-break.md`](pattern-result-ifc-contract-break.md)
covers.

## Where the swallow fired

`setSchema` throws for a cell that carries a cause or a link. A module's output
is neither: `createNodeFactory` mints it with `reactive()` immediately before
wiring the node, so the per-node call never reached the `catch`. The cells that
did reach it were the ones a pattern names. `ReactiveVariableForTransformer`
gives a cause to every `const`-bound reactive in a pattern body — the
variable's own name — and to each field of the returned object literal, as
`["__patternResult", <key>]`; a hand-written `Cell.for(...)` or `Stream`
carries one too.

One class of field is left out, and it is the class that decides which
patterns this change moves. `getStablePropertyName` returns nothing for a
computed property name whose expression is an identifier, so `[NAME]:` and
`[UI]:` — the two fields a pattern writes with an imported symbol — receive no
cause, and neither do the cells reached through the view tree under `[UI]`.
Those are the bindings the walk could still label, which is why the corpus
moves at all rather than not at all.

Instrumenting the walk and running `deno task pattern-compat` over the 412
authored pattern files recorded 206 swallowed attachments, every one on a cell
carrying a cause — so every one from a pattern-level call, since all three of
`connectInputAndOutputs`'s call sites hand it either a freshly minted
`reactive()` or an empty object. The same instrumentation under the runner's
own unit suite recorded none, which is why the swallow left no trace: unit
tests build their patterns without the transformer that mints the causes.

## What the swallow was hiding

Letting the attachment through, by narrowing `setSchema`'s guard to a
materialized link, adds labels rather than removing them. In
`cfc-render-policy-demo`, the cells that gain a
`Resource(SensitiveHealthRecord)` clause are `revealSensitive`, the `reveal`
and `conceal` streams that write it, and the `buttonLabel`, `revealState`,
`trustedContentStyle` and `trustedPlaceholderStyle` presentation cells. Those
are the controls the demo exists to drive, and a label on them is denied at the
display ceiling — the defect #7220 was filed for, one level below where it
removed it.

So the swallow was not losing a label the system needed. It was removing, for
named cells only, a join taken over the shape of a pattern's whole argument
schema at a point where the build has read nothing — which is the join
`pattern-result-ifc-contract-break.md` reads CFC §8.12.8 as placing in the
derived component rather than the declared one. Whether a given cell escaped
turned on how its author had written the field that binds it, which is what
made the behavior arbitrary rather than merely coarse.

A second consequence showed up while this was being measured, and was settled
elsewhere before it landed. `connectInputAndOutputs` then skipped the join for
a module declaring `propagateInputIfc: false`, which `llmDialog` alone did; its
output cell carries no cause, so the pattern-level walk labeled it anyway, over
the pattern's argument rather than the node's inputs. Removing the walk would
have left that built-in's output with nothing. #7288 removed the flag instead,
making the per-node join unconditional, so by the time this change landed the
case had a carrier of its own.

## What removing the pattern-level calls changed

Dumping the serialized form of all 327 patterns that export one, before and
after, shows three files change and nothing gains a label:

- `cfc-input-cell-demo/briefing.tsx` — the binding for `argument.city`, a
  public field, loses the `demo-secret` clause it had borrowed from its
  confidential sibling. The pattern's own text says the difference between its
  two results "lives in each cell's own derived label".
- `cfc-trusted-component-examples/disclaimer-examples.tsx` and its `main.tsx` —
  the `$NAME` cell of the three disclosure hosts loses one clause each: a
  `prompt-influence` caveat, a `Resource(SourceProvenance)` atom, and a
  `fact-check-required` caveat over `Resource(ExternalClaim)`. `$NAME` is
  `computed(() => title.get())`, whose only input is the unlabeled `title`.

`deno task pattern-compat` reports the same findings before and after: a
pattern's update contract is its argument and result schema, and these labels
sit on the bindings inside its graph. No vintage fixture records any of the
three patterns.

With the pattern-level calls gone, the walk reaches only cells minted for the
node it is labeling, so the `catch` had nothing left to catch and was removed
rather than kept as a silent skip.

## The edge that takes no build-time label

Adversarial review against the CFC specification found one edge that takes
no build-time label at all, which makes the summary "each result field
carries what its own edge carries" false as written. A handler node is built
with `outputs: {}` (`handlerInternal` in
`packages/runner/src/builder/module.ts`), and the cells it is handed sit in
`inputs.$ctx`. So `applyInputIfcToOutput` has nothing to write
onto for a handler, and a module's declared result schema is not a write
target's schema either. A cell a handler fills from a confidential argument
field carries no label either builder carrier put there.

Measured on a pattern whose handler reads a confidential argument field and
writes an internal cell that the result binds:

| result binding | before, causeless cell | before, `.for()` cell | after |
| --- | --- | --- | --- |
| the handler's write target | labeled | unlabeled | unlabeled |
| a public sibling argument field | labeled | labeled | unlabeled |
| the confidential argument field | labeled | labeled | labeled |

The middle column is the one the corpus runs under: the transformer gives
every `const`-bound reactive in a pattern body a cause, so the swallowed
`setSchema` had already left that cell unlabeled for every authored pattern.
Removing the walk changes nothing there; what it changes is that the outcome
is now the design rather than an accident.

Reading that as a gap to close at build time was the first response, and
checking the spec is what corrected it. §8.12.8 assigns §8.9.2's conservative
join and §8.9.3's output labels to the `derived` component under
replace-on-overwrite; what a handler writes is measured when it runs, so the
declared component is not its carrier. §18.6.3's conformance matrix settles
the deployment question: `enforce-explicit` with propagation `off` is marked
conforming, and the text says why — that rung "consumes only declared policy,
so it is conforming at any dial position". Giving the per-node walk a handler's
writable `$ctx` members would have put a measurement in the declared
component, which is the join `factoryFromPattern` stopped taking.

## The label the list ops were writing over

Adversarial review of the removal turned up a second place a label went
missing, which the blanket walk had been papering over for one of its two
sub-cases. `mapWithPattern`, `filterWithPattern` and `flatMapWithPattern` each
call `result.setSchema(listResultSchema(...))` on the cell their node factory
has just labeled. `setSchema` replaces a link's schema, and `listResultSchema`
carries no `ifc`, so the label went out with it. Measured on a pattern
declaring a confidential array argument: the direct alias carries
`confidentiality: ["secret"]`, and `notes.mapWithPattern(...)` carried none.

That loss predates this change — a source labeled by something other than the
pattern's argument lost it either way — and the blanket walk only re-attached
the argument-sourced case, and only for a causeless cell. `listResultSchemaFor`
in `packages/runner/src/cell.ts` now composes the container schema with the
label already on the link. No pattern in the corpus maps over an argument its
schema declares confidential, so the serialized form of all 327 is unchanged by
this half.
