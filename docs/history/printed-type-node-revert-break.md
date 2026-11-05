---
status: historical
created: 2026-09-23
archived: 2026-09-23
reason: "Record of the contract break taken when #7976 was reverted: two patterns return to the result contracts they had before it, against the baselines #7976 recorded."
---

# Reverting #7976: two result contracts return to their earlier shape

#7976 ("read a printed type node as its type, never as a node") changed the
schemas the generator emits for 27 authored programs. It recorded new
baselines for two of them on 2026-09-23:

- `examples/fetch-program-test.tsx`, `20260923T184038Z-XJY1r8MIb3iWMhNG`
- `system/knowledge-graph.tsx`, `20260923T184039Z-rq8KAA-ICBTFDbI6`

In both, `result.$UI` went from `true` to the `JSXElement` shape: a vnode, a
`UIRenderable`, or an object. Other result fields narrowed with it. For
example, fetch-program-test's `url` went from `true` to `{ type: "string" }`.

## Why #7976 was reverted

It merged with a green PR run that predated #7973, which added
`packages/ts-transformers/test/qualified-cfc-metadata.test.ts`. On main that
test failed. The result schema, printed from a callback's inferred return
type, emitted `{ __ct_cfc_any_of__: undefined }` and
`{ __ct_cfc_policy_of__: undefined }` as confidentiality atoms. The argument
schema from the same program carried `{ anyOf: [...] }` and the policy atom.

The generator recognizes `AnyOf` and `PolicyOf` only when it reads a node.
The printed return type had reused the authored `PolicyOf<typeof rules>`
node, and the binding identity lives only in that syntax. The type of
`typeof rules` doesn't carry it. So reading the printed node as its type lost
the policy, and #7976 was reverted until that is fixed.

## What the proof reports

Reverting restores the result contracts each pattern had before #7976, which
every piece created before it holds. Against #7976's baselines,
that widens the result again, and the proof refuses it. It names
`result.$UI` for each pattern, on its #7976 baseline only.

The proof reports one issue per role, so `result.$UI` also stands for the
other result fields #7976 narrowed. None of them is new, though.
`pattern-compat` fails any contract that is not already recorded, and with
these two entries it passes. The reverted contracts are therefore ones that
earlier baselines already recorded.

## What the break costs

A piece created in the hour #7976 was on main holds the narrower result
contract. Its update to the reverted contract widens what the result may
hold. Neither pattern is a required pattern. When #7976 re-lands with its fix,
it records new baselines over these contracts and the narrowing is gated
again from there.
