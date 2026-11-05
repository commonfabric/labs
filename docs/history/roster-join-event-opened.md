---
status: historical
created: 2026-09-12
archived: 2026-09-12
reason: "Record of the deliberate contract break taken when the two profile-roster patterns' Join verb stopped declaring an empty closed event."
---

# Profile rosters: the Join verb's event opens

`profile-roster-live-demo.tsx` and `shared-profile-roster/main.tsx` declared
their Join verb as `handler<JoinEvent, …>` with
`JoinEvent = Record<PropertyKey, never>`: an empty object with
`additionalProperties: false`. That was a declaration that the verb takes
nothing, written before the runner enforced it.

The runner now does (`closedWorldEventRejection`, verb contract WS-C, C5):
a payload with any undeclared field against a closed event schema fails
the handling before the body runs. A rendered `<button onClick={join}>`
delivers the serialized DOM event, which always carries `type` and
usually `provenance` and target scalars. So every Join from the button
was refused with "additional property type", the roster stayed empty, and
the page showed nothing. Seen on the fabric-profiles bench on 2026-09-12
(commonfabric-weaver `docs/plans/fabric-profiles-bench.md`, run 1
findings 36 and 37); the lobby's `addSelfToLobby` is `handler<void, …>`
and was never affected.

## Why this could not be done compatibly

The handler reads nothing from its event, so the right declaration is the
lobby's: `void`. But `Stream<void>` is not the same recorded contract as
`Stream<{closed empty object}>`: the compatibility proof reports
`result.join: asCell changed` against every baseline recorded with the
closed shape. Two alternatives were measured and rejected:

- `Record<string, unknown>` compiles to a schema-valued
  `additionalProperties`, which the proof compares as a data contract
  ("additional properties accepted previously would now be rejected").
- `unknown` fails the proof's type-acceptance check ("the candidate no
  longer accepts every previous type").
- A closed object that declares `type` alone would pass both the gate and
  the proof today, and fail again the day the serialized event carries one
  more field.

So the break is taken: the deployed pieces' `join` streams are re-declared
as `void` streams. Nothing held state under the old declaration — the
stream carried no data, and no piece could have joined through it — so
the casualty is the recorded shape only.

## What is accepted

- `profile-roster-live-demo.tsx` over `20260729T022742Z-QNOFVBAs80X9XKZu`,
  path `result.join`.
- `shared-profile-roster/main.tsx` over `20260729T022742Z-MLeLOCqjpbIUoIib`,
  path `result.join`.
