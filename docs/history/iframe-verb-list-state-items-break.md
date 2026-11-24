---
status: historical
created: 2026-10-18
archived: 2026-10-18
reason: "Record of the deliberate contract break taken when the iframe verb list's items moved from its argument into the pattern's own state."
---

# Iframe verb list: the items are the pattern's own state

`iframe-verb-list/main.tsx` landed on 2026-10-17 composing a generated frame,
`frame.tsx`, which held the guest's `state` and `output` cells. A verb in
`main.tsx` could not bind to a cell the frame created, so the items lived
outside the frame: `items` was the pattern's argument, `addItem` pushed onto
it, and the frame handed it to the guest as read-only input.

On 2026-10-18 iframe patterns became one hand-written `main.tsx` that renders
its own `cf-iframe`, with no generated frame. The verb list's `state` is then
the pattern's own cell, and holds both the items and the check marks.
`addItem` writes `state.items`, and the guest is granted that path to read and
`state.checked` to write, as two resources of one `$context` record.

The contract changes in these places, all named in the accepted break:

- `argument.items` is gone. A piece created from the earlier source keeps its
  items in its argument cell, which the new source does not read, so after an
  update its list reads empty, and those items are not carried into `state`.
  The argument declares no field at all, so it also refuses the extra fields
  the recorded argument accepted, which the proof reports under `argument`.
- `result.items` is gone. A caller reads the list as `state.items`.

The break was accepted because the pattern is an example a day old, written to
show the guide's verb section, and the change deliberately leaves deployed
pieces as they are. No vintage fixture records the verb list, so the
state-continuity gate needs no entry.
