# CFC render-boundary composition

How nested CFC render boundaries (`<cf-cfc-render-boundary>`,
`<cf-cfc-authorship>`) combine in the HTML worker reconciler
(`packages/html/src/worker/reconciler.ts`, `childRenderPolicyForNode`).

## Invariant: boundaries compose monotonically

A render boundary is a trust gate around a subtree. Nesting one boundary inside
another may only ever **tighten** the effective policy — never relax it. Two
consequences a reviewer can check directly:

- An **inner** boundary cannot widen, shed, or re-permit anything an
  **enclosing** boundary restricted.
- An enclosing boundary's "this subtree is clean" signal (rendered content for
  confidentiality; `textIntegrityState="ok"` for text integrity) must hold for
  **every node it transitively encloses**, not just its direct children.

Violating either is a security bug: the first launders trust (untrusted content
renders under a boundary that was supposed to vouch for it); the second is a
false "verified" over content that failed the enclosing boundary's bar.

## Confidentiality (`maxConfidentiality`)

Composes by **intersection / narrowing**. `narrowMaxConfidentiality` intersects
the parent bound with the boundary's local bound, so an inner boundary can only
lower the ceiling. `declassifyConfidentiality` accumulates as a union but is
gated by the render declassification policy (fail-closed under `deny`).
Regression guard: "preserves an outer unlabeled-only boundary through an
unbounded child boundary" in `test/worker-reconciler-cfc-render-policy.test.ts`.

The ceiling in force at a node gates what reaches the page from that node by
the same fit (`canRenderLabelUnderPolicy`):

- A cell child the ceiling does not admit renders as the blocked placeholder.
- A property whose value is read through a link, or is an object, is read by a
  sink of its own, and the fit is made on the labels that read consumed: every
  document the read passed through, including one behind a link crossed part
  way along the path and one a link inside the value leads to. A property the
  ceiling refuses is not set, and is removed if it was. That covers a cell
  passed as a property (`<span title={cell}>`) and, in a view read from a
  cell, as a pattern's view is, a property that links to one and an object or
  `style` property holding such a link. A literal property is decided with the
  props object it sits in: it is set directly while the ceiling admits that
  object's own label, and read by a sink of its own, like the others, while
  it does not, as when the view or its props are linked from a document of
  their own. An object written inline in a view built outside a cell sends a
  cell it holds as a link, not as the cell's value.
- A `$` binding is made only while the ceiling admits what the worker's read
  of the bound cell, under the cell's schema, consumes. The worker keeps
  reading the bound cell and removes the binding when a write leaves that read
  consuming a label the ceiling refuses. The binding hands the host a live
  handle, and the worker answers the host's reads through it without the
  ceiling: a read that follows a link the worker's read did not, and the
  host's own subscription to the cell, which can deliver the write that causes
  a removal before the removal arrives.

Each decision is made again when what its read consumed changes, labels
included, and when the membership those labels name changes, and only a
change in the decision is emitted. A trusted host component that never shows a
value from a binding, handing the reference to a worker operation and showing
only what that operation answers, declares the binding in
`REFERENCE_BINDING_SINKS` beside the reconciler, and the ceiling does not gate
it. A value it reads through such a binding serves only as a signal to ask the
operation again. `cf-custody-seal` is one, whose dialog shows what the seal's
preparation answers, and `cf-custody-answer` another, which shows the answer
the seal published. The declaration is reviewed like the component itself,
since a component that shows what such a binding holds releases it past the
ceiling.
Regression guards: `test/worker-reconciler-cfc-prop-ceiling.test.ts`.

## Text integrity (`requiredTextIntegrity` / `allowLiteralText`)

Composes the same way — the meet of the parent and inner policies (CT-1796):

- `requiredIntegrity` = **union** of every enclosing boundary's required atoms
  (more enclosing requirements ⇒ stricter).
- `allowLiteralText` = parent `&&` inner (an absent parent is unconstrained); an
  inner boundary can never re-enable literal text an enclosing boundary forbade.
- A block is attributed to **every** enclosing boundary — the policy carries the
  full set of enclosing boundary node ids (`boundaryNodeIds`), and
  `markTextIntegrityBlocked` stamps all of them — so no enclosing boundary can
  stay `"ok"` over content that failed its bar.

Until CT-1796 the text-integrity path **replaced** the enclosing policy at each
inner boundary and attributed blocks only to the nearest boundary, breaking both
halves of the invariant (an inner `allowLiteralText` could re-admit attacker
literals; an outer boundary stayed `"ok"` over a blocked descendant). The
block-attribution machinery (`refreshTextIntegrityBoundaryState`,
`hasTextIntegrityBlockForBoundary`, `markTextIntegrityBlocked`) landed in #4366;
the replace-not-compose policy dated to #3321 (text integrity enforced by
default). Regression guards: the four "nested text integrity …" steps in
`test/worker-reconciler-cfc-render-policy.test.ts` (two mount-time, two reactive
block/unblock).

## Nested pattern outputs

A pattern embedded in another pattern's view reaches the reconciler as one
cell: the parent's `$UI` holds a link to the sub-pattern's result document, and
`renderCellChild` fits that cell's label against the ceiling before rendering
anything below it. A label covering the result document decides the whole
sub-view — the sub-pattern's headings, its controls, and the render boundaries
inside it, which the walk stops short of.

