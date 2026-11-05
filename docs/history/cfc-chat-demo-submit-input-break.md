---
status: historical
created: 2026-09-23
archived: 2026-09-23
reason: "Record of the deliberate contract break taken when the CFC group chat demo's fields became `cf-submit-input`s and its drafts were removed."
---

# CFC group chat demo: fields submit on Enter

Every write in `cfc-group-chat-demo` (saving a name, sending a message, adding
a room) is a `TrustedActionWrite`, which requires a trusted DOM gesture on the
write's reviewed surface. Each of those fields was a `cf-input` beside a
`cf-button`, bound to a draft cell that the handler read. Enter in a `cf-input`
only emits the component's own `cf-submit`, a `CustomEvent` whose `isTrusted`
is false, so the renderer attaches no provenance to it and the write would be
refused. The inputs were also on `cf-input`'s default 300 ms debounce, so a
submit that did not move focus could act before the field's text reached its
draft.

Each field and button pair is now a `cf-submit-input`. Enter in its field makes
the browser fire a trusted click on its submit button, the same gesture the
button gives, and the click carries the field's text as `target.value`. The
three handlers read that text. The drafts go: `profileDraft`, `messageDraft`,
`hostMessageDraft`, and `roomDraft`, with their `set…Draft` streams. The host
lookalike panel becomes a `cf-submit-input` outside every trusted surface.

The demo is a prototype being iterated on, and its contract was not treated as
something to preserve. Pieces running an older version lose only draft text.

## What is accepted

`cfc-group-chat-demo/main.tsx`, over every recorded baseline, for the removed
draft fields and setter streams and the re-declared `saveProfile`,
`sendTrustedMessage`, `addTrustedRoom`, and `hostLookalikeSend` streams. Five
of the six baselines already had an entry for an earlier break, and an entry
is one per baseline, so those entries were extended to name these paths as
well. The sixth, `20260923T205929Z-mHuHgI9LlBLCu53t`, has an entry of its own.

## Tests that used the drafts as a subject

Three runtime tests drove the demo's drafts without being about the demo.
`cellset-lww.test.ts` (blind last-write-wins sets, compare-and-set pushes, and
a typed name surviving the save's echo), the chained-event serve-order gate
test, and two scope-isolation checks now drive
`packages/patterns/integration/fixtures/drafted-chat`, which keeps the
draft-then-commit shape they pin, without CFC. The chained-event test is now
`drafted-chat-chained-event-gate-multi-runtime.test.ts`, and the scope checks
are `drafted-chat-scopes-multi-runtime.test.ts`.
