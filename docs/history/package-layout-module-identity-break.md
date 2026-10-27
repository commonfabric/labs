---
status: historical
created: 2026-10-22
archived: 2026-10-22
reason: "Decision record for the contract changes the pattern update gate
  reports when the repository's packages leave `packages/` and the patterns are
  sorted into categories."
---

# Module identities under the new package layout

This change moved the repository's packages out of `packages/`. They now live in
`base/` and `runtime/`, and `connectors/`, `dashboard/`, and `patterns/` moved
to the top level. Each pattern also moved into a directory of its own inside a
directory for its category, in the form `patterns/<category>/<pattern>/`. The
server serves each pattern at its new path. The runtime maps a stored reference
that names a pattern's old path, such as `system:topics/main.tsx`, to the new
path.

## What the pattern update check reports

`deno task pattern-compat` compares each pattern's contract with the contracts
recorded for it in `patterns/baselines/`. A contract describes the pattern's
inputs and outputs, including the information-flow labels on them. The check
fails when a pattern changes its contract in a way that data stored under an
earlier contract would not survive.

Some labels name a module by its _module identity_, a hash of the module's
contents and its name. A module's name is its path. Under a checkout, one
module was named `/packages/patterns/cfc-exchange-rules/direct-release.tsx`
before the move and is named
`/patterns/examples/cfc-exchange-rules/direct-release.tsx` after it. Its
module identity therefore changed, although its source did not.

Two kinds of label name a module this way. A _writer claim_ names the module
whose code may write a field. A _module policy reference_ names the module that
defines the policy a value is held to. The check treats a writer claim's module
identity as one that is expected to change, so it records the new contract as an
addition. A module policy reference holds the identity as part of the label, so
the check reports `ifc changed` for eight patterns, compared with the
baselines recorded for them before the move:

| Pattern                                               | Paths                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `examples/cfc-exchange-rules/blessed-computation.tsx` | `argument.briefs[]`                                                          |
| `examples/cfc-exchange-rules/blessed-object.tsx`      | `argument.briefs[]`                                                          |
| `examples/cfc-exchange-rules/custody-answer-room.tsx` | `argument.policy`, `result.policy`                                           |
| `examples/cfc-exchange-rules/custody-projector.tsx`   | `argument.policy`, `result.policy`                                           |
| `examples/cfc-exchange-rules/direct-release.tsx`      | `result.message`                                                             |
| `examples/cfc-exchange-rules/imported-policy.tsx`     | `result.message`                                                             |
| `examples/cfc-exchange-rules/witnessed-chain.tsx`     | `argument.briefs[]`, `argument.committed`                                    |
| `dev/test/writer-policy/main.tsx`                     | `argument.entries[]`, `argument.frozen`, `result.entries[]`, `result.frozen` |

## The decision

The change is accepted for these eight patterns and these paths. Each label
still names the same policy, defined by the same symbol in the same module,
with the same rules. Two values differ. One is the module identity, which
includes the module's new path. The other is the policy digest, which is a
hash of a description of the policy that includes the module identity.

Seven of the eight patterns demonstrate the Contextual Flow Control (CFC)
specification, and the eighth is a test pattern. The runtime does not start
any of them by name.

The contracts recorded after the move are new baselines. The check compares the
next change to any of these patterns against the identities that the new layout
produces.