The labels a sub-pattern's result document carries are the ones its own fields
earned. A field aliasing an argument cell carries that cell's label through the
link machinery. A field fed by a lift or a sub-pattern carries the join
that module makes onto its own result (`applyArgumentIfcToResult`, called from
`packages/runner/src/builder/module.ts`), and every module's output cells carry
the join of its input cells' labels (`connectInputAndOutputs`, defined in
`packages/runner/src/builder/node-utils.ts` and called from `module.ts` and
`pattern.ts`), which covers a built-in whose result is written at run time
rather than declared. And under
`cfcFlowLabels: "persist"` the per-transaction join is written as a `derived`
component on each value write target; at `observe` it only reaches a
diagnostic, and at `off` nothing derives it.

No module is excused that input join. A module labeling its outputs below the
join of its inputs makes §8.9.1's flow-precision claim, which that section
holds to trust in the executing implementation for `flow-taint-precision` under
the acting user, and a graph is assembled before there is one. What the join
states is not §8.9.2's measurement: the build transaction reads nothing, so
§8.9.2 applied there yields the empty label, which is the argument the next
paragraph makes for a pattern's own root. It is a static over-approximation of
what any future attempt could consume, and it is the floor rather than a first
guess — it mints a `declared` entry, and a path's effective label is the join of
all its components, so the `derived` component above adds to it and never
narrows it. A label narrower than the join is therefore available only through
§8.9.1's trust gate, and nothing in the runtime evaluates that concept.

The two build-time mechanisms differ in what each ranges over.
`applyArgumentIfcToResult` runs once per module factory, joining the schema
that module declares for its argument onto the result schema it declares — or
onto `true`, for a module that declares none; every node minted from that
factory is given what it returns. `applyInputIfcToOutput` runs once per node,
over that node's own edges. Neither takes a join over a pattern's argument as a
whole, so a field a lift or a sub-pattern produces carries what its own edge
carries: a confidential argument field's label reaches the fields that read it,
and a public field beside it stays public.
`packages/runner/test/cfc-argument-ifc-propagation.test.ts` measures both
halves of that over one result.

A handler's write targets take no build-time label, and that is the division
rather than a gap in it. A handler node is built with `outputs: {}` and the
cells it is handed sit in `inputs.$ctx`, so the per-node join has nothing to
write onto, and the event stream the factory returns is one of those inputs
rather than an output. What a handler writes is decided when it runs, and CFC
§8.12.8 puts the label for it — §8.9.2's conservative join over the attempt's
journal, plus §8.9.3's output labels — in the `derived` component, under
replace-on-overwrite. The `cfcFlowLabels` dial is what persists that component,
and §18.6.3's conformance matrix marks `enforce-explicit` with propagation
`off` a conforming state, because that ladder rung consumes declared policy
alone. Reaching for a build-time stand-in here would put a measurement in the
component §8.12.8 reserves for declarations, which is the join
`factoryFromPattern` stopped taking.

A built-in that writes its own schema over its output's link composes that
label back in rather than replacing it. Four do: `mapWithPattern`,
`filterWithPattern` and `flatMapWithPattern` stamp a result-container schema
onto the cell their node factory has just labeled, and a named aggregate stamps
a scalar one. `schemaCarryingLinkIfc` in `packages/runner/src/cell.ts` carries
the label onto what they write. CFC §8.5.4.3 requires it: a decomposed
collection operation's coordinator taints its own structural writes —
container, membership, order, length — with what its journal consumed. §8.9.2's
propagation takes the output container's confidentiality from the source
container's, through `lengthPreserved` for a map and
`propagateCollectionConstraint` for the two that change length. The label lands
at the container root, which is the conservative shape rather than the
pointwise one: `joinSchema` flattens a source's member-level atoms in with its
container-level ones, so what §8.5.6.1 keeps apart as member and structural
confidentiality arrives together.
`packages/runner/test/list-result-schema.test.ts` measures a labeled source and
an unlabeled one. An aggregate reduces without per-value attribution, so
§8.17.1 gives its scalar the join of its contributors — a count and a sum are
that section's own examples — and
`packages/runner/test/cfc-argument-ifc-propagation.test.ts` measures one.

The declared result schema adds none of its own: `factoryFromPattern` stores
the schema the author declared, so a pattern that accepts a confidential
argument does not thereby label its own view. That division is §8.12.8's. It
gives the `declared` component schema `ifc` declarations and explicit
store-label operations under a monotone discipline, and gives a transaction's
measured dependency to the `derived` component under replace-on-overwrite,
because a ratchet applied to a measurement is the label creep that section
opens by ruling out. A join taken over the shape of an argument schema
measures no transaction, so the declared component is not where it belongs;
the flow join above is. §8.9.1 reaches the same place from the other side, for
the collection helpers it is written about: where a runtime can decompose an
operation, the conservative join is a structural fact of the journal and no
claim is involved. A pattern body reads no value, so the join over its build
transaction is empty by construction.

Two consequences follow. The
render boundaries a sub-pattern declares are reached, so a nested
`declassifyConfidentiality` reaches the parent policy as a union
(`childRenderPolicyForNode`), fail-closed to nothing under a
`"deny"` declassification policy. And the write-policy grant recorded for each
result binding (`recordOutputSchemaPolicyInputs`) is the schema at that
binding's own path rather than one raised by a root entry, which narrows the
grant — the direction that refuses rather than admits.

`packages/runner/test/cfc-argument-ifc-propagation.test.ts` holds each builder
against its own schema, and `packages/runner/test/pattern.test.ts` measures
where the label reaches the result instead.
`packages/runner/test/cfc-builtin-output-ifc.test.ts` holds each LLM built-in
to the input join, at both dial settings. The `cfc-render-policy-demo`
integration test drives the composed case under the ceiling.
