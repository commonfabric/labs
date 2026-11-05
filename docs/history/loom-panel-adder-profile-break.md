---
status: historical
created: 2026-09-23
archived: 2026-09-23
reason: "Record of the deliberate contract break taken when the Loom root's Panel gained an optional addedByProfile, a profile link the runtime labels with the principal who added the panel, which the pattern-update gate reads as a narrowed union branch."
---

# Loom: a panel's `addedByProfile` is an optional field the update gate cannot prove

`loom/schemas.tsx` gave each kind of `Panel` (`piece`, `document`, `url`) an
optional `addedByProfile`: a link to the profile under which the person who
added the occurrence acted. Its type carries a write contract:
`WriteAuthorizedBy` names `admitPanel` in `loom/admission.tsx` as the only
handler that may write it, and `RepresentsCurrentUser` with an `ownerPrincipal` of
`CurrentPrincipal` has the runtime label the stored link with
`represents-principal` for the principal whose action wrote it. The runtime
resolves that principal itself, so the label names who added the panel and no
caller chooses it. It follows `addedBy` (`loom-panel-added-by-break.md`), which
is a DID the writer claims and the handlers check only for syntax.

Against the baseline recorded when `addedBy` shipped,
`20260923T232217Z-9unt7nppL26FihSK`, the pattern-update proof reports
`argument.panels[]: a schema alternative accepted previously is not accepted by
the candidate`. It is the finding `addedBy` produced, for the same reason:
`Panel` compiles to an `anyOf` of three open objects, and the proof does not
apply its evolution allowance for a new optional property inside a union
branch, so each branch reads as narrowed. The two earlier baselines already
carry an accepted break on the same path.

## Why this could not be done compatibly

The type is the mechanism. The write contract and the label live in the
field's schema, and the gate passes only for a field typed `unknown`, which
would carry neither: any writer could set it and nothing would name who did.
Putting the link in a document outside the union would move the contract out
of the branches, but a panel would then point at a separate attribution
document, and that pointer could be moved to another panel's attribution. The
field is where the label cannot travel away from the panel it describes.

## What the break costs

Nothing deployed holds state under the old shape that the new one refuses. No
writer has stored `addedByProfile` on a panel before this change, and a stored
panel without the field validates against the candidate, where it is optional.
The break is a statement about the proof, not about a deployed piece.

The same change made the three streams that add a panel (`addPiece`,
`addPanel`, `duplicatePanel`) bindings of the one handler the write contract
admits, so each takes `PanelAdmission`, which accepts `as`, `addedBy`,
`piece`, `panel` and `before`, all optional. The proof reports at most one
issue per role; the result role reports none.

A shared Loom's root is not one of the patterns that update automatically, so
existing roots keep their source until someone replaces it; replacing it with
`cf piece setsrc` meets the same refusal and needs
`--dangerously-allow-incompatible-schema`.

The entry in `tasks/pattern-compat-accepted-breaks.ts` forgives exactly the
one `(loom/main.tsx, 20260923T232217Z-9unt7nppL26FihSK)` pair on the one path
the proof names, and the baseline recorded with this change is one no entry
names, so the next change to the Loom root is gated again against the
shape this break left behind.
