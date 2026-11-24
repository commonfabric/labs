# Share-space declassification experiment

## Why

In the 2026-11-24 ACL meeting, Robin, Berni and Alex asked a question. Can a
pattern take data that is secret to its owner, copy a live slice of it into a
second space B, and release that slice to whoever can read B? The running
example is the last five minutes of Alex's location, as a step toward sharing a
pattern that shows connector data. If the pattern language cannot say it, the
question becomes what is missing. Coordination is on the Topics board, top/3599.

These files model that case with `cf test`. No real location data is involved.

## What is here

| File                | What it is                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.tsx`        | The two source labels: `OwnerOnly` (`User{owner}`, the shape loom's location connector writes) and `OwnerLocation` (an owner-authored policy). Also the blessed function `recentFixes`, the only output the policy releases. |
| `share.tsx`         | The share pattern. It reads the owner's fixes and publishes the window into `shared`, a store that admits only unlabeled values, so B's access list alone decides who reads it.                                              |
| `share-policy.tsx`  | A policy for B itself: readable by the readers of the space the label is created in (`HasRole(reader, THIS_POLICY.subject)`).                                                                                                |
| `share-readers.tsx` | The share pattern with its store under `share-policy.tsx`: "readers of B" rather than "anyone the value reaches".                                                                                                            |
| `main.test.tsx`     | The four cases below. Each share runs in a new space that grants everyone READ.                                                                                                                                              |
| `readers.test.tsx`  | The labeled store, which `cf test` can only partly decide (finding 4).                                                                                                                                                       |

Run:

```sh
deno task cf test patterns/dev/test/share-space-declassify/main.test.tsx
deno task cf test patterns/dev/test/share-space-declassify/readers.test.tsx
```

Both run under `enforce-strict` CFC with flow labels persisted. Handlers run on
the server-execution serving loop, which is the `cf test` default.

## Findings

1. **Level 1 works today, if the owner's data carries an owner-authored
   policy.** The share pattern, placed in a new space with
   `Pattern.inSpace(undefined, { grants })`, publishes the blessed window into
   an unlabeled store there. The policy module installs in B without any extra
   step. A copy computed by any other function is refused. B's access list then
   decides who reads the window.
2. **Connector-labeled data cannot be released by any pattern.** Loom labels
   location rows `User{owner}`
   (`src/lib/connectors/loom_context_location/labels.py`). An exchange rule
   applies only to the clause of its own policy (`appliesTo: THIS_POLICY`).
   There is no rule, grant or owner declassifier a pattern can write that
   releases a bare `User{owner}` clause, so the publish is refused. An
   adversarial review found no idiomatic route around this. Two near misses:
   - `cf cell set-label --dangerously-allow-lowering-confidentiality` releases
     one stored path once, and every new fix arrives labeled again.
   - The custody seal and `cf-share-snapshot` release one snapshot, through a
     host gesture.

   The fix belongs where the label is written: have the connector label rows
   with a policy the owner controls, such as
   `AnyOf<[User{owner}, PolicyOf<ownerLocationRules>]>`, rather than a bare
   `User{owner}`. Or build what specs#40 sketches (owner-trusted transformers;
   `docs/specs/cfc-exchange-rules-authoring-extensions.md`, SC-37), a rule that
   targets `User(P)` guarded by the owner's consent.
3. **A pattern can name other people, but only at creation or by a gesture.**
   `inSpace()` grants take DIDs computed at run time, so one share space per
   person works (Robin's pairwise spaces). `grantSpaceAccess()` and
   `revokeSpaceAccess()` change the access list of a space that already exists,
   but only from a trusted gesture. No computed path can change who reads, so
   "whoever I meet in the next 15 minutes" (level 3) has no route today. It
   needs either a non-gesture access-list writer the owner consents to once, or
   a grant whose audience is read from a cell. Both are decisions for Berni
   rather than missing idioms.
4. **"Readers of B" rather than unlabeled: expressible, but unverified.**
   `share-readers.tsx` types its store with B's own policy, and the blessed
   window lands there. Two things limit what this shows:
   - The store has no ceiling, so a plain copy lands too. Exchange rules release
     at a check (a ceiling, a display), not by rewriting the stored label, and
     `inspectConfLabel` shows two clauses for both copies.
   - Whether B's readers see the blessed copy and not the plain one is decided
     at their display, which `cf test` does not run. Neither is the subject of
     B's policy shown to be B: the atom's subject is stored as a commitment
     (`{digestOf}`), which a pattern cannot compare to a DID.

   Settling it needs a browser test with two identities.

   An adversarial review also reports that adding a ceiling
   (`MaxConfidentiality<…, [PolicyOf<rules>]>`) to the store refuses the store's
   creation.
5. **A pattern cannot write `Space(B)`.** No type-level placeholder exists for
   "this space", only `CurrentPrincipal`. Loom's replica copies
   (`anyOf(User{owner}, Space(loom))`, top/3483) are written from outside the
   pattern language.

## Runtime behavior found along the way

- `Pattern.inSpace()` called in a pattern body places the piece in the body's
  own space, silently. Only a call from an action or handler creates a new
  space. Every share here is therefore created by an action.
- One commit that both writes a labeled value and creates a store with a ceiling
  gets refused ("maxConfidentiality failed at /shared"), so the sources here
  start empty and are filled by a step of their own.
- `inspectConfLabel` fails `cf test`'s idempotency replay: each run writes new
  documents for the atoms it returns.
