---
status: historical
created: 2026-11-12
archived: 2026-11-12
reason: "Review snapshot: the contradictions found by reading the seven compiled
pattern language documents against each other at labs 68c271aafd, after every
document had been reconciled."
---

# Compiled pattern language: second cross-read of the seven documents, 2026-11-12

This is the record of one review. On 2026-11-12 the seven documents under
`docs/specs/compiled-pattern-language/` were read against each other at labs
commit `68c271aafd`. Earlier that day each document had been reconciled with
the others and with the project owner's rulings, by one author per document,
after the [first cross-read](cross-read-2026-11-11.md). The authors worked
from lists of corrections and from each other's reports, some in parallel, and
nobody had read the documents against each other since. The review lists every
place where two statements cannot both hold, where a statement contradicts a
ruling, where one document assumes something of another that the other does
not provide, where a reference points at the wrong place, where an open
question has been answered, and where a rule that an implementer needs is
stated nowhere.

Nothing in the seven documents was changed by the review. The questions it
leaves for the project owner, and how its corrections were made, are in the
continuation plan,
[`docs/plans/compiled-pattern-language.md`](../../../plans/compiled-pattern-language.md).

## How to read this record

The record has five sections, each one reader's report on one seam between
documents, in that reader's words and first person:

1. `plan-and-label-templates.md` against `footprint-analysis.md`;
2. `plan-and-label-templates.md` against `execution-and-storage.md`;
3. `plan-and-label-templates.md` against `scheduler-and-serving-loop.md`,
   with the effects of `builtin-inventory.md`;
4. `execution-and-storage.md` against `scheduler-and-serving-loop.md`;
5. the overview, `language-subset.md`, and `builtin-inventory.md` against
   each other and the rest.

Findings are numbered by section: 1.1 to 1.13, 2.1 to 2.19, 3.1 to 3.18, 4.1
to 4.18, and 5.1 to 5.17. Within a section they are ordered by weight. Each
names the documents and sections on every side, which side governs, the
smallest correction, and one of three weights: it blocks an implementer, it
misleads a reader, or it is wording only. "Governs" follows the continuation
plan: the owner's rulings govern everything, `plan-and-label-templates.md`
governs the records and the label rules, each other document owns its
subject, and a detailed document governs the overview. Each section ends by
stating what the reader traced and found consistent and what the reader did
not read in full.

The readers worked at the same time and did not see each other's findings,
so two sections can report one defect from two sides. The ones that do are
1.8 and 2.11; 2.2 and 4.1; 2.4 and 3.1; 2.8 and 4.1; 2.15, 3.18, 2.17, and
3.13; 3.5 and 4.10.

Abbreviations: OV is `README.md` (the overview), LS `language-subset.md`, PL
`plan-and-label-templates.md`, BI `builtin-inventory.md`, FA
`footprint-analysis.md`, ES `execution-and-storage.md`, and SS
`scheduler-and-serving-loop.md`. "The plan" is the continuation plan, and
"the Decided list" is its list of the owner's rulings. A question number
after a document's abbreviation is an entry of that document's
open-questions section.

Where a finding says "by source", the reader checked the current system and
names the file and function. Every other statement about the current system
in the seven documents was left unverified by this review.

## 1. `plan-and-label-templates.md` against `footprint-analysis.md`

I read `plan-and-label-templates.md` (PL) and `footprint-analysis.md` (FA)
in full at commit `68c271aafd`, and the plan's "Decided", "Open, and needing
the owner", "Open, and not needing the owner", and "Known limits". For each
record type, field, and variant FA says it emits I opened its declaration in
PL §1.1, and for each label rule FA relies on I opened the PL section it
cites. I checked the two FabriChat examples against each other and against
the source of `sendInto`, `attachmentsIn`, `checkedReply`,
`threadTitleRecord`, `resolvedProfile`, and `commitEdit` in
`patterns/system/fabrichat/room-records.tsx`, and of `threadTitles`,
`messageFacts`, `threadTitleOf`, and `bodyText` in `room.tsx` and
`message-row.tsx`. I opened `language-subset.md` (LS) and
`builtin-inventory.md` (BI) only where one of the two documents cites them
for a fact a finding depends on.

### 1.1 A reference taken from a path with `*` is recorded as `passes`, which gives it no label of the choice

- FA §3.8, "`Body.outputs`": "one projection of container, handle, or
  reference type gives `reference: { passes }`, naming that projection's
  `identity` entry", and only "alternatives that are all such projections
  give `reference: { oneOf }`". FA §2.1 says of a projection that "The path
  may hold `*` segments and handle hops". By FA §3.4 the result of `filter`
  or of a `map` whose callback returns its element is "A bag of `v/*`", and
  by the table of §3.8 a bag is treated as "The member, by this table". So
  a result or written path that holds an element the body picked out of a
  list is the one projection `list/*`, and FA records `passes`. The same
  holds for `rows[i]`, which §3.1 gives as the projection `v/*`.
- PL §1.1, `BodyOutput.reference`: "`passes`: the reference at this path is
  always one reference the body was given ... `oneOf`: it is always one of
  several such references." PL §3.9: a reference passed through "acquires
  no label from the body", and a reference chosen among inputs has "the
  `slot` of the one actually returned, joined with the body's `derive`
  template as the label of the *choice*". PL §1.1, `HandleReads`: "A slot
  whose path has a `*` stands for every handle those positions hold."
- PL §6.2 records the case as a choice:
  `w2  handle b2  */attachments/*   one of e3`, with "An attachment link
  carries its own label plus the handler's template as the label of
  having been chosen." By source,
  `attachmentsIn` returns `links.map(...)` of the resolved entries, which
  is a bag of `event.attachments/*` under FA's rules. FA §12.5 says
  "Applying this analysis to the source gives that record", and FA §3.8 as
  written gives `passes e3`.
- The runtime's identity check does not catch it: every reference the `*`
  slot stands for is one "the body was given" at that slot. With `passes`,
  which element the body put at the path, by a predicate or an index
  computed from other inputs, is in no label.

**Governs:** PL, for the label rule (§3.9) and by its own example (§6.2).

**Correction:** FA §3.8: a projection whose path has a `*` segment gives
`oneOf` naming that entry, never `passes`; say the same in §6.5 and §8.5.
PL §1.1, comment of `BodyOutput.reference`: `passes` names an entry whose
path has no `*`, and an entry with `*` is named in `oneOf`.

**Weight:** blocks an implementer.

### 1.2 An input requirement on a path the body reads dynamically, or on a computed input, has no slot to list

- PL §4.4: "A constraint that today is checked against a transaction's
  reads becomes a constraint on slots or on a write edge." "The slots a
  `requiredIntegrity` or `maxConfidentiality` constraint lists are the
  slots of the body's footprint whose path overlaps the annotated path".
  `Constraint.slots` is `readonly Index[]` into `Plan.slots` (§1.1). PL
  §4.4 calls the change deliberate on the ground that "The set is a subset
  of today's, so a write is refused less often", and §7.4 lists "Gating
  sets" as resting on the compiler.
- FA §7.2: "Every other read through a handle is **dynamic**: the handle is
  listed in `Body.handles` with its read envelope". Such a read has no
  slot. FA §11.4 counts 401 conditional reads and 116 through a handle not
  anchored, of 1,201. FA §1.1: an input bound to a value the instance
  computed "gives entries of `Body.computed`", which are not slots either.
  FA never mentions a constraint.
- Today `verifyInputRequirements` quantifies over journaled reads, the
  ones through cells included (PL §4.4, table). Under the two documents
  together, a `requiredIntegrity` or `maxConfidentiality` annotation on a
  path that a body reads only through an entry of `Body.handles`, or only
  in a computed input, yields a constraint with an empty slot list, and
  the gate is not evaluated. That is not one of the two exceptions of PL
  §3.1, and it is not what "the slots the guarded write depends on" says.
- What I am unsure of: whether the read envelope
  (`HandleReads.envelope`, a schema) is meant to carry the annotation so
  that the journaled read is gated as it is today. Neither document says
  so.

**Governs:** PL (constraints, §4.4).

**Correction:** PL §4.4 and `Constraint` in §1.1: say what a constraint
lists where the annotated path is read through an entry of `Body.handles`
(for example the entry, with the gate evaluated on the journaled reads the
envelope admits at the path) and where it is an entry of `Body.computed`
(the entry's template). FA §7.3: say that the envelope keeps the label
annotations of the paths it admits, if that is the form PL chooses.

**Weight:** blocks an implementer.

### 1.3 A handle or a reference below a hop whose read is dynamic: FA names an `identity` entry the record does not have

- FA §2.1: "`event.message` is an anchored handle, and so is
  `state.composer->editing`, which is reached through one hop." FA §6.2:
  "**Static.** The handle is an anchored handle ... and the path below it
  has only static segments. The target is a `WriteEdge` ... it names the
  handle's `identity` entry". FA §3.8 gives `reference: { passes }` for
  any one projection, "naming that projection's `identity` entry", and
  says an entry is either "a slot of `Body.reads`" or "an entry of
  `Body.computed`". FA §8.5 calls a value passed on unchanged "a value the
  body read from an input or through a handle", and has `reference` name
  "the `identity` entry of the one projection".
- FA §7.2 makes a read at `h->q` static only when "the `get()` or
  `sample()` is unconditional". Where it is conditional, what the body
  observes below the hop is in the read envelope of an entry of
  `Body.handles` and is no entry of `Body.reads`. FA §7.1 states this
  condition for a resolution ("where it has a hop, the read that reaches
  the operand is static (§7.2)"). §6.2, §3.8, and §8.5 do not state it.
- PL §1.1, `WriteEdge`: "`slot` is the handle's `identity` slot". PL §3.9:
  "A handle the body finds by a read through a listed handle has no entry
  of its own, because no slot names the place where it is." PL gives such
  a handle a `WriteEnvelope` whose slot "is in no `reads`", and no
  `WriteEdge`. PL §8, question 2: "A reference the body found by reading
  through a handle is not an input slot. *Assumed:* it gets the `derive`
  template."
- So for `composer.get().editing.set(x)` after an early `return`, FA §6.2
  says static target and write edge, and PL has only the envelope form.
  In a `lift` or a `computed` the two readings differ on whether the body
  is a materializer (FA §6.3). For a reference the body passes on, writes,
  or binds from below such a hop, FA says `passes` and there is no
  `GivenReference` to name; PL's question 2 covers a result path and is
  not answered in FA, and neither document says what `Binding.state`
  records (`capture`, `reference`) for a container read through a dynamic
  read and bound unchanged.

**Governs:** PL, for the record forms.

**Correction:** FA §6.2 "Static": add that every hop on the handle's path
is a static read by §7.2; otherwise the handle is one "found by reading
through another handle" and the write is listed by an envelope. FA §3.8:
a projection below a hop whose read is dynamic gives no `reference`, and
the path takes the body's template (PL question 2, which can then be
marked answered). FA §8.5: such a container has `capture: "link"`, no
`reference`, and the body's template, as a `Created` value has.

**Weight:** blocks an implementer.

### 1.4 A `value` entry and the handles inside its subtree

- FA §2.2: "A `value` observation at a container covers its subtree down
  to, and not through, each position that holds a handle. At such a
  position it is an `identity` observation." FA §9.1, agreement for
  `value`: "The values at `p` are equal, down to each position that holds
  a handle, and the references at those positions are the same". FA §5.4:
  a `value` entry "does not cover an `identity` or a `labelMetadata`
  entry".
- PL §2.2, table: a `value` slot consumes the entry classes "`value`,
  `shape`, `enumerate`", and `followRef` is consumed only by an
  `identity` slot. PL §3.9, "Handles": the runtime hands a body a handle
  "for every position of a handle type that its record names: an
  `identity` slot of `reads`, an `identity` entry of `computed`, the
  handle of a write target or of a write envelope, and every entry of
  `handles`."
- FA does not say that the analysis emits an `identity` entry at each
  handle position inside a subtree it records as `value` (W2, W3, W4,
  W5). If it does not, the body observes which references sit there (S1
  compares them) while the slot's label holds no `followRef` entry for
  those positions, and PL's list gives the runtime no ground to hand the
  body those handles. If it does, FA §2.2 and §5.4 should say so, with
  `*` where the position is under one.
- What I am unsure of: PL §2.2 also says a `value` slot "consumes what a
  recursive read consumes", which may be meant to include the pointer
  read at a handle position. The table beside it does not.

**Governs:** PL (the label of a slot, §2.2; what a body is handed, §3.9).

**Correction:** FA §2.2: a `value` entry over a subtree is accompanied by
an `identity` entry at each position of handle or reference type the
subtree's type has, and §2.3 keeps them. Or PL §2.2 and §3.9: a `value`
slot consumes `followRef` at, and hands the body the reference at, each
such position inside it.

**Weight:** misleads a reader.

### 1.5 "Reading back what the body itself wrote records nothing" does not hold where the created thing outlives the run

- FA §7.5: "A cell or an instance the body created is not an input.
  Reading back what the body itself wrote records nothing. The one
  exception is an instance a `lift` or a `computed` made on an earlier
  evaluation". FA §8.1: in a `handler` or an `action` "a read through the
  link in the same invocation finds no value and records nothing".
- PL §1.3, table, "A handler, `.for(tag)`": "The handler's instance and
  the tag, so that different events name the same thing" (assumed; plan,
  question 19). PL §3.14: "a later event that names the same instance
  creates nothing". A later event's read through the returned link then
  finds the result of an instance an earlier event made. FA §8.2 gives a
  cell created in a handler with an explicit cause
  `identifiedBy: "cause"`. If PL's row covers that cell as well, which
  its text on "A cause that a body gives explicitly, to `createCell` or
  with `.for(...)`" suggests, it is the same case, and PL §3.14's "In a
  handler the cell is new on every invocation" does not hold for it.
- PL §3.14: in a `lift` or a `computed`, "When the cause is a constant
  ... the cell is a `StateCell` of the plan". The cell outlives the
  evaluation, and a later evaluation that reads it back finds what an
  earlier one, or a holder of the link, wrote.
- In both cases the read is in no entry of the footprint and is not
  journaled, so S1 (FA §9.1) fails for it and the body's template does
  not cover it. PL §1.1 allows `HandleReads.handle: { call }` only "In a
  body that is re-evaluated" and only for an `instantiate` site.
- This extends plan question 19: under today's rule (every identifier a
  handler mints derives from the event) FA's sentence holds for a
  handler; under PL's assumption it does not.

**Governs:** PL §1.3 and §3.14, pending the owner on question 19.

**Correction:** FA §7.5 and §8.1: a read through a link or a cell made at
a site with an explicit cause or tag is dynamic, in a handler as in a
computation, and is an entry of `Body.handles` that names the site. PL
§1.1, `HandleReads.handle`: let `call` name a `createCell` site and a
site of a handler that is `identifiedBy: "tag"` or `"cause"`.

**Weight:** misleads a reader.

### 1.6 How much a copied scalar holds

- PL §3.14, "How much a copy holds": "A copied path holds what the bound
  handler observes of it and no more", with the rows "`shape` | A
  stand-in of the same kind" and "No slot at or below a path | Nothing",
  and "The copied values that enter the identity of the stream (below)
  are the copy as narrowed". PL §3.15 applies the same table to a copied
  capture of a pattern closure.
- FA §8.5, table: "A scalar | Any | `value` | The value", where the second
  column is "The handler's footprint there". FA §8.1: "A scalar records
  `value` and is copied." LS §5.2 also narrows only a computed container.
- For a scalar the handler only tests for presence, PL has the binding
  hold a stand-in and two bindings that differ in the value be one
  stream; FA has the body read the value, the binding hold it, and (by
  PL's identity rule applied to "The value") two streams.

**Governs:** PL (what a binding holds, and the identity label).

**Correction:** FA §8.5 and §8.1: apply the rows for a computed container
to a scalar path too (record the class the handler's footprint has there,
and nothing where it has none). Or PL §3.14: say the table narrows a
container the body computed and that a scalar is copied as a value.

**Weight:** misleads a reader.

### 1.7 The record of `commitSend` in PL §6.2 is not the one FA's rules give

- FA §12.5: "Applying this analysis to the source gives that record." FA
  §13, request 13: "Met: §6.2 there lists the handles of `commitSend` as
  this analysis finds them".
- PL §6.2, `T_send`, has one `dynamic` node of kind `link`:
  "dynamic(link through b2)". By source, `attachmentsIn` calls
  `link?.resolveAsCell()` on each element of `event.attachments` and
  `isInRoomOf(room, entry)`, and `checkedReply` calls
  `reply.thread?.resolveAsCell()`, `reply.quotes?.resolveAsCell()`,
  `isInRoomOf(messages, target)`, and `equals(quoted, root)`. Each is
  conditional, so by FA §7.1 each is a journaled resolution, "a dynamic
  read of kind `link` through the entry", and by PL §3.16 "a `dynamic`
  node of kind `link` through that slot". `T_send` lacks the nodes
  through `e3`, `e5`, and `e6`. FA's own listing for `commitEdit`
  (§12.3) keeps such links apart from the reads through the handles:
  "links followed below event.message, state.message, state.room".
- PL §6.2 lists two reference edges, `w1` and `w2`. The pushed value also
  holds `replyTo: stored`, where `stored` is `{ thread: root }` and
  `{ quotes: quoted }`, each the handle a journaled `resolveAsCell()`
  returned. By FA §6.5 and §3.8 each is a `WriteEdge` of its own at
  `*/replyTo/thread` and `*/replyTo/quotes` whose `reference` names the
  plain entry (`e5`, `e6`).
- PL §6.2: `B2`'s "computed input is `titles/* : value`". By source,
  `threadTitleOf` reads `titles[key]` on a `Record<string, string>`. FA
  §3.1 records for that "`enumeration` at `v`; `value` at `k`. Widening
  W1", so the record has `titles : enumeration` too, and an entry of
  `widenings` with `Widening.computed`.
- PL §6.2 lists `m4  element   authorProfile            : shape` among
  the slots that "cross the element's link". By source `authorProfile`
  is `ProfileCell`, a position of handle type, so by PL §2.5 and FA §7.2
  the slot has `inPlace`. PL says the in-place slots are the ones the
  slice leaves out.
- None of these changes an instantiated label with FabriChat's labels.

**Governs:** PL §3.16 and FA's rules, over the example.

**Correction:** PL §6.2: add `dynamic(link through e3)`, `(e5)`, `(e6)` to
`T_send` (and to the first row of §6.4), the two reference edges,
`titles : enumeration` with the widening, and `inPlace` on `m4`; or say
that the listing leaves them out. FA §12.5 and request 13: say the same.

**Weight:** misleads a reader.

### 1.8 Which write target a cell created under a constant cause has

- FA §8.2, third row: "In a `lift` or a `computed`, with a constant
  cause | The same, with `identifiedBy: "cause"`. The write is a static
  target (§6.3)", where "The same" is "The initial value is a `WriteEdge`
  with target `created`". FA §6.3 lists a `ConeEdge` only "Where the
  target is a state cell or names its handle by a slot".
- PL §3.11: "A static target is a state cell of the instance (`state`), a
  cell created under a constant cause, which is a `StateCell` too
  (section 3.14)". PL §3.14: "the cell is a `StateCell` of the plan and
  the write is a static side-write", and then, for every case, "The
  initial value of a created cell is a `WriteEdge` with target
  `created`." `ConeEdge.via` has the kinds `output`, `state`, and
  `handle` (§1.1), and none for `created`.
- A reader cannot tell whether the edge has target `state` (an index into
  `Plan.stateCells`, with a `ConeEdge` to its readers) or `created` (an
  index into `Body.calls`, with none), or whether the site is still an
  entry of `Body.calls`. FA §11.5 finds no such computation in the
  corpus.

**Governs:** PL.

**Correction:** PL §3.14: say that for a constant cause, or the element
key, the write is a `WriteEdge` with target `state` and whether the site
stays in `Body.calls`. FA §8.2, third row, follows.

**Weight:** misleads a reader.

### 1.9 An `inSpace` option that is a container passed on whole

- FA §8.1: "Each of the options `grants`, `root`, `spaceKind`, and
  `selfOwned` that the site writes, by the reference rule". By the table
  of FA §3.8 a projection of container type that arrives whole records
  "`identity`. The content is not read". By source (`InSpaceGrants` in
  `base/api/index.ts`) `grants` is a record from principal to access
  level.
- FA §3.8 lists the destinations that keep a container by reference: a
  return, a write through a handle, the argument of an instantiation or
  of an effect request, JSX, a binding's state, and an inline pattern's
  parameters. An `inSpace` option is none of them: the runtime turns
  `grants` into the access list of the space.
- PL §3.14: "The target and each option is a constant of the site, a
  slot, or a value the body computes at the request (`RequestValue`). A
  computed one carries `T_b`." PL does not say which class the slot of a
  container-typed option has, and has no rule like the one for an effect
  request under which a transaction follows the reference and joins what
  it reads.
- What I am unsure of: whether `{ slot }` in `RequestValue` is meant to be
  a `value` slot. If so FA's "by the reference rule" is the error.

**Governs:** PL (`RequestValue`, §3.14).

**Correction:** FA §8.1: an option is consumed, so a scalar records
`value` and a container records `value` over its subtree. PL §1.1,
`RequestValue`: the slot is of class `value`.

**Weight:** misleads a reader.

### 1.10 PL §3.9 lists the inputs of a body's template without the journaled resolutions and access-list reads

- PL §3.9 lists four inputs of the `derive` template of a sandboxed body:
  a `slot` for each entry of `Body.reads`, the template of each entry of
  `Body.computed`, a `dynamic` node for each entry of `Body.handles`, and
  a `dynamic` node "where the body has journaled label-metadata
  observations". PL §3.12 repeats it: "over its event slots, its state
  slots and its handles".
- PL §3.16, "Static and journaled", adds "a `dynamic` node of kind `link`
  through that slot" for a journaled resolution, and the table there
  adds a node of kind `space`. PL §6.2 has "dynamic(link through b2)" in
  `T_send`. FA §9.1 has S1 depend on "every link a journaled resolution
  follows ... every other context read recorded as dynamic", and FA
  §12.3 puts both in the template of `commitEdit`.

**Governs:** PL §3.16.

**Correction:** PL §3.9: add to the listing "dynamic link" and "dynamic
space" for each journaled resolution and access-list read of the body.

**Weight:** wording only.

### 1.11 FA §13 requests 7 and 5 still describe debts that are paid

- FA §13, request 7: "What the inventory still owes is the request
  `plan-and-label-templates.md` makes of it (open question 21 there):
  which operands of each effectful built-in are references".
- PL §8, question 21, marks it met: "the entry of each effectful built-in
  has a "Request operands" paragraph". BI has that paragraph in the
  entries of "Effectful built-ins".
- FA §13, request 5: "Two wordings there differ from this document. The
  hint `footprint:widened` names one input path ... And
  `side-write:not-idempotent` says all three shapes write something else
  on a second run whatever the data". LS §10.3 now says of the first
  "the input paths of the widened entries, which are several for a key
  that is not static, or the cell handle the analysis lost track of",
  and of the second "Two write something else on a second run whatever
  the data ... The third does so unless the write settles".

**Governs:** PL question 21, BI, and LS §10.3.

**Correction:** FA §13: delete the last sentence of request 7 and the
last three sentences of request 5.

**Weight:** wording only.

### 1.12 `Widening.slots` holds an entry PL's field comment does not describe

- FA §5.1: "For a widening on a key it is the entries at `*` below the
  keyed container, with the container's `enumeration` entry."
- PL §1.1, `Widening.slots`: "a `value` slot over a subtree, or the slots
  at `*` that stand for one child the analysis could not name." PL §2.2
  says the same. PL §1.1 says field comments "are part of the
  definition".

**Governs:** PL for the record; FA is right that the `enumeration` entry
stands for more than the body reads (PL §3.18: a dynamic key "does not
observe the container's other children or its enumeration").

**Correction:** PL §1.1, `Widening.slots` and `Widening.computed`: add
"and the `enumeration` entry of the keyed container".

**Weight:** wording only.

### 1.13 Whether "a body writes only what its record lists" rests on the compiler

- FA §9.2, table: "A body writes only what its record lists | The runtime
  refuses the write | No. It fails closed (§7.4 there)".
- PL §7.4 is headed "What does rest on compiler correctness", opens with
  "These the runtime cannot check", and lists "Footprints of writes and
  calls ... The runtime refuses a write or a call the record does not
  list, so a defect here fails closed." PL §7.3 lists the refusal of a
  write under what the runtime enforces.

**Governs:** PL §7.3.

**Correction:** PL §7.4: move "Footprints of writes and calls" to §7.3, or
say there that what rests on the compiler is only that the body's
behavior is the author's. FA §9.2 then cites §7.3.

**Weight:** wording only.

### What I checked and found consistent

- `Slot.inPlace`: set at positions of handle type and of reference type
  (PL §2.5; FA §7.2, §12.3).
- `Slot.resolved` and `Slot.sampled` (PL §2.5; FA §7.1, §7.5, §2.3).
- `Body.reads` and `Body.computed`, and narrowing of the argument to both
  (PL §3.9, §7.3; FA §1.1, §4.2, §9.2).
- `HandleReads`: the three forms of `handle`, the envelope as a schema,
  a `*` slot standing for every handle, a found handle with no entry
  (PL §1.1, §3.9; FA §7.2, §7.3, §7.5, §8.1).
- `WriteEdge` targets `handle` (slot and `computed` variants, with
  `resolved`), `argument`, `created`, `request`; `WriteEdge.reference`
  (PL §1.1, §3.11; FA §6.2, §6.5, §8.1 to §8.3).
- `WriteEnvelope`: the `handle` form with a slot in no `reads`, the
  `computed` form with `found`, and `created` (PL §1.1, §3.11; FA §6.2).
- `Widening.slots`, `computed`, `handle` apart from finding 1.12.
- `GivenReference` and `ComputedReference` wherever FA names an entry of
  `Body.computed` (FA §3.8, §6.2, §7.1, §8.1, §8.4, §8.5).
- `DynamicReads` kinds `link`, `handle`, `space`, `labelMetadata` against
  FA §7.1 and §8.4; each row of PL §3.16 a body can call against FA §8.4,
  §3.2, and §7.1.
- `Binding.state` (`capture`, `reference`, a path that is a reference on
  some runs only, a `Created` value) and `Closure.params` (PL §3.14,
  §3.15; FA §8.5, §8.1), apart from finding 1.6.
- `Child.callee`, `BodyCall` and its `identifiedBy` values,
  `SpaceRequest`, `RequestValue` recorded as `body` for a projection of a
  computed input (PL §3.14, §3.15; FA §8.1, §8.2).
- The three conditions of a static read and of a static resolution, the
  relaxation for an optional handle, and the ruled exception for a run
  that throws (PL §3.1, §3.9, §3.16, §5.2, §7.4; FA §1.4, §7.1, §7.2).
- The tier of a computation: static side-write or materializer, a
  `computed`-named handle is static, a binding and an instantiation do
  not make a materializer, what a materializer returns (PL §3.11, §3.14;
  FA §6.3).
- An instance made in a `lift` or a `computed`: identity, argument
  edges, teardown, no direct effect (PL §1.3, §3.14; FA §8.1, §8.3).
- The egress check follows the references of a request, and those reads
  are not the body's (PL §3.14; FA §3.8, §8.3).
- One template per body, with references the only refinement (PL §3.9,
  question 1; FA §4.1).
- FA §13 requests 1 to 4, 13 (apart from finding 1.7), 16, 18, 19, and
  20 against the PL sections each cites; PL question 22 against the FA
  sections it names.
- Statements against today: a handler's event (PL §3.12; FA §10.4), a
  sampled read, an instance made by a computation, a binding by
  reference, and a widening no wider than today's argument schema.
- The `commitSend` record of PL §6.2 against FA §12.5 for `myProfile`,
  `messages`, the handles `h0` to `h3`, the envelope on `threadInfo`,
  and the omitted in-place `shape` slots; the count of `throw`
  statements in PL §6.3 against source.

### What I did not read in full

- LS: only §4.4 (the callee table), §5.2 ("What a binding holds"), the
  headings of §7, and the rows of §10.3 that FA cites.
- BI: only the entry `inspectConfLabel`, "Context reads" (new design),
  "What the plan records for calls in bodies" in part, and a search for
  the "Request operands" paragraphs.
- ES, SS, OV: not read. Citations from PL and FA into them (ES §1.4,
  §1.6, §2.8, §3.3, §4.10; SS §3.4, §5.5, §7.1, §8.2, §10.4) were not
  opened.
- Specs pull request #91: not read.
- FA §11 (corpus measurement) was read and its counts were not checked,
  as the brief excludes them.
- Source: only the FabriChat functions named in the first paragraph, and
  the declarations of `InSpaceRequest` and `InSpaceGrants`. No claim
  either document makes about the transformer or the runner was checked.

## 2. `plan-and-label-templates.md` against `execution-and-storage.md`

I read `plan-and-label-templates.md` (PL) and `execution-and-storage.md` (ES)
in full at commit `68c271aafd`, and the plan's "Decided", "Open, and needing
the owner", "Open, and not needing the owner" and "Known limits". For each
section of PL that ES cites, and each section of ES that PL cites, I opened
the cited section and compared it with the citing sentence. I checked every
record type and field ES names against PL §1.1. Where a finding depended on a
third document I read only the passage concerned: SS §3.5, §5.2, §9.4 and
§10.4, and FA §6.3, §8.2 and §11.5. I verified nothing against source.

### 2.1 The identifier of a binding made in a function body holds `within` in ES and not in PL

- ES §5.5 gives the preimage `createRef({ binding: <handler>, bound: <bound
  keys> }, { parent: <result cell entity id>, within: [ <step>, … ] })`. The
  bullets below it define `<handler>` and `<bound keys>`. For an instance
  they say "`<body name>` and `within` are the body's". For a binding nothing
  says what `within` holds.
- PL §1.3, table, row "A `lift` or `computed`": "A binding: the enclosing
  instance, the handler, and what the binding holds".
- PL §3.14: "Two bindings of one handler are one stream when their copied
  values are equal and their linked cells and addresses are the same", and
  "in a function body, where a binding is made in an ordinary loop, equal
  state gives one stream."
- ES §4.7: "The document's identifier, and the stream's, derive from the
  enclosing instance, the handler and what is bound (section 5.5)."
- PL §2.6, on a row of the stream index: "For a binding made in a function
  body the row carries the identity label of the stream (section 3.14)." For
  a binding of the reactive tier in an element body the row carries the
  collection's membership label, because its identifier holds the element
  key.

With `within` in the preimage, a `computed` inside an element body or a
compiled-in call that binds one handler to equal state makes one stream per
element key or site. PL says it makes one stream. If the element key is in
the identifier, the label PL §2.6 gives the row and PL §3.14 gives the
stream's identity does not cover the membership the identifier reveals.

**Governs:** PL §1.3 and §3.14 for what the identity derives from, and for
the label that depends on it. ES §4.7 agrees with PL.

**Correction:** ES §5.5, remove `within` from the binding preimage, or state
that it is always empty for a binding. If the owner wants the place in the
identifier, PL §1.3, §3.14 and §2.6 change together and the stream's
identity label joins the membership of each enclosing collection.

**Weight:** blocks an implementer.

### 2.2 A derived write that a cone evaluated before the body read by address, where the handler receives that cone's output through a state path

- PL §4.5, "Order": "A write is therefore instantiated before every template
  that has a slot bound to its target. In an event's transaction the order
  is: the derived writes that the handler body reads by address, …; then the
  handler's write edges; then producers before consumers".
- ES §1.6: the body reads by address "in two ways", through a slot of
  `Body.reads` bound to the address and through a journaled read. "A value a
  handler receives for a state path that names an output of its instance is
  not read by address (section 1.3): the handler's template holds the
  output's template".
- PL §4.5, "What a write uses": a value a cone receives through an `output`
  edge is not a use, and "The same holds for a value a handler receives for
  a state path that names an output of its instance". ES §1.9: "The reads of
  the producing cone instance are reads of the receiving unit in their
  place."
- PL §4.6: "A dropped write is used by no unit." and "A handler body is not
  run again."

Take a kept output K of another instance, or a side-write to a state cell,
that this transaction staged before the body. A cone of the handler's
instance read K's address through a slot and computed an output O. The
handler's state path names O. The body does not read K by address in either
of the two ways, so K is not instantiated early. Two things follow.

1. The handler's template holds O's template, which has a slot bound to K's
   target. By the first sentence of "Order" K is instantiated before the
   handler's write edges. By the stated order it is in the third group,
   after them.
2. If K's constraint fails in the preparation, K is dropped after the body
   ran. The handler's unit holds the reads of O's cone instance, one of
   which was K's staged value, so the handler's unit uses K. "A dropped
   write is used by no unit" then does not hold, the body cannot be run
   again, and the ruling does not let the drop reject the event.

**Governs:** PL §4.5 and §4.6. ES §1.6 follows PL's list of the two ways.

**Correction:** PL §4.5 and §4.6, and ES §1.6: extend the early step to
every derived write this transaction staged at an address that a cone
instance evaluated before the body read, where the handler receives a value
of that cone instance, through any number of `output` edges. Such a write is
instantiated and checked before the handler's argument is built, and a
dropped one makes the reading cone instance stale before the body, where it
can still be evaluated again.

**Weight:** blocks an implementer.

### 2.3 The withdrawal before the preparation is stated for a kept output and not for the other derived writes of the same cone instance

- PL §4.5: "A kept output that was staged before the body, whose cone
  instance read something the body then wrote, and that the body did not
  read by address has no label yet when the body writes. Instantiating it in
  the preparation would give a value computed from the earlier state the
  label of the later one, so it is withdrawn instead".
- ES §1.6: "**A kept output evaluated before a handler body** … If the body
  then wrote something its cone instance had read, the staged value is
  withdrawn before the preparation".
- ES §1.2: a cone instance evaluated before the body "stages the values of
  its kept outputs and of its side-writes as it is evaluated". ES §1.6:
  "Everything else is instantiated in the preparation: … the derived writes
  of the event's transaction that the body does not read by address".
- SS §5.2 words the rule for "A write the body did not read by address".
  SS §3.5 words it for "the kept outputs of that cone instance".

A cone instance evaluated before the body can also stage a side-write to a
state cell or through a handle, a path of a child's argument, or a path of
an effect's request. When the body then writes something that cone instance
read, and does not read that target by address, the reason PL gives applies
unchanged: the preparation would instantiate the write from the label the
body staged, for a value computed from what was there before. No document
says the write is withdrawn.

**Governs:** PL §4.5.

**Correction:** PL §4.5 and ES §1.6 (and SS §3.5): say "a derived write"
where they say "a kept output". ES §3.3 already says what the memo does
when a side-write does not reach storage: the entry is dropped.

**Weight:** blocks an implementer.

### 2.4 A refusal records "the slots the constraint lists", and three kinds of constraint list none

- PL §4.4: the scheduler "records the refusal with the instance: the
  constraint, the slots it lists, and their label identifiers. The scheduler
  does not attempt the same instantiation again until one of those slots
  changes its value or its label".
- ES §3.1, `Refusal.labels`: "The label identifiers of the slots the
  constraint lists." ES §3.3: "An unstored write that carries a refusal is
  not attempted again until one of the slots the constraint lists changes
  its value or its label".
- PL §1.1, `Constraint`: only `requiredIntegrity` and `maxConfidentiality`
  have `slots`. `{ readonly kind: "writerFit" }`, `writeFloor` and `writer`
  have none. PL §4.4 evaluates them on `C(template)`, `I(template)` and the
  writing body.

A constraint on a derived write is most often writer-fit or a write floor,
since PL §4.4 puts both on the write edge or the output. For those the
record of ES §3.1 is empty, and by the sentence quoted the write is never
attempted again while its value stays, even when a label its template
reaches changes.

**Governs:** PL §4.4 and §1.1.

**Correction:** PL §4.4: for a constraint on a write (`writerFit`,
`writeFloor`), the refusal records the instantiation key of the write's
template, and the write is attempted again when that key changes. ES §3.1
`Refusal` and §3.3 follow.

**Weight:** blocks an implementer.

### 2.5 A `pick` over a container the instance computed: the key cannot be reported "by slot index", and nothing makes the reader stale per chosen child

- PL §1.1, `pick.from`: `{ collection: Index } | { container: Index } |
  { output: Index }`. PL §3.18: for `a[k]`, `from` is "The container slot of
  `a`, or the output that computes `a`", and "The value code reports the
  key". PL §6.2: `T_place = pick( from: output facts.places, choice: T_key,
  body: T_facts )`.
- ES §2.2, `ConeResult.picks`, and ES §7.2, `OutputProvenance.picks`: "The
  key a `pick` over a container chose, by slot index."
- ES §3.1, `MemoEntry.upstream`: "The upstream outputs the evaluation
  pulled, by output index". ES §3.3: "An entry is not current when an
  upstream output it pulled has a different value from the one recorded."
  ES §2.6: "A captured outer value changes | Every element's cone instances
  that read it | All of them".
- ES §10.1: "The 30 existing rows | No | No | … each reads only its own
  entry of the room's records, which is equal to the one before". ES §10.2:
  "Sandboxed calls for the 30 existing rows | … | None, and no coordinator".
  PL §6.5: "The other rows are not evaluated, because the cones are keyed
  by element identity."

Two things do not fit.

1. A `pick` whose `from` is an output has no slot, so its key has no place
   in `picks`. Two picks over one container slot (`a[j]` and `a[k]`) share
   one place. PL gives a `select` an index (`selector`) and a `pick` none.
2. Each row of the slice pulls the output `facts.places` and picks one
   child. A send adds an entry to `facts.places`, so by ES §3.3 and §2.6
   every row's cone instance that pulled it is stale and is evaluated,
   which calls `B4`. The traces of ES §10 and PL §6.5 say none is. For that
   the memo would have to compare the chosen child and not the output.

**Governs:** PL §1.1 for the record. ES §3 for what makes an entry stale.

**Correction:** PL §1.1: give `pick` an index of its own, as `select` has,
and say that value code reports a key per such index. ES §2.2 and §7.2: key
`picks` by it. ES §3.1 and §3.3: for an upstream output reached only through
picks, record and compare the chosen children. Or ES §10.1, §10.2 and PL
§6.5 say that each existing row's cone that reads `facts.places` is
evaluated once per send and cut off at its unchanged output.

**Weight:** blocks an implementer.

### 2.6 The link that stands for a kept output of narrower scope is neither a storage link nor a reference, and PL has no rule for it

- ES §4.2, fourth row of the table: "An output of narrower scope than this
  scope instance | A link to the same document and path with the narrower
  declared scope". "A link carries a declared scope and no user or session
  identifier, and the reader's runtime resolves it to its own scope
  instance".
- PL §2.3: "A storage link names the part document and holds nothing else:
  no path, no schema, no scope, and no label entry." The carve-outs of that
  section (not observed by `identity`, not on a chain, no element key, no
  label) are stated for a storage link.
- PL §2.5: "Where the value at a segment is a stored link, resolution
  continues at the link's target", the link is on the slot's chain, and its
  `followRef` entries join the slot's label.

The runtime writes this link, and no pattern code holds it, so it is not a
reference of the language. It carries a scope, so it is not a storage link.
By PL §2.5 as written it is a stored link: it is on a chain, a read through
it consumes a pointer label that no template instantiates, an `identity`
slot at the path observes it, and a row whose kept value is of session
scope is keyed by a cell's identity. PL §1.4 adds that the scope at run time
"can be narrower" than the plan's, so whether the space's scope instance
holds a value or this link can depend on data.

**Governs:** PL for the label rule. ES §4.2 for the layout.

**Correction:** PL §2.3: state that the link from a broader scope instance
to a narrower one is a storage link too, with the same four properties, and
allow such a link to hold a declared scope. ES §4.2 and §4.10 then call it
a storage link and give its stored form. PL §5.5 lists what its presence
reveals, if anything, beside the split.

**Weight:** blocks an implementer.

### 2.7 The label of an effect's request hash, claim and pending mark: ES leaves out the content the request holds by reference

- PL §2.6, table: the request hash, the claim and the pending mark carry
  "The confidentiality of `Operation.input`, instantiated, and no integrity.
  For an effect it is joined with what following the references of the
  request consumed (section 3.14)". Below: "Its label is therefore the
  joined label of section 3.14".
- ES §6.4, "Label": "For the hash, the claim and the pending mark, the
  confidentiality of `Operation.input`, instantiated, and no integrity
  (section 6.5)."
- ES §6.5: "Every other path carries the confidentiality of
  `Operation.input`, instantiated, and no integrity: … the request hash,
  the claim and the pending mark of an effect."
- ES §11.2, request 13: "Met by its §2.6: the confidentiality of
  `Operation.input`, instantiated, and no integrity".

The hash is computed from the content behind the references, so the label
ES states does not cover it. An effect a handler requests has no
`Operation` record at all, so "`Operation.input`" names nothing for it; PL
§3.14 gives it the joined label over the request's templates, which are
`T_b`.

**Governs:** PL §2.6 and §3.14.

**Correction:** ES §6.4, §6.5 and request 13: the hash, the claim and the
pending mark carry the joined label of PL §3.14, and for a request a
handler made the join is over the templates of its `request` write edges.

**Weight:** misleads a reader.

### 2.8 After a dropped write, a cone instance that read it is evaluated again "in the same transaction" in ES, and waits in PL when the drop is after a handler body

- ES §1.7: "A cone instance that had read the staged value through a slot,
  in this instance or another, is stale again and is evaluated again in the
  same transaction, against what is stored."
- PL §4.6: "In a derivation transaction, and before a handler body, it is
  evaluated again in the same transaction, against what is stored. After a
  handler body it waits for the derivation transaction behind the batch
  (`execution-and-storage.md` §1.7; `scheduler-and-serving-loop.md` §3.5)."
- SS §3.5 has PL's two cases. ES §1.1: an event's transaction "holds no
  other derivation".

PL cites ES §1.7 for a case ES §1.7 does not have. Neither document says
what becomes of the write that the waiting cone instance had staged in the
event's transaction from the dropped value (finding 2.2 is the case where
the handler received it).

**Governs:** PL §4.6, with SS §3.5 and ES §1.1.

**Correction:** ES §1.7 and §1.9 ("A dropped write is used by no unit"):
add the case after a handler body, and say that the staged writes of the
cone instance that waits are unstaged with the dropped one.

**Weight:** misleads a reader.

### 2.9 An instance a handler requested whose link the body drops: ES stages its argument document, PL creates nothing

- PL §3.14: "An instance that a `handler` or an `action` requests becomes an
  instantiated pattern, with a result cell, when its link is written into
  state or passed to `navigateTo`. A link the body drops creates nothing."
- ES §1.4: "A requested child instance gets its argument document, and its
  result document when its link was written into state or passed to
  `navigateTo`."
- ES §4.6: "Its argument document is staged when the handler's body returns.
  Its result document is staged when the link was stored or passed to
  `navigateTo`. A request whose link the handler dropped writes nothing."

ES §4.6 states both. PL §4.4 lists "the arguments of the instances it
requests" among what a handler itself writes, so the answer also decides
whether a constraint on the argument of a dropped request rejects the
event.

**Governs:** PL §3.14.

**Correction:** ES §1.4 and §4.6: the argument document is staged under the
same condition as the result document. PL §4.4: a request whose link is
dropped stages nothing and has no constraint to fail.

**Weight:** misleads a reader.

### 2.10 The allocation record is a staged write with a label, and no record, list or unit covers it

- PL §3.14: "The record is one of the writes the body stages, and it carries
  `T_b`". It commits as step 2, "in a commit of the calling space that holds
  the allocation records and nothing else", before the home writes.
- ES §5.6: "The body stages the allocation record as one of its writes."
  "A failure after the allocation record committed leaves the record".
- PL §1.1, `WriteEdge.target`, has no kind for it. PL §4.1 does not list it
  among what is instantiated. PL §4.4 and ES §1.7 do not list it among "what
  a handler itself writes". ES §4.1 ("the following documents and no
  others") has no document for it, and no section says under which
  identifier it is stored.
- PL §4.6: "Every write the transaction stages is in exactly one unit", and
  the property "no write commits whose value, label or verdict was computed
  from a value or a label staged by a write that does not commit".

The record commits ahead of its unit and stays when the unit, or a unit of
an earlier transaction of the batch whose staged label `T_b` resolved to,
does not commit. That is an exception to the property, and no document
states it. For a request a computation makes, no document says whether a
failed constraint on the record drops it alone.

**Governs:** PL for the record, the label and the units. ES §4 for where it
is stored.

**Correction:** PL §3.14 and §4.6: name the allocation record as a write of
the requesting unit that commits ahead of it, state the exception, and say
from which labels it is instantiated (stored ones only, or the exception is
accepted). ES §5.6: say in which document and under which identifier the
record is stored.

**Weight:** misleads a reader.

### 2.11 A cell a computation creates under a constant cause is a `StateCell` in PL and has the preimage of a created cell in ES

- PL §3.14: "When the cause is a constant, or the element key of the
  enclosing element body, the cell is a `StateCell` of the plan and the
  write is a static side-write". PL §3.11: "a cell created under a constant
  cause, which is a `StateCell` too".
- PL §1.3: "A state cell's document identifier derives from the cause of its
  creation: the instance, the steps of `within`, outermost first, and
  `name`." Also: "A body that creates a cell under an explicit cause names
  the cell by its own `name` and `within` and the cause".
- ES §5.2 derives a state cell's identifier from `StateCell.name` and
  `within`, with `type: "state"` or today's `"internal"`. ES §5.5 derives a
  cell a re-evaluated body creates as `createRef({ cell: <cause value> },
  { parent, site: <body name>, within })`.
- `StateCell` has `name`, `scope`, `within`, `schema`. The `createCell`
  `BodyCall` has no member that names a `StateCell`.

A cone that reads such a cell has a slot with root `state` and binds it by
ES §5.2. The body that creates it names it by ES §5.5. The two preimages
differ, and no document says what `StateCell.name` and `within` are for
such a cell so that they agree. FA §11.5 reports that no computation of
the corpus creates a cell under a constant cause.

**Governs:** PL §1.1 and §1.3.

**Correction:** PL §3.14: say what the `StateCell` of such a cell records
(the body's `within`, and a `name` formed from the body's name and the
cause), and how the `createCell` site refers to it. ES §5.5: say that a
`StateCell` that comes from a `createCell` site has the preimage of §5.5.

**Weight:** misleads a reader.

### 2.12 ES calls the assembled result of an element construct "an output like any other"; PL's `Output` names the cone that computes it

- ES §2.5: "The assembled collection is an output like any other. A cone
  that uses it pulls it with `host.output`, and it is stored when it is
  kept."
- PL §1.1, `Output`: `readonly cone: Index;`. PL §1.4: "Every value the
  instance computes is computed by exactly one cone". PL §3.6: the runtime
  "evaluates the body's cones once per key with that element's slots, and
  assembles the result."
- PL §1.1, `Collection.source`, has `{ output: Index }` only for "An array
  the instance computed", and `ConeEdge.via` has no kind for a collection.

I am unsure whether this is a conflict or a convention left unstated. No
cone computes the assembled array, so I cannot tell which `Output` entry a
cone that passes `xs.map(f)` to a body pulls, what `cone` it names, and
what `host.output` returns for an output of an element cone whose path has
a `*`.

**Governs:** PL §1.1 and §1.4.

**Correction:** PL §1.4: say which entry of `Plan.outputs` stands for the
assembled result of an element construct that a cone or a body uses, and
what its `cone` is. ES §2.5 then cites it.

**Weight:** misleads a reader.

### 2.13 ES cites its §4.6 for `asScope`, which does not mention it, and no section says how `Child.scope` changes what is stored

- ES §2.8: "The modifiers `asScope` and `inSpace` apply at such a site as in
  a handler (sections 4.6 and 5.6)." It is the one occurrence of `asScope`
  in ES.
- PL §1.1, `Child.scope`: "`asScope`: the scope of the state the instance
  declares." PL §1.4 derives `Output.scope` from "the declared `scope` of
  every `StateCell` and `Child`".
- ES §4.1: a state cell document has scope instances "By the cell's declared
  scope".

The child's own plan declares its state cells' scopes. No section of ES
says where the modifier of the instantiation is kept with the instance, or
that the child's state cell documents take it.

**Governs:** PL for the record. ES §4 for the layout.

**Correction:** ES §4.6: add a bullet for `asScope`: where the scope is
stored with the instance, and which documents of §4.1 it changes.

**Weight:** misleads a reader.

### 2.14 PL §3.5 says the slots of an unselected branch "can dirty the cone"; ES §2.2 says they make no cone instance stale

- PL §3.5: "The unselected branch contributes nothing. Its slots are in the
  cone's slot list (section 1.1, `Cone.slots`), so they can dirty the cone".
- ES §2.2: "A slot the function does not ask for is not resolved, not
  validated and not recorded as read. A slot that only an unselected branch
  reads therefore makes no cone instance stale".

ES was changed to this after finding 3 of the first cross-read. The
sentence of PL is from before.

**Governs:** ES §2.2, which owns cone evaluation.

**Correction:** PL §3.5: replace the sentence by one that says a slot only
the unselected branch reads is not read, and so makes no cone instance
stale.

**Weight:** misleads a reader.

### 2.15 The bound of ten is on "a cone" in PL and on "a cone instance" in ES

- PL §5.2: "A cone is evaluated at most ten times in one transaction." The
  plan's ruling has the same words.
- ES §2.7: "A cone instance is evaluated at most ten times in one
  transaction", counted "per cone instance and transaction".

PL's Notation separates the two terms. Read by them, an element cone over
more than ten keys could not be evaluated.

**Governs:** ES §2.7 for the count; the ruling's sense is not in doubt.

**Correction:** PL §5.2: "A cone instance".

**Weight:** wording only.

### 2.16 Who reports the position a `fold` with `through` covers

- PL §4.2: "the value code reports the collection's length less one when
  nothing matched".
- PL §3.13: "The runtime evaluates the predicate cones in order and stops at
  the first match". ES §2.5: the structural step is the runtime's, "scanning
  for the first match" included. ES §2.2: `selections` is "The branch taken
  at each selector the cone evaluated".

**Governs:** PL §3.13 and ES §2.5.

**Correction:** PL §4.2: the runtime supplies the selection of a `through`
selector from its own scan.

**Weight:** wording only.

### 2.17 A basis row is "per cone instance" in PL and "per cone" in ES

- PL §2.6: "a basis row per cone instance and input document".
- ES §3.4: "The basis rows are per cone, and an element cone has one cone
  instance per element key." ES §3.2: the memo key is the key of a basis
  row "with the element keys added". SS §10.4 keys a row by instance, cone,
  scope instance and input document.

**Governs:** SS §10.4.

**Correction:** PL §2.6: "per cone, scope instance and input document".

**Weight:** wording only.

### 2.18 When positions of a kept collection differ in label, ES §4.3 reads as if the `*`-child entry stays

- ES §4.3: "When positions differ, each position that differs has its own
  entry at its index path."
- PL §2.3 and ES §4.10: a `*`-child entry "is stored only while every
  position instantiates to its label".

A `*`-child entry beside an entry of a position would give that position
the join of both.

**Governs:** PL §2.3.

**Correction:** ES §4.3: "When positions differ, there is no `*`-child
entry and each position has its own entry".

**Weight:** wording only.

### 2.19 The lists of what is instantiated differ

- PL §4.1 lists, for a binding made in a function body, "a copied path …
  and the link of a path bound by reference, whose pointer label is the
  path's template", and the label of which factory was bound.
- ES §1.6 says "as `plan-and-label-templates.md` §4.1 lists them" and names
  "a copied state path of a binding" only. ES §1.9, item 2, has the same
  shorter list and adds "an operation's state".
- PL §4.1 has no item for the stored state of PL §2.6 (an operation's
  bookkeeping, a provenance record, the record of instances made), whose
  labels are instantiated templates too.

**Governs:** PL §4.1.

**Correction:** PL §4.1: add the stored state of §2.6. ES §1.6 and §1.9:
cite the list without repeating part of it, or repeat all of it.

**Weight:** wording only.

### What I checked and found consistent

- Every record and field ES names exists in PL §1.1 with the meaning used:
  `Plan`, `Cone` (`entry`, `code`, `slots`, `bodies`, `writes`, `cache`),
  `Output` (`cone`, `interim`, `kept`, `scope`), `ConeEdge.via` kinds,
  `Body` members, `BodyCall` kinds, `StateCell`, `Operation`, `Child`
  (`callee` of kind `closure`, `name`), `Collection.bodyUses`, `Binding`
  (`state`, `stateSchema`), `Closure`, `WithinStep`, `GivenReference`,
  `Plan.dynamicReads`, `Plan.constraints`, `Plan.version`, `CompiledPattern`.
- The three conditions of PL §4.1 and ES §1.6, §3.3.
- The order of instantiation: PL §4.5 and ES §1.6, apart from 2.2.
- Early instantiation, and that an early write is not withdrawn: PL §4.5,
  ES §1.6, ES request 50.
- The two outcomes of a failed constraint, and a conflict: PL §4.4, ES
  §1.7, §3.3.
- Units, what a unit uses, the digest: PL §4.5, §4.6 and ES §1.9.
- A failed cone, its write edges by target, the bound, after the bound: PL
  §5.2 and ES §1.7, §2.7.
- A handler's reads before the body, a journaled read made current, a
  writer in an instance that is not loaded: PL §5.4, §5.5 and ES §1.3,
  §1.4, §2.4.
- Aborted, rejected, dropped, withdrawn: what is current and what is
  unstored: PL §4.1, §4.4, §5.4 and ES §3.3.
- Names, element keys, the salt, handling, sent events, instances made in
  a handler and in a computation: PL §1.3 and ES §5.2 to §5.5, apart from
  2.1 and 2.11.
- `inSpace`: the obtained identifier, the request's own identifier, the
  order of steps: PL §3.14 and ES §5.6.
- Part documents: PL §2.3 and ES §4.3, §4.10, with the hashed keys.
- Instances a computation makes: PL §3.14, §3.15, §2.6 and ES §2.8, §4.6.
- Binding state document, what a copy holds, a factory value's label: PL
  §3.14, §3.21 and ES §4.7.
- Stream documents and the stream index row: PL §2.6 and ES §4.7.
- Stored once per key, key sets: PL §2.6 and ES §2.5, §6, §8.6.
- Effects: request transaction, egress check, error state of a request: PL
  §3.14, §5.2 and ES §6.4, apart from 2.7.
- Materializers: PL §3.11 and ES §6.7.
- Provenance, origin facts, cache labels, the migrated `shape` entry: PL
  §2.6 and ES §7, §8.6, §9.2.
- ES requests 13 to 25, 41 to 44, 49 to 51, apart from 13 (2.7); PL
  questions 9 and 19.
- The FabriChat send: slots, handles, `n0`, `T_send`, `k0`, `k1`, the two
  transactions, apart from the existing rows (2.5).

### What I did not read in full

- PL and ES: read in full. PL §3.1 to §3.8, §3.16 to §3.22 and §7 I read
  without tracing each rule into ES, because ES does not restate them.
- The plan: the four sections named in the brief. Not "Where the work is"
  or "Next work".
- The first cross-read: finding 3 in full, findings 4 and 5 in part.
- SS: §3.5, §5.2 to the start of §5.3, the order of steps in §9.4, and
  §10.4 only.
- FA: the passages of §6.3, §8.2 and §11.5 on a cell under a constant
  cause only.
- BI, LS and OV: not read.
- No claim about source was checked.

## 3. `plan-and-label-templates.md` against `scheduler-and-serving-loop.md`, with the effects of `builtin-inventory.md`

I read the plan's "Decided", both "Open" lists and "Known limits" in full.
I read PL and SS in full, at commit `68c271aafd`. In BI I read the whole
of "Effectful built-ins" (the introduction and every entry), "Context
reads" and "Staged changes" of the authoring surface, "Which body may make
which call", all of "What the plan records for calls in bodies", the
summary tables, and the open questions. Where a finding depended on ES or
FA I read the section cited: ES §1.1, §1.7, §1.8, the end of §1.4, §3.4,
§4.1, §5.4, §5.5, the start of §6, §6.4 and §6.7, and the transfer table
of FA §3.1. I checked each citation between PL and SS in both directions
against the section it names. Two claims about the current system were
checked by source, and each says so.

### 3.1 A dropped write waits for "the slots the constraint lists", and the constraints on a write list none

- PL §4.4, of a dropped derived write: the scheduler "records the refusal
  with the instance: the constraint, the slots it lists, and their label
  identifiers. The scheduler does not attempt the same instantiation again
  until one of those slots changes its value or its label".
- SS §2.2, `UnstoredWrite.refusal`: "the constraint, by index into
  `Plan.constraints`, and the label identifiers of the slots it lists. The
  write is not attempted again until one of those slots changes its value
  or its label". SS §5.5, §5.6 and I1 of §1.5 say the same ("until a slot
  the constraint lists changes").
- PL §1.1, `Constraint`: only `requiredIntegrity` and `maxConfidentiality`
  have a `slots` member. The two kinds that are checked on the label of a
  write have none: `{ kind: "writeFloor"; patterns }` and
  `{ kind: "writerFit" }`. PL §4.4 checks them on the edge's template:
  "`C(template)` of the write edge fits it", "`I(template)` of the write
  edge satisfies the patterns".
- A kept output or a side-write whose label does not fit the target's
  declared confidentiality is the ordinary case of a dropped derived
  write, and its constraint is `writerFit`. For it the refusal record
  holds no label identifier, and "until one of those slots changes" names
  no slot. Read as written, the write is never attempted again, or is
  attempted on every transaction.
- PL §5.5 has the right dependency: "Whether a constraint fails is a
  function of slot labels and selections".

**Governs:** PL, for the record and the rule. SS repeats PL's wording.

**Correction:** PL §4.4: the refusal records the instantiation key of the
dropped write (PL §4.1, step 2), and the same instantiation is not
attempted again while the key is the same. SS §2.2 (`refusal.labels`),
§5.5, §5.6 and I1 follow: "until the instantiation key of the write
changes" in place of "until a slot the constraint lists changes".

**Weight:** blocks an implementer.

### 3.2 An event on a stream with no row is dropped at once, where the ruling keeps today's deferral

- Plan, Decided: "How pending entries are found, the order of the queue,
  and what happens to an event that cannot be routed stay as they are
  today."
- SS §5.1, "Today": a piece that started and registered no handler
  "makes the event unrunnable", which is the immediate drop. "Every other
  outcome defers the event", among them "a document at the end of the
  chain that holds no pattern reference". "Each deferral counts against a
  budget of eight", and "a later cycle drains it again".
- SS §5.1, "No row": "An event that is the earliest pending entry of its
  space and still has no row is unrunnable and is dropped as that section
  has it."
- The two differ. A stream with no row is the counterpart of a stream
  whose owner cannot be found, which today is deferred under the budget.
  SS uses "unrunnable" for the drop without deferral.
- The difference loses events. SS considers one way a client names a
  stream before the server has a row: "a handler of an earlier event adds
  a row to a collection". There the event waits behind the earlier entry.
  A row of a collection can also come from a commit that is not an event:
  an input the user typed (SS §11.1 names it as a cause on a client), a
  change another space pushed, or the completion of an effect. The client
  renders the row from that commit and the user acts on it. On the server
  the commit and the event can arrive in one drain. The event is then the
  earliest pending entry, it has no row, and it is dropped, although the
  derivation transaction of the same cycle writes the row.
- By source, `pieceMayStillStart` in
  `runtime/runner/src/scheduler/events.ts` counts an owning document that
  is empty and holds no pattern pointer as a piece that "may still start
  once another writer's commit lands".
- I am unsure of one thing: "dropped as that section has it" may be meant
  to include the deferral budget of events §5. The sentence does not say
  so, and the next bullets of the same list use "defers" where they mean
  it.

**Governs:** the ruling.

**Correction:** SS §5.1, "No row": an event that is the earliest pending
entry and has no row is deferred under the deferral budget of events §5,
with the events that arrived after it, and is dropped when the budget is
spent. SS §5.3, "No parking on time gates", already lists "a stream with
no row" among the reasons an event waits.

**Weight:** blocks an implementer.

### 3.3 No document says how a slot whose path holds `*` is bound and watched

- PL Notation: "A segment is a property name, or `*` for \"each
  element\"". PL uses such slots outside `element` roots: §2.2 ("slots at
  `*` for a key it could not name, which stand for every child"), §1.1
  `HandleReads` ("A slot whose path has a `*` stands for every handle
  those positions hold") and `WriteEnvelope`, §3.16 (`linksOf`: "the
  `identity` slot of each element").
- FA §3.1 makes them the ordinary record of a body that reads a list:
  "`rows[i].price` is `rows/*/price`".
- PL §2.5 defines binding in the singular: "the address where resolution
  ends is where the slot is **bound**".
- SS §2.2: `SlotBinding` has one `bound: Address` and one `chain`, and
  `InstanceRecord.bindings` is "By slot index and scope key. For a slot
  with root `element`, also by the positions of the enclosing
  collections". SS §3.2: "One index insert per slot that is not an element
  slot and per chain address".
- A slot `argument rows/*/price : value` over a stored list of links has
  one bound address per row, each behind a link of its own, and the set
  changes with the list. SS has a rule for this only where the root is
  `element` (the element table). For a `*` in the path of a slot of a
  body's `reads` it has none: how many entries are registered, what is on
  the chain, and what rebinds when a row is added or a row's link changes.
  ES has no rule either (its only uses of `*` are label entries).

**Governs:** SS owns the address index. PL §2.5 owns what "bound" and
"chain" mean.

**Correction:** PL §2.5: a slot whose path holds `*` is bound at one
address per child the path reaches, each with its own chain. SS §2.2 and
§3.2: `SlotBinding` per slot, scope key and child, the entries registered
after the container is read, and a change of the container's children as
the event that rebinds, as for element slots.

**Weight:** blocks an implementer.

### 3.4 A pending effect that a handler requested is found by nothing after a restart

- SS §2.1: one kind of effect operation is "one occurrence of a `BodyCall`
  of kind `effect` that a handler's committed transaction recorded". SS
  §6.2: "The outbox receives the request when the transaction commits.
  Such a request is made once".
- SS §6.4: "A park drops held requests, and the next activation finds
  them missing and requests them again", and "A request whose result was
  never committed is made again." SS §10.6: recovery finds "effect
  requests found missing from their hashes".
- For an `Operation` of a plan that works: the instance is loaded, its
  operation has a record, and the stored hash is compared. For a handler's
  request nothing leads to the state document. ES §6: "An operation a
  handler requests has the identifier of section 5.4", which derives from
  the handling. ES §4.1: what a handler created "is not one of the
  instance's documents". SS §4.4 loads on demand only where a document
  "can name a pattern instance that is not loaded", by a pattern reference
  or a `result` back-link, and a handler's effect document has neither.
- So after a park or a crash between the event's commit and the
  completion, the pending mark stays, no unit exists for the operation,
  and the request is not made again. The same gap leaves open which
  instance such an operation belongs to when SS §2.7 says of a torn-down
  instance "Its effect operations leave the registry".

**Governs:** SS (effects, recovery), with ES for what is stored.

**Correction:** SS §2.3 and §10.6: state what names a handler's effect
operation durably and how activation finds one with a pending mark (for
example a back-link from its state document to the handler's instance and
a row beside the basis index). ES §6.4 then stores it.

**Weight:** blocks an implementer.

### 3.5 An invalid materializer that cannot be promoted, read by a handler

- PL §5.4: "An attempt is withdrawn in the same way where the writer is
  an invalid materializer, which runs before the event is dispatched
  again." SS §5.2, step 3: "that materializer runs first, in its own
  transaction". SS §5.3: "Each withdrawn attempt loads an instance or runs
  a materializer that the attempt before it did not have, so the attempts
  end."
- SS §7.2, "A promoted run and its computed inputs": where a cone
  instance that produces a computed input of the materializer performs a
  side-write, "the materializer is not promoted: it runs behind the
  derivation transaction, the reader that would have waited for it reads
  what is stored, and the materializer's write makes that reader stale".
  ES §6.7 says the same.
- The last sentence is written for a reader that is a cone instance. A
  handler body runs once and cannot be made stale. For a handler the two
  rules cannot both hold: either the materializer runs before the event
  (PL §5.4, SS §5.2), which SS §7.2 excludes because the derivation
  transaction is behind the batch, or the handler reads a stale value.
- SS I4 (§1.5) then understates: it names "two exceptions" to "Every
  value a handler reads from its own space is current". SS itself has
  three more: this one, a cell that an instance that is not loaded writes
  through a handle (§5.3; plan question 57), and an address inside the
  envelope of a materializer of an instance that is not loaded (§7.4).

**Governs:** SS (materializers, the event queue).

**Correction:** SS §7.2: say what a handler does in this case. Either the
event waits, the batch ends before it, and it is handled after the
derivation transaction and the materializer have run (as for a stream
with no row), or the handler reads what is stored. In the second case PL
§5.4 and §5.5 ("A handler run again") and SS I4 list the exception. SS I4
lists the other two exceptions in either case.

**Weight:** blocks an implementer.

### 3.6 The scope of a cone instance is computed from addresses alone, which loses the scope of `spaceAccess`

- PL §1.4: `Output.scope` is `user` "where the template has a `dynamic`
  node of kind `space` for a read that answers for the acting principal
  (`spaceAccess` and `spaceMembers`, section 3.16)". "The scope an output
  has at run time can be narrower, … and it is never wider."
- SS §2.1: "The scope of a cone instance is the narrowest scope among the
  addresses its slots are bound to and its `dynamic` nodes read". ES §1.8
  states the same rule and adds "It is the plan's scope or a narrower
  one".
- The access list of a space is read at the same address for every
  principal. BI, "Context reads" (the table under "What the plan
  records"): `spaceAccessOf` is "The same read; the answer does not depend
  on who asks", and for `spaceAccess` today "a computation's read scope
  narrows to the user (`ownCall` in `builder/space-access.ts`)", by the
  call and not by an address.
- By SS's rule a cone whose only user-dependent read is `spaceAccess` has
  space scope. SS §10.3 then evaluates it once, for no principal ("An
  evaluation of a cone instance of space scope has none"), and
  `spaceAccess` has no acting principal to answer for. That is wider than
  `Output.scope`, against PL §1.4.

**Governs:** PL (`Output.scope` is a record of the plan).

**Correction:** SS §2.1 (and ES §1.8, second item): the scope of a cone
instance is the narrowest among `Output.scope` of the cone's outputs, the
addresses its slots are bound to, and the addresses its `dynamic` nodes
read.

**Weight:** misleads a reader.

### 3.7 No document gives the principal an effect operation's request transaction acts as

- SS §10.3 gives the acting principal of an evaluation: "the principal of
  the scope key the cone instance is evaluated for", and none for space
  scope. SS §9.3 applies it to an `inSpace` request. SS names no principal
  for an operation's request transaction, its completion transaction, or
  a materializer's run. §2.1 says only "A unit exists per scope instance
  where its state is scoped."
- BI needs one. `agent`: the effect "creates an `AgentRun` record and
  lists it in the requester's home-space queue". `sqliteQuery`: the
  recorded request holds, "for a database in another space, the reader",
  and "The request hash includes the reader's identity when rows are
  cleared per reader." The fetch family signs "with the runtime's
  identity".
- PL's `Operation` has no `scope` member, so the plan does not say
  either. An effect operation whose request is computed by a space-scoped
  cone has no requester and no reader.
- This extends plan question 45, which covers the evaluation of a
  space-scoped cone and an `inSpace` request made by one, and not an
  effect requested by one.

**Governs:** SS (which transaction runs as whom); BI for which built-ins
need a principal.

**Correction:** SS §6.2: the request transaction of an operation acts as
the principal of the scope key of the cone instance that staged the
request, and say what a built-in that needs a requester does at space
scope (refuse, as §9.3 does for `inSpace`, or narrow the operation to
user scope, as BI says `agent` does today).

**Weight:** misleads a reader.

### 3.8 Whether an effect a handler requests waits for demand

- SS §6.2, "When an operation is demanded": "An operation is demanded
  when something demands a path of its result." Two kinds of request
  "wait for no demand": "A staged change, and a `navigateTo` a handler
  requests". "When the request of a demanded operation is stale, the
  scheduler runs the operation's **request transaction**."
- BI, "When an effect is demanded, and its time gates", says the same,
  with the same two exceptions.
- SS §6.2, "In a handler": "The outbox receives the request when the
  transaction commits. Such a request is made once".
- By the first two, a `fetchJson` or a `generateText` that a handler
  requests waits until something demands its result. By the third it is
  sent when the event commits, demanded or not, and has no request
  transaction. SS §2.3 gives every operation "a demand count" without
  saying what it gates for a handler's.

**Governs:** SS.

**Correction:** SS §6.2: state that the demand rule is for an operation
of a plan, and that every request a handler makes is sent when its
event's transaction commits. BI's paragraph takes the same sentence.

**Weight:** misleads a reader.

### 3.9 PL §3.14 lets a client derive the stream of every binding that copies nothing

- PL §3.14: "A binding with no copied path, which every binding of the
  reactive tier is, has an identifier a client derives."
- PL §1.3: the stream of a binding of the reactive tier is named by the
  instance, the steps of `within` and the name, an `element` step
  contributes "the key of the element", and "A key derived from a value
  is salted". A binding in an element body over plain values is legal
  where the body uses the index, and its key then holds the salted value.
- SS §11.1: "A client derives it, unless an enclosing element key is a
  salted value hash." BI, "A handler binding made in a body": "unless an
  element key among its `within` steps holds a value."

**Governs:** the ruling (a client cannot name value-keyed per-element
state) and PL §1.3. SS and BI agree with them.

**Correction:** PL §3.14: add "unless an element key among its `within`
steps holds a value (section 1.3)".

**Weight:** misleads a reader.

### 3.10 Element slots of a handler bound in an element body: one position in SS, the join over positions in PL

- PL §8, question 27: "The same join is assumed for the element slots a
  handler bound in an element body of the reactive tier resolves when an
  event arrives, because the stream is per key and not per position." PL
  §1.3: "Two positions that link to the same cell are the same element
  and do share its state."
- SS §5.1, step 3 of "From a queued event to its handler": the
  membership is evaluated "so that the position that holds the key is
  known". SS §3.2 binds element slots "Per position".
- SS has one position per key. Where two positions hold the key, SS does
  not say which position's bindings the handler's slots take, and PL's
  join is not stated in SS. Plan question 40 lists what is stored once
  per key and does not list this case.

**Governs:** PL (the label of a slot), as an assumption that is the
owner's (plan question 40).

**Correction:** SS §5.1, step 3: the handler's element slots are bound at
every position that holds the key, and each resolves to the join over
those positions, as PL question 27 assumes.

**Weight:** misleads a reader.

### 3.11 The completion of an effect is a cause with a transaction that the cycle of SS §10.2 does not run

- PL Notation and SS Terms: four kinds of cause, and "A set of changes is
  the commits that arrived from storage and the writes of the events of a
  batch". ES §1.1 gives the completion of an effect "A derivation
  transaction" of its own.
- SS §6.5: the completion "is a cause of the third kind. Its derivation
  transaction evaluates the demanded cone instances that read the
  result".
- SS §10.2: the cycle runs a transaction per event, "one derivation
  transaction" for "the changes drained and the batch", one per change of
  demand, and one for what materializers and effect requests wrote. Its
  table says "The completion commits by itself and is input to the next
  cycle". No step runs a derivation transaction for a completion, so its
  dirty slots are evaluated in the one transaction of the next cycle's
  set of changes.
- Either the third kind has no transaction of its own, or the cycle lacks
  a step. No label depends on which, since every write is derived.

**Governs:** SS (the cycle).

**Correction:** SS §10.2: say that a completion's commit joins the set of
changes of the cycle that follows, or add the step. In the first case PL
Notation, SS Terms and ES §1.1 name a completion's commit among the
changes of a set.

**Weight:** misleads a reader.

### 3.12 `nameBlob` is an effect operation in SS and a document staged in the handler's transaction in BI

- SS §6.1 lists "the staged access changes, and `nameBlob`" and says
  "Each request is an effect operation", with "a request, …, a result,
  and transactions of its own". Its exception is for "The staged access
  changes" alone.
- BI, "Staged changes": `nameBlob` "stages a content-addressed document
  that holds the record's type and body under the given name, in the
  handler's transaction". BI's paragraph on demand says "A staged change
  is a step of the commit of the event's transaction", which fits the
  access changes and not this.
- SS §9.4 has no step for `nameBlob`. So it is neither an operation with
  a completion nor a step of the commit: it is a write of the handler.

**Governs:** BI (the per-built-in fact).

**Correction:** SS §6.1: `nameBlob` stages a document in the event's
transaction, has no request transaction and no completion, and is not a
unit. BI's paragraph on demand names it beside the access changes with
that difference.

**Weight:** misleads a reader.

### 3.13 A basis row is "per cone instance" in PL and per cone in SS and ES

- PL §2.6: "a basis row per cone instance and input document, which
  holds the sequence number of that input at the cone instance's last
  evaluation".
- SS §10.4: the key is the instance, the cone, the scope instance and the
  input document, with no element key. SS question 22: "Section 10.4
  assumes rows per cone." ES §3.4: "The basis rows are per cone, and an
  element cone has one cone instance per element key."

**Governs:** SS.

**Correction:** PL §2.6: "a basis row per cone, scope instance and input
document".

**Weight:** wording only.

### 3.14 SS question 6 and BI question 3 cite a three-step order that the plan and SS §9.4 no longer have

- SS §12, question 6: "It is question 15 of the continuation plan, which
  states the order as access changes, foreign batches, home. The place of
  the first two steps ahead of the access changes is this document's."
- Plan question 15: "the creation of a space an `inSpace` request
  creates, the allocation record, access changes, the batches in other
  spaces, then home." PL §3.14 and SS §9.4 have the same five steps.
- BI question 3: SS §9.4 "proposes one ordered sequence for both, which
  is not atomic: the access changes, then the batches for other spaces,
  then the home writes." BI, "Staged changes": the access change "is
  already the first step of the wave's commit".

**Governs:** the plan and SS §9.4.

**Correction:** SS question 6: drop the two sentences quoted. BI question
3 and "Staged changes": name the five steps, with the access changes
third.

**Weight:** wording only.

### 3.15 The allocation record commits "ahead of the wave, as a setup transaction does" and "at the wave's commit step"

- SS §9.4, step 2: "It commits by itself, ahead of the wave, as a setup
  transaction does (section 10.8)." SS §10.2: a setup transaction "is
  none of the cycle's transactions".
- SS §9.3: the genesis commit and the allocation record are applied "At
  the wave's commit step". SS §9.4: "Under a wave the sequence runs once
  for the wave". PL §3.14 and SS §9.4: "Every constraint is checked
  before the first step", so that a rejected transaction "applies none of
  them".
- A record that committed when the request was made, as a setup
  transaction commits, would precede the checks. The intended reading is
  the second.

**Governs:** SS §9.3 and PL §3.14.

**Correction:** SS §9.4, step 2: "It commits by itself, at the wave's
commit step, ahead of the wave's derived commit", without the comparison.

**Weight:** wording only.

### 3.16 Two phrases of SS §11.1 are narrower or wider than PL

- SS §11.1 and §11.6: a client cannot name "A part document of a row
  keyed by a plain value". PL §2.3: "the identifier of a part document is
  derived under the secret of the space for every key, a cell's identity
  included". Nothing follows from it, since a client never names a part
  document.
- SS §11.1: "A state cell or an operation's state declared in an element
  body over plain values, which exists only where the index is in the
  key". PL §1.3 has that condition for a state cell and a handler. An
  operation's state exists without the index and is stored once per key
  (PL §2.6).

**Governs:** PL.

**Correction:** SS §11.1 and §11.6: "A part document of a row". SS §11.1:
move "which exists only where the index is in the key" to the state cell.

**Weight:** wording only.

### 3.17 Which speculative run enacts `navigateTo`

- BI, `navigateTo`: "A client enacts it from its speculative run of the
  handler that requests it".
- SS §6.7: the client navigates when the speculative run of an event it
  fired stages the request "in the handler or in a derivation that
  follows from it". BI's own paragraph on demand has a `navigateTo`
  "written in the reactive tier".

**Governs:** SS; the ruling says "from its speculative run".

**Correction:** BI, `navigateTo`: "from its speculative run of the event,
in the handler or in a derivation that follows from it".

**Weight:** wording only.

### 3.18 The bound is on a cone in PL and on a cone instance in SS

- PL §5.2: "A cone is evaluated at most ten times in one transaction."
- SS §8.1: "In one transaction, one cone instance is evaluated at most 10
  times", counted "per cone instance and transaction".
- PL Notation tells a cone from a cone instance, and a cone applied to a
  collection of more than ten elements has more than ten evaluations. The
  ruling's own word is "cone".

**Governs:** SS §8.1, as the reading of the ruling.

**Correction:** PL §5.2: "A cone instance is evaluated at most ten times
in one transaction."

**Weight:** wording only.

### What I checked and found consistent

- The four kinds of cause, and a set of changes (PL Notation, SS Terms).
- A change of demand runs as the demanding principal; the reading for
  space scope is plan question 45 (SS §4.5, §10.3).
- The handling and its receipt, `eventKey`, a sent event's identifier (PL
  §1.3, SS §5.5, BI).
- Chains, `resolved`, `inPlace`, storage links, rebinding (PL §2.3, §2.5;
  SS §3.1 to §3.3).
- Sampled reads register nothing and contribute no row (PL §2.5, SS §3.1,
  §10.4).
- The five kinds of `dynamic` node, trigger reads, their loss at a
  restart (PL §3.10, SS §3.4).
- Journaled context reads: label metadata, the back-link of
  `resultOwnerOf`, the deletion answer of a space (PL §3.16, SS §3.4,
  BI).
- A label-only change (PL §4.1, SS §3.6).
- Demand per kept path, interim outputs by pull, parts (PL §1.4, §2.3;
  SS §4.1 to §4.3).
- The two parts of an event's transaction, the batch, one derivation
  transaction behind it (PL §5.4, SS §5.2, §5.4, §10.2).
- What the `binding` root resolves to (PL §3.14, SS §3.2, §5.2).
- Early instantiation of a derived write a body reads by address, and the
  withdrawal of one it did not read (PL §4.5, SS §5.2).
- The two outcomes of a failed constraint, the conflict rule, units, and
  the event whose handler's unit a withdrawal reaches (PL §4.4, §4.6; SS
  §5.5, §5.6).
- The stream index: what a row holds, when it is written, its label (PL
  §2.6, SS §5.1).
- A read whose writer is in an instance that is not loaded, for a static
  read, a journaled read, and a cone in a derivation transaction (PL
  §5.4, §5.5; SS §4.4, §5.3, §10.4).
- An effect's request as write edges, the request transaction, references
  followed, hashed operands, the label of the hash, which transaction a
  failed ceiling rejects (PL §2.6, §3.14; SS §6.2, §6.3; BI).
- BI's "Request operands" paragraphs against what SS §6.2 step 2 and PL
  §3.14 assume of them; the two claim timeouts; `wish` without debounce.
- Materializers: the envelope, the result through an `operation` slot,
  the creation-site envelope (PL §3.11, SS §2.4, §7).
- The bound of ten, failure at the bound, the write edges of a failed
  cone (PL §5.2, SS §8.1, §8.2).
- The five commit steps, the allocation record and its name, the acting
  principal as owner, checks before the first step (PL §3.14, SS §9.3,
  §9.4).
- An instance a computation makes: identity, when it exists, teardown, a
  failed evaluation, a changed factory, its effects (PL §3.14, §3.15; SS
  §2.7; BI).
- What a client can and cannot name, apart from 3.9 and 3.16; `navigateTo`
  as the one enacted effect (PL §1.3, SS §6.7, §11.1, §11.6).
- PL question 20: each of its items is met by the SS section it names.
- SS questions 13, 16 to 20, 31 and 32: each is met by the PL or BI
  section it names. SS's citations of ES, FA and LS were checked to exist
  and not for content, except ES §1.8, §3.4, §6.4 and §6.7.

### What I did not read in full

- OV: not read.
- LS: not read; I looked up five diagnostic identifiers.
- FA: not read; headings, and the transfer table of §3.1.
- ES: only the sections named in the first paragraph. In particular not
  §1.2 to §1.6, §1.9, §2, §3.1 to §3.3, §4.2 to §4.10, §5.1 to §5.3,
  §5.6, §7 to §10.
- BI: not the structural built-ins, "Element keys", the corpus sections,
  "Factory values", or "Decisions".
- The server-execution documents that SS cites: only the start of §5 of
  `events.md`.
- Source: only `pieceMayStillStart` and the deferral branch around it in
  `runtime/runner/src/scheduler/events.ts`, and the list of verdict
  reasons in `runtime/runner/src/ensure-piece-running.ts`.

## 4. `execution-and-storage.md` against `scheduler-and-serving-loop.md`

I read ES and SS in full, at commit `68c271aafd`, and the continuation plan
in full. I read section 3 of the first cross-read in full and checked each
of its 26 points again in the documents as they stand. In PL I read §4.1,
§4.4 to §4.6 and §5.2 to §5.4 in full, the passages of §1.3, §2.3, §2.6 and
§3.14 that ES and SS cite for the points below, and the record definitions
of §1.1 for the fields ES and SS name. In BI I read "An instantiation
request from a `lift` or a `computed`". In source I read only the bindings
of the `joined` stream in `patterns/system/fabrichat/room.tsx`. Findings 1 to
26 of the first cross-read are corrected in both documents. What is left of
its findings 6 and 25 is 4.12 below, and ES request 12, which it counted as
met, is 4.5. The findings are ordered by weight.

### 4.1 A derived write the handler uses through a cone, dropped after the body

- ES §1.6 ("What is instantiated early"): "a derived write whose target the
  handler body reads by address is instantiated, and its constraints are
  checked, before that read returns", because "A handler body is not run
  again when a constraint drops a write, so it must not read a value that a
  later check drops." Then: "Everything else is instantiated in the
  preparation: the handler's own write edges, the derived writes of the
  event's transaction that the body does not read by address", and "A value
  a handler receives for a state path that names an output of its instance
  is not read by address".
- SS §5.2 has the same rule, limited the same way: "A derived write that
  was staged before the body and whose target the body reads by address,
  through a slot or through a journaled read, is instantiated and its
  constraints are checked before that read returns".
- ES §1.9, item 4: "a value a handler receives for a state path that names
  an output of its instance, are not uses. The reads of the producing cone
  instance are reads of the receiving unit in their place." And: "A dropped
  write is used by no unit."
- The case the rule leaves out. Cone C is stale, is evaluated before the
  body, and side-writes state cell S (ES §1.3, §2.3). Cone R reads S through
  a slot and computes an output that the handler receives by value, through
  a state path that names the output. The body does not read S by address,
  so C's write is instantiated in the preparation, after the body ran. If
  its constraint fails there, the write is dropped. The handler ran once on
  a value computed from it, and by ES §1.9 the handler's unit holds R's
  reads, so it uses the dropped write.
- ES §1.6 ("Order") instantiates "the derived writes instantiated early
  first, ... then a handler's write edges, then producers before consumers".
  In this case the handler's template has a slot bound to S, and C's write
  to S is instantiated after the handler's write edges, against the first
  sentence of the same item: "A write is instantiated before every template
  that has a slot bound to its target".
- What becomes of R is stated two ways. ES §1.7: a cone instance that had
  read the dropped value "is stale again and is evaluated again in the same
  transaction, against what is stored." SS §3.5: "In a derivation
  transaction, and before a handler body, it is evaluated again in the same
  transaction ... After a handler body it waits like every cone instance the
  body made stale". PL §4.6 says what SS says. Under SS and PL, no rule
  takes back the kept outputs and side-writes that R staged before the body
  from the dropped value: SS §3.5 ("A staged write that is unstaged") lists
  three cases and this is none of them.

**Governs:** PL §4.5 and §4.6, for the order and for the property "no write
commits whose value, label or verdict was computed from a value or a label
staged by a write that does not commit". PL §4.5 ("A write instantiated
early") has the same limit to what "a handler body reads by address", so
the gap is in all three documents.

**Correction:** PL §4.5, ES §1.6 and SS §5.2: before the handler's argument
is built, instantiate and check every derived write this transaction staged
at an address that was read by a cone instance whose value the handler
receives, directly or through `output` edges, and not only the writes the
body reads by address. ES §1.6 "Order" lists them with the early writes.
ES §1.7 takes the sentence of SS §3.5 for a write dropped after the body.
I am unsure whether "after the staged writes it uses" in ES §1.6 was meant
to reach this case; as written it applies to a write that is itself
instantiated early.

**Weight:** blocks an implementer.

### 4.2 A handler reads by address an output that is unstored and current

- ES §1.2 (event's transaction, "Before the body"): "The stale cone
  instances that compute what the handler reads are evaluated." ES §1.4: a
  slot "is then materialized from what is staged there, or from what is
  stored where the check dropped the write", and a journaled read "returns
  what is staged, or what is stored where no write is staged or the check
  dropped the write."
- ES §3.3 and SS §3.5: after an event's transaction that did not commit, a
  cone instance that staged no side-write "stays current" and "Its kept
  output is unstored." SS Terms: "Its cone instance can be current: storing
  the output needs no evaluation."
- ES §1.5 lists "**An unstored output** that something demands is stored
  by this transaction from the memo" for a derivation transaction only. SS
  §10.2 runs a derivation transaction for it behind the batch. SS §5.3 has
  no row for a current cone instance whose write is unstored.
- SS §1.5, I4: "Every value a handler reads from its own space is current
  when it reads it (section 5.3)."
- The case. Event A's transaction evaluates stale cone C before its body
  and stages kept output O. A is rejected, or is requeued at the wave's
  commit, or its attempt is withdrawn at a journaled read. C's memo entry is
  current and O is unstored. Event B of the same batch, or A when it runs
  again, reads O by address, through a slot whose path crosses a link. C is
  not stale, so nothing is evaluated, and nothing is staged at the address,
  so the handler reads the stored value, which was computed before the
  change that had made C stale.

**Governs:** SS for what a handler reads (I4); ES for the steps of an
event's transaction.

**Correction:** ES §1.3 and SS §5.2 ("Before the body"): an unstored kept
output that carries no refusal, at an address a slot of `Body.reads` is
bound to or a journaled read reaches, is staged from the memo before the
read and instantiated early, like a write the body reads by address. SS
§5.3 gets a row for it. I am unsure whether SS §3.5 ("The next transaction
that demands an unstored output stores it from the memo") is meant to
include an event's transaction, which holds demand on what the handler
reads (SS §2.5). If it is, no document says that the value is staged
before the body's read: ES §1.6 stages values "at evaluation", and here
there is none.

**Weight:** blocks an implementer.

### 4.3 The rows a setup transaction's evaluations need have no writer

- SS §10.8: a migration and a setup under a new compiled pattern each
  "commits by itself, ahead of the wave", and "The transaction evaluates
  every cone instance". SS §10.2: a setup transaction "is none of the
  cycle's transactions".
- SS §5.1: a stream row is written "In the store transaction of the wave
  whose transaction first computed the stream's identifier." SS §10.4: basis
  rows are "written inside the wave's store transaction". ES §4.7 repeats
  the first.
- ES §9.4, step 5, lists what the migration writes "in one transaction":
  the result document and its parts, the setup record, the carry-over
  record, forwarding links, and the mark on the space. It lists no basis
  row and no stream row.
- So the transaction that first evaluates every cone of a migrated or
  updated instance, and first computes its stream identifiers, is in no
  wave. The memo then holds the evaluations, so no later transaction of the
  process computes the identifiers again. After a restart the instance has
  no stream row, and SS §5.1 ("No row") drops the event: "An event that is
  the earliest pending entry of its space and still has no row is unrunnable
  and is dropped".

**Governs:** SS (the basis index, the stream index, setup transactions).

**Correction:** SS §10.8: say that the store transaction of a setup
transaction writes the basis rows of the cone instances it evaluated and
the stream rows of the streams it computed, and deletes the rows of the
earlier compiled identity. SS §5.1 and §10.4: "the wave's store
transaction, or a setup transaction's". ES §9.4 step 5 names the rows.

**Weight:** blocks an implementer.

### 4.4 Tearing down an `inSpace` instance that a computation made

- ES §2.8 ("Teardown"): "The transaction removes it from the instances
  document and writes a mark into the setup record of its result document.
  The same transaction writes the mark for every instance that belongs to
  the torn-down one". ES §2.8 also allows `inSpace` at such a site, and ES
  §4.6: "**A child in another space** (`inSpace`) has its documents in that
  space. The requesting transaction writes only what belongs to its own
  space."
- SS §9: "A transaction covers one space." SS §9.3 lists what crosses: an
  event, "An `inSpace` instantiation: the child's argument and result cell",
  the creation of a space, an access change, and a bookkeeping write. It
  has no row for a mark. SS §2.7 ("Teardown") has the scheduler release the
  record, withdraw demand, drop queued events, abandon effects and delete
  "Its rows ... from the basis index and from the stream index, in the
  wave's store transaction". For an instance in another space those are the
  record, the queue and the rows of that space's serving loop.
- SS §2.7 ("In another space") points to §9.3, which has the instantiation
  and the acting principal and nothing on teardown. PL §3.14 and BI ("An
  instantiation request from a `lift` or a `computed`") have none either.

**Governs:** SS for writes that leave a space; ES for what a teardown
writes. The legality of `inSpace` at such a site is question 50 of the
plan. This finding is what that assumption needs and does not have. It is
separate from the plan's entry on how the instances that belong to a
torn-down instance are found.

**Correction:** SS §9.3: add a row for the mark of a torn-down instance in
another space (an authored batch, under the principal of the scope key the
making cone instance is evaluated for), and say that the other space's
loop does the scheduler's part of SS §2.7 when that commit arrives. Say in
the same place that a later evaluation's changed argument is carried by
the row for an instantiation. ES §2.8 "Teardown" refers to it.

**Weight:** blocks an implementer.

### 4.5 An event a handler sends: after the commit, or queued at the seal

- ES §1.4: "An **event sent to a stream** is staged. It is delivered after
  the commit, as a cause of its own." ES §10.1: "sends on the `joined`
  stream. The send is staged and becomes a cause of its own after the
  commit", and "The event is the only one of its batch, so two transactions
  run". ES §10.2: "Two: the event's, and one derivation transaction."
- SS §5.1: "The batch of a cycle is the events in the space's queue when
  the cycle begins to handle events, together with the events that their
  handlers send to streams of the same space, which join the queue when the
  sending transaction seals." SS §10.2 queues "the events it sent to streams
  of this space" inside the loop over the batch, before "commit the wave".
  SS §5.5 undoes "The handlings of the events it sent in the same cycle"
  when a withdrawal reaches the sender.
- ES §1.2 itself separates the two: "On a runtime with no wave, sealing is
  committing. On a serving runtime a sealed transaction joins the wave".
- By source, `joined` is bound in the room to `tellManagerJoined({...})`
  (`tellJoined` in `patterns/system/fabrichat/room.tsx`), so it is a stream
  of the same instance and space. Under SS the batch of the worked send
  holds two events, and three transactions run before the wave commits.
- ES request 12 ("Staged events and effect requests") is marked met by SS
  §5.1, which states the other rule.

**Governs:** SS (the event queue and the batch).

**Correction:** ES §1.4: "It joins the queue when the transaction seals. An
event for a stream of the same space joins the batch (SS §5.1); an event
for a stream of another space leaves through the outbox after the commit
(SS §9.3)." ES §10.1 and §10.2: the batch holds the send and the `joined`
event.

**Weight:** misleads a reader.

### 4.6 A current stored value read by a cone: is the writer's instance loaded?

- ES §3.4: a read whose writer is in an instance that is not loaded
  "returns the stored value where the rows ... are at the heads of their
  inputs, and the instance is loaded only where they are not". ES §11,
  request 37 (marked met by SS §5.3): "Where they show the stored value
  current, the read returns it and the instance is not loaded, for a handler
  and for a body inside a cone alike."
- SS §4.4, third item, for a journaled read of a cone instance in a
  derivation transaction: "Where the basis index shows the address current,
  nothing more is evaluated, and the instance is loaded only where that
  demand stands, by the first item." The first item: "**Demand that stands**
  loads the instance: a session's tracked set, a render sink, an effect
  operation, a materializer, a warm request, and the registered addresses
  and slots of a cone instance that one of these demands".
- A cone instance evaluated in a derivation transaction is in most cases
  demanded by one of those sources. SS then loads the writer's instance
  although the stored value is current, and ES says it is not loaded.

**Governs:** SS (demand and loading), under question 56 of the plan, which
records this as an assumption beside the ruling.

**Correction:** ES §3.4 and request 37: "the instance is not loaded on
account of the read; standing demand that reaches it through the
registered address loads it (SS §4.4)". ES §2.4 needs no change.

**Weight:** misleads a reader.

### 4.7 Which derived writes a handler body's write withdraws

- SS Terms ("Derived write"): "A kept output, or a write edge of a cone. ...
  A conflict, the failure of the cone that staged it, or a handler body that
  wrote what its cone instance had read **withdraws** one".
- SS §3.5: "a body that wrote something a cone instance had read before the
  body ran withdraws the kept outputs of that cone instance that the body
  did not read by address". SS §5.2 and ES §1.6 ("A kept output evaluated
  before a handler body") state the rule for a kept output only, and so
  does PL §4.5.
- ES §2.7 covers the cone instance and not its writes: a state cell the
  handler wrote "makes that cone instance stale, for a later handler of the
  batch that reads it or for the derivation transaction."
- A cone evaluated before the body can also have staged a side-write to a
  state cell, a path of a child's argument, a path of an effect's request,
  or the record of the instances it made. The reason ES §1.6 gives for the
  kept output holds for each: "its label would otherwise be instantiated
  from the label the body staged, for a value computed from what was there
  before." No section says whether such a write is withdrawn.

**Governs:** PL §4.5 for the rule; SS Terms state it for every derived
write.

**Correction:** ES §1.6, SS §3.5 and §5.2, and PL §4.5: state the rule for
"a derived write", the write edges of the cone instance included, and say
that the memo entry of a cone instance whose side-write is withdrawn this
way is dropped, as ES §3.3 has it for a side-write a conflict withdrew.

**Weight:** misleads a reader.

### 4.8 A child's argument whose writer is in an instance that is not loaded

- ES §4.6: "The argument is part of the parent's keep set. ... A computed
  value passed to a child is therefore stored, in the child's argument
  document". ES §4.1: the argument document's identifier is "Derived from
  the result cell, linked from it". No document of ES §4.1 or §2.8 stores a
  link from a child to the instance that writes its argument.
- SS §4.3: the writer of a child's `argument` slot "is the `WriteEdge` with
  target `argument` of the cone of the parent, or of the computation that
  made the instance", when a loaded unit writes it. Otherwise SS §4.4
  applies, which finds an instance from "a path of a result cell" or "a
  document with a `result` back-link". SS §10.4, step 2, takes "the cone of
  each kept output at, above or below the path, or each cone with a write
  edge of kind `state` to the cell".
- SS §5.1: an event loads one instance, and "the instances that write what
  the handler reads are loaded only where what they wrote is stale (section
  5.3), which takes the place of starting the pieces a piece's inputs come
  from."
- So when a child, or an instance a computation made, is loaded by an event
  or by a watch and its parent is not loaded, a computed argument path is
  read as stored, and the rows of the parent's cone are not consulted,
  because nothing stored leads from the argument document to the parent.
  SS §1.5 (I4) does not list this among its exceptions.

**Governs:** SS. This extends question 57 of the plan, which records the
same limit for a write through a handle only.

**Correction:** SS §4.4 and §5.3 ("Which reads are checked"): name the
argument document beside the cell written through a handle, or have the
child's result document hold a link to the instance that writes its
argument and add write edges of kind `argument` to step 2 of SS §10.4. ES
§4.6 then stores that link.

**Weight:** misleads a reader.

### 4.9 Whether a materializer is valid after a restart or a reload

- ES §6.7: "The read set of its last run is the scheduler's record and is
  not stored here." "**If lost.** The materializer runs again."
- SS §2.4: "A materializer keeps the record a node has today: the read set
  its last run journaled, the trigger addresses that made it stale, a
  status, gates, and its declared write envelope." SS §10.4 keys a basis
  row by instance, cone, scope instance and input document. A materializer
  is not a cone (ES §6.7: "Not inside a cone and not through
  `host.invoke`"), so it has no row. SS §10.6 lists what recovery restores
  and does not name materializers.
- After a restart, or after its instance was released and loaded again, a
  materializer has no read set to register and nothing that says whether
  what it read has changed.

**Governs:** SS (materializers, the basis index).

**Correction:** SS §7.2 or §10.4: either a materializer has basis rows,
keyed by its operation in the place of the cone, with row entries until
its first run in the process, or every materializer runs once when its
instance is loaded. ES §6.7 "State" refers to the choice.

**Weight:** misleads a reader.

### 4.10 A materializer that cannot be promoted, and a handler that reads it

- ES §1.3: where the bound address of a handler's slot lies inside the
  envelope of an invalid materializer, "For a slot the materializer runs
  first, in its own transaction." SS §5.2, step 3, says the same, and SS
  §7.3: "A handler in the same position cannot be evaluated late."
- SS §7.2 ("A promoted run and its computed inputs"): where a stale cone
  instance that produces a computed input of the materializer performs a
  side-write, "the materializer is not promoted: it runs behind the
  derivation transaction, the reader that would have waited for it reads
  what is stored, and the materializer's write makes that reader stale". ES
  §6.7 has the same.
- For a reader that is a handler the two cannot both hold. The body runs
  once and is not made stale, and the derivation transaction is behind the
  batch.

**Governs:** SS (materializers, the event queue).

**Correction:** SS §7.2: say what an event does in that case, for example
that it holds its place and the batch ends before it, as for an event with
no row (SS §5.1). ES §1.3 and §1.4 refer to it.

**Weight:** misleads a reader.

### 4.11 A handler that receives an error state: does the rest commit?

- ES §1.7: "A handler body that throws aborts the event's transaction ...
  A handler that receives an error state for one of its inputs, because a
  cone instance it reads failed, fails in the same way." ES §3.3: when the
  transaction is aborted, "nothing it staged is stored."
- SS §5.5, row "A cone instance fails before the body": "Its outputs take an
  error state and the rest commits. If the handler reads the failed cone
  instance, the handler fails". SS §3.5: a failed cone instance's "error
  state is stored like a value, and its basis rows advance."
- Under ES the event's transaction is aborted, so the error state and the
  other kept outputs computed before the body are unstored and the rows do
  not advance. Under the SS row they commit. I am unsure which SS intends:
  the row may describe a failed cone instance that the handler does not
  read.

**Governs:** ES for the outcome inside the transaction; PL §5.4 ("the
handler receives an error state for that input and fails in turn") does
not say whether the failure aborts.

**Correction:** SS §5.5, split the row: where the handler does not read the
failed cone instance, the rest commits; where it does, the transaction is
aborted as for a body that throws, and the error state is unstored (SS
§3.5).

**Weight:** misleads a reader.

### 4.12 "Current" and "stale" in the Terms of ES

- ES Terms: "A cone instance is **current** when the memo holds an entry
  for it and nothing that entry records as read has changed. A cone
  instance that is not current is stale, in the sense of
  `scheduler-and-serving-loop.md`."
- SS Terms ("Stale"): "In a process that holds a memo entry for the cone
  instance, the entry decides ... In a process that holds none, after a
  restart or a load, the basis rows decide". ES §3.4 agrees with SS: "A cone
  instance whose rows are at the heads of its inputs is current in storage:
  its kept outputs ... are not evaluated".
- By the ES definition every cone instance without a memo entry is stale
  "in the sense of" SS, which SS and ES §3.4 deny. This is what is left of
  finding 6 and finding 25 of the first cross-read.

**Governs:** SS (which cone instances are stale).

**Correction:** ES Terms: "... or, where the process holds no entry for it,
when its basis rows are at the heads of their inputs (section 3.4)."

**Weight:** misleads a reader.

### 4.13 Transactions that do not commit: two cases named, four exist

- ES §3.3 ("A transaction that does not commit"): "When an event's
  transaction is rejected by a constraint on the handler's own writes, or
  aborted because the body threw". SS §3.5: "A write does not reach storage
  when its event's transaction is rejected or aborted, when a constraint
  drops it, or when a conflict withdraws it at the commit."
- Two more exist. ES §1.4 and SS §5.3: an attempt "is withdrawn whole" at a
  journaled read. SS §5.5: an event "is requeued whole", and "The event's
  transaction is withdrawn whole" when a withdrawal reaches the handler's
  unit. Neither list says what the memo and `InstanceRecord.unstored` hold
  for the cone instances evaluated in such a transaction. SS §1.5 (I3) has
  the general form: "A transaction that does not commit".

**Governs:** ES for the memo, SS for the record.

**Correction:** ES §3.3 and SS §3.5: name the withdrawn attempt and the
requeued event with the rejected and the aborted transaction.

**Weight:** wording only.

### 4.14 "Both happen before the transaction opens"

- ES §1.3 ("A writer in an instance that is not loaded"): "Where they show
  it stale, the instance is loaded and the stale cone instance that writes
  the address is evaluated first. Both happen before the transaction opens
  (§5.2 there)."
- SS §5.2: the check and the load are step 2, "before the transaction
  opens"; the evaluation is "Before the body", inside the transaction. SS
  §5.3: "**No preflight transaction.** The stale cone instances the handler
  reads are evaluated inside the event's transaction".
- Read with the sentence before it, "Both" takes in the evaluation.

**Governs:** SS.

**Correction:** ES §1.3: "The check and the load happen before the
transaction opens; the evaluation is in the transaction, before the body."

**Weight:** wording only.

### 4.15 The instance record "is not dropped under memory pressure"

- ES §3.1: the trigger reads "are part of the scheduler's instance record,
  which is not dropped under memory pressure
  (`scheduler-and-serving-loop.md` §3.4)."
- SS §3.4 says that of the memo ("which the runtime may drop under memory
  pressure") and not of the record. SS §4.7: an instance with no demanded
  output "stays loaded until the runtime releases its record. ... When to
  release is a matter of memory and is decided with the memo's retention".

**Governs:** SS.

**Correction:** ES §3.1: "which is not dropped while something demands the
instance".

**Weight:** wording only.

### 4.16 Two statements in SS about ES that ES has since settled

- SS §2.7: "*Assumed:* the transaction that tears an instance down marks
  every instance that belongs to it as well ... `execution-and-storage.md`
  §2.8 states the mark for the instance itself (open question 30)", and SS
  question 30 repeats it. ES §2.8 now states it: "The same transaction
  writes the mark for every instance that belongs to the torn-down one: its
  children of the reactive tier, the instances its own computations made,
  and the instances that belong to those in turn." ES request 39 is marked
  met by SS §2.7, so each document cites the other for the rule.
- SS §3.2 (row `operation`): "the element key is a part of the document's
  identifier or a segment of the path, whichever layout
  `execution-and-storage.md` chooses". ES §6: "This document chooses one
  document per key. The element key is a step of `within` in the
  identifier".

**Governs:** ES (what is stored).

**Correction:** SS §2.7 and question 30: mark as met by ES §2.8 and drop
"Assumed". SS §3.2: "the element key is a step of `within` in the
document's identifier (`execution-and-storage.md` §6)".

**Weight:** wording only.

### 4.17 Which part documents a client cannot name

- ES §4.10: `key` is hashed under the secret "for every key: a cell's
  identity is hashed under the secret as a plain value is", and "No client
  derives the identifier". ES §5.3: a client "cannot derive the identifier
  of a part document at or below a row of a kept collection". PL §2.3 has
  the same.
- SS §11.1 (table) and §11.6 limit it to "A part document of a row keyed by
  a plain value".
- Nothing follows for behavior, since a client names the result cell and a
  path in both documents.

**Governs:** ES and PL §2.3.

**Correction:** SS §11.1 and §11.6: "a part document at or below a row of a
kept collection".

**Weight:** wording only.

### 4.18 "Everything a handler creates" is named by the handling

- SS §5.5: "Everything a handler creates without an explicit cause is named
  by the handling and its order among the handler's requests". SS §11.6 has
  the same sentence with "What a handler creates".
- ES §5.4: "**A binding** made in a handler is identified as in section 5.5",
  and ES §5.5: "A binding made in a handler is identified the same way and
  not by the handling." PL §1.3: "A handler binding is the exception".
  SS §11.1 has it right.

**Governs:** PL §1.3.

**Correction:** SS §5.5 and §11.6: "Every cell, instance and effect a
handler requests".

**Weight:** wording only.

### What I checked and found consistent

- Two kinds of transaction, one derivation transaction behind the batch,
  storage changes of the cycle in the same one (ES §1.1, §1.2; SS §5.2,
  §10.2).
- What is evaluated before a body; a static read through a handle is a
  slot; a journaled read is made current at the read (ES §1.3, §1.4, §2.4;
  SS §5.2, §5.3).
- The read whose writer is in an instance that is not loaded, for a
  handler: rows decide, withdrawal and second dispatch where stale (ES
  §1.3, §1.4; SS §4.4, §5.3, §10.4). For a body inside a cone: not waited
  for, evaluated again (ES §2.4; SS §4.4).
- Early instantiation of a write the body reads by address, and that it is
  not withdrawn (ES §1.6; SS §5.2; PL §4.5).
- Rejection, dropped write, conflict withdrawal with the using units,
  requeue of the event (ES §1.7, §1.9, §3.3, §3.5; SS §5.5, §5.6).
- Unstored against stale; the memo holds the value, the record the
  refusal; basis rows not advanced; a failed evaluation advances them (ES
  §3.3; SS §2.2, §3.5, §10.4).
- The bound of ten: cone evaluation counts, the eleventh fails, readers of
  a withdrawn side-write do not fail, no evaluation until an input changes,
  no gate (ES §2.7; SS §8.1, §8.2, §8.4).
- Slots resolved on first read; unselected branches (ES §2.2; SS §2.2,
  §4.3).
- Element tables built by evaluation; bindings per slot and position;
  entries registered from the table (ES §2.5, §3.1; SS §2.2, §3.2).
- Trigger reads held with the record, handed to the preparation, kept
  until every write is stored (ES §1.9, §3.1, §7.2; SS §3.4).
- Instances a computation makes: identity, record when demanded, cones
  evaluated after the invocation ends, failed evaluation, changed factory,
  effects, acting principal of an `inSpace` step, refusal at space scope
  (ES §2.8; SS §2.7, §9.3, §10.3).
- Demand per kept path, the watch on a part document, the client decides
  no split (ES §4.10; SS §4.2, §11.6).
- Stream document, first append creates it, one row of the stream index
  (ES §4.7, §4.9; SS §5.1).
- Effects: request as write edges, the request transaction, the handler's
  request, completion as its own transaction, `navigateTo` on a client (ES
  §6.4; SS §6.2, §6.3, §6.5, §6.7).
- Materializer result through an `operation` slot; computed inputs from
  the memo (ES §6.7; SS §7.1, §7.2).
- The steps for a created space and the name of the allocation record (ES
  §5.6; SS §9.4; plan question 15).
- Migration as a setup transaction; both kinds of instance in one space;
  the carry-over record read at binding (ES §9.3, §9.4; SS §3.2, §10.8).
- The handling as the receipt; sent events named by the handling (ES §5.4;
  SS §5.5, §11.6).
- ES requests 5 to 11, 35 to 40 and 48 against the SS sections cited, and
  SS questions 11 to 16 and 26 against the ES sections cited, apart from
  ES request 12 (4.5), ES request 37 (4.6) and SS question 30 (4.16).
- "Cone instance", "evaluation", "unstored", "loaded", "handling": one
  meaning. "Unit": SS Terms separate the scheduler's unit from the unit of
  the preparation that ES §1.9 uses.
- The record fields ES and SS name exist in PL §1.1 with the kinds they are
  cited for.

### What I did not read in full

- ES, SS and the plan: read in full.
- First cross-read: section 3 only.
- PL: read §1.1 for field names only; §4.1, §4.4, §4.5, §4.6, §5.2, §5.3
  and §5.4 in full; parts of §1.3, §2.3, §2.6 and §3.14. Not read: the rest
  of §1 to §3, §4.2, §4.3, §5.5, §6, §7, §8. Where ES or SS cite those, I
  did not open them.
- BI: one section. OV, LS, FA: not read.
- Source: `patterns/system/fabrichat/room.tsx` for `joined` only. The other
  source citations of ES and SS are unverified by me. I did not check how
  ES §9.2's row for a migrated stream fits `streamEntriesDocId`.

## 5. The overview, `language-subset.md`, and `builtin-inventory.md` against each other and the rest

I read OV, LS, and BI in full, and the plan's "Decided", both "Open" lists,
and "Known limits". In the others I read the sections these three cite or
summarize: PL Notation, §1.2 to §1.4, §3.1, §3.5, §3.8, §3.13 to §3.19,
§3.21, §3.22, §4.1, §4.4, §5.2, and §8, with the `Body` and `StateCell`
records of §1.1; FA Notation, §1, §2, §3.1 to §3.4, §3.6, §3.8, §4 to §8,
and §13; ES Terms, §1.1, §1.2, §1.7, §2.1, §2.5 to §2.8, §4.1, §4.2, §4.10,
§5.1 to §5.7, §8.5, §9.2 to §9.4, and the headings of §11; SS §1, §2.1,
§2.7, §4.1, §4.2, §4.5, the start of §5.1, §5.3, §5.4, §6, §7.1, §7.2, §8,
§9.2, the start of §9.4, and §11. I searched all seven documents for
diagnostic identifiers and compared each use with its row in LS §10. Where
a finding says "by source" I opened the file named. Corpus counts are left
out.

### 5.1 Promoting a `computed` that binds a handler changes the binding

- LS §6.1: "JSX with host elements is allowed in a promoted body, and so
  is an inline event handler in it, which is then a tier-R handler (§4.5)."
- LS §6.2: "A promoted `computed` computes the same value as the
  unpromoted one. Three things differ, none of them in the value" (labels,
  cost, granularity), and "Promotion never changes whether a program is
  accepted."
- LS §4.6 and PL §3.14: a binding made in tier R "copies nothing" and its
  stream "is named by the binding's `name` and `within`". LS §5.2 and PL
  §3.14: a binding made while a function body runs copies a scalar ("The
  value is the one the body had when it made the binding"), has a binding
  state document (ES §4.1), and its stream is identified by what it holds.
  So the stream link in the result of the `computed`, the documents that
  exist, and when the handler reads a captured scalar all differ between
  the promoted and the unpromoted form. SS §11.1 adds a fourth difference:
  a client can name the first stream and not the second.
- LS §4.4.1: a per-element body "over a collection of plain values is
  refused when it declares a state cell or binds a handler, in any of the
  spellings of §5.2, without using the index parameter". PL §3.14: "in a
  function body, where a binding is made in an ordinary loop, equal state
  gives one stream." So the `computed` below, with `glazes: string[]`,
  meets §6.1, is promoted, and is then a tier-R `map` over plain values
  that binds a handler without the index: a compile error. Unpromoted it
  is legal.

  ```tsx
  // Shown for illustration only.
  const rows = computed(() =>
    glazes.map((g) => <li onClick={() => chosen.addUnique(g)}>{g}</li>)
  );
  ```
- LS §6.1, condition 5, refuses to promote a `computed` that instantiates
  a pattern for the same kind of reason: "Promoting the call would change
  which documents exist and how the state inside is named."

**Governs:** the ruling on what a binding holds fixes both binding rules,
so the promotion criterion (LS, which owns it) has to give way.

**Correction:** LS §6.1: add "binds no handler" to condition 5, with the
reason given there for an instantiation, and delete "and so is an inline
event handler in it, which is then a tier-R handler". LS §11.5 then needs
its counts taken again.

**Weight:** blocks an implementer.

### 5.2 API calls that BI keeps have no row in LS §4.4 and no rule in FA

- LS §4.4: "A call that matches none of the rows is refused
  (`reactive:unsupported-call`)." The last row covers "A structural or
  effectful built-in (`wish`, `anchorsOf`, `inspectConfLabel`, the fetch
  family, the language-model built-ins, `navigateTo`, and the others)".
- BI, "`sqliteDatabase`": "class C. It declares a state cell of kind
  SQLite, in the same family as the cell constructors below". It is
  neither structural nor effectful, LS §4.7 does not list it among the
  constructors, and LS names it nowhere, although LS §4.7 has `query` and
  `exec` on "A SQLite handle". PL's `StateCell` (§1.1) has a name, a
  scope, `within`, and a schema, and no kind and no table declarations.
- BI, "Tool and factory helpers": "`uiVariant(piece, kind)` | ... |
  Unchanged; a pure function." BI, "Pure functions and constants": "The
  remaining exports create nothing and read no frame. They are unaffected
  by the design", among them `valueEqual`, `getEntityId`,
  `entityRefToString`, `renderCellReference`, `parseDID`, the debug
  formatters, and `cfLink`. LS §3.2 speaks of the other API functions for
  module scope only. LS §4.4 has no row for them in tier R, and LS §9
  does not list them.
- FA §3.4: "Every member `language-subset.md` §9 lists has a rule". These
  functions are not members of §9, and FA §3.6 has summaries for
  authored functions only, so a call of `valueEqual(a, b)` or
  `getEntityId(x)` in a body has no transfer rule.

**Governs:** BI for which exports remain; LS for where a call is legal; FA
for what a call records.

**Correction:** LS §4.4 and §5.1: add a row for the pure API functions BI
lists, with the tier each is legal in, and add `sqliteDatabase` to the
declarations of §4.7. FA §3.4: one rule for those functions (which read
their operand's value and which its identity). PL §1.1: say how a
`sqliteDatabase` declaration is recorded.

**Weight:** blocks an implementer.

### 5.3 `X.for(cause)` in tier R has no rule for the cell's identifier

- LS §4.7: "`for(cause)` | Every handle type ... | R, F on a handle" and
  "`new X(value)`, `X.of(value)`, `X.for(cause)` ... | R, F | Creates a
  cell. In tier R it is a state cell of the plan."
- LS §10.3, `collection:shared-element-state`: "Take the index parameter
  and use it, for example in the cell's cause."
- PL §1.3: "A state cell's document identifier derives from the cause of
  its creation: the instance, the steps of `within`, outermost first, and
  `name`." `StateCell` in PL §1.1 holds `name`, and no cause. The
  preimages of ES §5.2 hold the name and no cause. PL §1.3 gives an explicit
  cause a place only for what a function body creates ("to `createCell`
  or with `.for(...)`").
- A cause in tier R is a tier-R expression, so it can be data
  (`Writable.for(donut.id)` in a `map` body).

**Governs:** PL (identifiers and records).

**Correction:** either LS §4.7 restricts `X.for(cause)` and `h.for(cause)`
to tier F, and the message of `collection:shared-element-state` drops "in
the cell's cause"; or PL §1.3 and `StateCell` state what an explicit cause
in the reactive tier contributes and whether it may be data.

**Weight:** blocks an implementer.

### 5.4 A position of factory type has no class in the footprint analysis

- LS §1: "A factory type is a data type, although calling it looks like
  calling a function." LS §7.2: a factory value "may sit in a pattern
  input or result, a cell, a handler's state, or an event". LS §4.4.2:
  `{ onSave: saveDonut }` "puts a handler factory in a data position".
- FA Notation defines four kinds of type: scalar ("a primitive type, a
  literal type, or a union of those"), container, handle, and reference
  ("`unknown` in a data type"). FA §2.2: "The class an operation needs
  depends on the static type of the position it is applied to", with those
  four columns. FA §3.8's table of what leaves a body has rows for the
  same four.
- FA records a factory only where it is the callee (§8.1, §8.5:
  "`identity` at the position that holds it"). A body that tests a factory
  for presence, compares two, returns one, stores one in a cell, or puts
  one in an argument has no row.
- LS §4.4.1 calls a factory element "Always plain", keyed by its value,
  while PL §3.15 and §3.21 observe the slot that holds a factory for
  `identity`.

**Governs:** FA for the classes; PL §3.15 and §3.21 for what a factory's
slot is.

**Correction:** FA Notation and §2.2: add the factory type, with the
column it takes (the reference column fits PL: `identity` when passed on
or compared, `shape` for a test of presence).

**Weight:** blocks an implementer.

### 5.5 What an inline `pattern(...)` in a function body may capture

- LS §4.3: an identifier in tier R is "A `const` of the body, a parameter,
  a module-scope constant, an import". LS §4.4.2, "Captures", allows
  references to "`const` bindings and parameters of the enclosing tier-R
  bodies". The "Tier F" item there says only that an inline pattern is
  "legal only as the callee of an instantiation".
- LS §4.7, correction 1, and the ruling it implements:
  `pattern(() => donuts.map((donut) => donut.name))({})`, where `donuts`
  is a local of the function body.
- PL §3.15, "Written at an instantiation in a function body": "Each
  parameter path is bound as a path of a handler's state is bound in a
  function body". FA §8.1 records the captures the same way.
- For the handler spelling LS §5.2 has the rules: "A captured `let` is
  refused (`function-body:handler-capture`)" and a function value is
  refused (`ses-callback:callable-capture`). For an inline pattern in tier
  F no rule and no catalog entry says whether a `let`, a function value,
  or a code-typed local such as a `Map` may be captured.

**Governs:** LS (the grammar). The binding rule is PL's assumption (plan
question 48).

**Correction:** LS §4.4.2, "Tier F": state that the callback may refer to
the `const` bindings and parameters of the enclosing function body, that a
captured value is a data value or a cell handle, and that a captured `let`
and a captured function value are refused, and widen the two catalog
conditions to name the inline pattern.

**Weight:** blocks an implementer.

### 5.6 Elements of a computed list: plain in LS and BI, references in FA

- LS §4.4.1: an object, array, or tuple element type "is plain when the
  collection is a value computed in the program: an array literal, a
  module-scope constant, the result of a tier-R construction such as
  another `map` that builds object literals, or the result of a
  `computed`, a `lift`, or an authored function."
- BI, "Element keys": "Plain-value elements are primitives, and records
  in an array that a computation returned, which are stored inline."
- FA §3.8: a returned container is kept "**by reference**: what is stored
  is a link to where the value was read", a bag is treated member by
  member, and `Body.outputs` records `reference: { passes }` for a result
  path that holds one projection of container type. BI, "References",
  says the same. So the elements of
  `computed(() => { ...; return donuts.filter(isFresh); })` are links to
  the original records, and PL §1.3 keys "the **identity of the cell** the
  slot links to, when it holds a link".
- PL §1.3: "The compiler reports the error where the element type is a
  primitive, or the collection is one the instance constructs inline."
  That list has no result of a body.
- A promoted `computed(() => donuts.filter(...))` is a tier-R `filter`,
  whose elements are "the source's elements, with their keys" (PL §1.3),
  and it is also "the result of a `computed`".

So LS reports `collection:shared-element-state` for a body over a list
whose elements the runtime identifies by their cells.

**Governs:** PL §1.3 for the key (what the slot holds), with the reference
rule, which is plan question 10. LS owns the diagnostic.

**Correction:** LS §4.4.1: the result of a `computed`, a `lift`, or an
authored function is plain at its element path only where the body's
record has no reference there, that is, where the body built the records;
the result of a tier-R `filter`, and of a promoted `computed`, has the
plainness of its source. BI, "Element keys": "records in an array that a
computation built".

**Weight:** misleads a reader.

### 5.7 A function called from tier R, and `assert`, have no column

- LS §5.2 has two columns, "`handler`, `action`, inline event handler"
  and "`lift`, `computed`", and "An authored function is held to the rules
  of the bodies that call it."
- LS §4.4: an authored function called in tier R is a "Sandboxed call",
  and `assert(f)` has a tier-F body. FA §1.2: "An authored function called
  from the reactive tier | ... | A body of kind `function`", and
  "`assert(...)` | ... | Analyzed as a `computed`". Neither has a calling
  body.
- Read by "the rules of the bodies that call it", the caller is the
  pattern body, where BI's table has "Request an effect | ... | Yes". PL
  §3.14 has "`effect`, legal in a handler and an action".
- The catalog conditions of `function-body:cell-needs-cause` and
  `function-body:effect-in-computation` name "a `lift` or a `computed`"
  only. `function-body:ambient-read` names tier R as well.

**Governs:** PL §3.14 for the effect; LS for the table.

**Correction:** LS §5.2: an authored function called from tier R, and an
`assert`, are held to the rules of a `lift`. Add both to the conditions of
the two catalog entries.

**Weight:** misleads a reader.

### 5.8 The overview's example calls `sum` as a function

- OV, "An example":
  `const total = computed(() => sum(prices.map((p) => p.price)));`
- LS §4.4 lists an aggregate with "A selector or predicate callback where
  the method takes one", and LS §4.7 lists `sum` among the methods
  "Declared on `Cell`, `OpaqueCell`, of an array". BI: "Reached through
  the cell methods `count()`, `sum()`, `min()`, `max()`". By source,
  `sum(this: AnyBrandedCell<number[]>): Reactive<number>` is a method in
  `base/api/index.ts`, and that file exports no function `sum`.

**Governs:** LS and BI.

**Correction:** OV: `prices.map((p) => p.price).sum()`, or drop the
`computed`, which LS §12.2 calls redundant here.

**Weight:** misleads a reader.

### 5.9 The overview's list of open decisions is a small part of the plan's

- OV, Status: "The decisions the design still depends on are listed under
  [Open questions](#open-questions)". The plan's table gives OV "the open
  questions that cut across documents".
- OV's list has eight entries. Six correspond to plan questions 15, 20,
  23 with 33, 24 to 26, 38, and 54, and each is still open. The plan's
  "Open, and needing the owner" has 6 to 11, 15 to 17, 19 to 21, and 23
  to 58.
- Some of the missing ones qualify sentences OV states without
  qualification: question 39 ("withdraws that write alone, with the
  writes that used what it staged"); question 40, a possible third
  exception, against "with two deliberate exceptions" and "expects these
  two differences and no other"; question 48 ("the values a handler
  binding or an inline pattern copies"); question 19 (what a handler
  creates is "identified by the handling"); question 27 ("its stored value
  is found through a carry-over record").

**Governs:** the plan.

**Correction:** OV, Status: "The questions that cut across documents are
listed under Open questions. The continuation plan lists every question
the owner has still to rule on." Mark the five sentences above as assumed,
with the plan's number.

**Weight:** misleads a reader.

### 5.10 LS §13 names two owner questions; the plan has two more of LS's

- LS §13: "Questions 9 and 14 need a decision from the project owner ...
  The others do not." The same section lists under "Decided in this
  document": "a `computed` that instantiates a pattern is not promoted
  (§6.1)".
- Plan, "Open, and needing the owner", question 49: "**A `computed` that
  instantiates a pattern is not promoted** (LS §6.1)". Question 28:
  "**When the identity-alias typings are published** (A14). Until they
  are, an accepted program can show an editor error, against rule 2 of
  the language subset."
- LS §8.6.1 states the timing as settled ("The typings change when the
  transformer, which reads the brands, is retired") and LS §2, rule 2, is
  stated without the exception.

**Governs:** the plan.

**Correction:** LS §13: move the promotion sentence to an entry marked
*assumed* that names plan question 49, add an entry for plan question 28,
and correct "The others do not".

**Weight:** misleads a reader.

### 5.11 `db.query` is tier R only; `sqliteQuery` is legal in a handler

- LS §4.7: "`query(sql, params?)` | A SQLite handle | R | Reads. Sugar
  for the `sqliteQuery` built-in".
- LS §5.2: "Request an effectful built-in | As `builtin-inventory.md`
  lists | Yes" for a handler. BI lists `sqliteQuery` as class B and
  "`db.query(sql)` | Creates a `sqliteQuery` node. | B: sugar for
  `sqliteQuery`."
- No catalog entry reports a declared handle method called in a tier its
  "Tiers" column excludes, other than `cell:collection-method-in-function`.
  The same holds for `set` or `sample` written in tier R.

**Governs:** LS for the method surface; BI for the class.

**Correction:** LS §4.7: give `query` the tiers of an effect request ("R;
F in a `handler` or an `action`"), and say under which identifier a method
called outside its tiers is refused.

**Weight:** misleads a reader.

### 5.12 A body that reads its own write target: a cycle in SS, not in LS

- LS §10.3, `side-write:cycle`: "A body that reads its own write target is
  reported as `side-write:not-idempotent` and not here".
- SS §8.2: "an edge from a cone to itself or to a cone with a lower index
  is on a cycle ... The compiler reports such a cycle as a warning that
  names the side-write, `side-write:cycle`". FA §6.6 calls the same shape
  "the smallest cycle through a side-write".

**Governs:** LS (the catalog).

**Correction:** SS §8.2: "an edge to a cone with a lower index, or from a
cone to itself where no body of the cone reads its own target".

**Weight:** misleads a reader.

### 5.13 FA reports differences from LS and a debt of BI that are gone

- FA §13, request 5: "Two wordings there differ from this document. The
  hint `footprint:widened` names one input path ... And
  `side-write:not-idempotent` says all three shapes write something else
  on a second run whatever the data".
- LS §10.3 now has: "The report names what the widening covers: the input
  paths of the widened entries, which are several for a key that is not
  static, or the cell handle", and "Two write something else on a second
  run whatever the data ... The third does so unless the write settles".
- FA §13, request 7: "What the inventory still owes is the request
  `plan-and-label-templates.md` makes of it (open question 21 there)". PL
  §8, question 21: "Met: the entry of each effectful built-in has a
  "Request operands" paragraph". BI has those paragraphs.

**Governs:** LS and BI, which now meet both.

**Correction:** FA §13: delete the last three sentences of request 5 and
the last sentence of request 7.

**Weight:** misleads a reader.

### 5.14 "Read first" is not a correction for half of the collection methods

- LS §4.7 and §10.2, `cell:collection-method-in-function`: the condition
  is "`map`, `filter`, or another collection method of §4.7", sixteen
  methods, and the second correction is `cell.get().map(...)`.
- LS §9.2 lists no `count`, `sum`, `min`, `max`, `minBy`, `maxBy`,
  `groupBy`, or `keyBy` on an array, so `cell.get().sum()` is
  `stdlib:unsupported-member`.

**Governs:** the ruling names the correction for `aCell.map(...)`; LS owns
the rest.

**Correction:** LS §4.7, note 4: for an aggregate or an index method the
second correction is `get()` followed by a loop or a JavaScript `reduce`.

**Weight:** wording only.

### 5.15 BI's "Decisions" and two of its questions against the plan's lists

- BI, "Decisions": "The project owner has decided the following",
  including that `navigateTo` requires a result cell, and "**`asScope`
  and `inSpace`** are part of the instantiation syntax". The plan's
  "Decided" has neither. BI marks one other entry of the list as "not a
  ruling of the project owner".
- BI, open question 11: "*Assumed,* and not in that question: `inSpace`
  is legal on the callee". That is plan question 50. BI, open question 6,
  names plan question 8 and not question 51, which the plan gives as "(BI
  question 6)". BI's own rule: "A question that is with the project owner
  names its entry".

**Governs:** the plan.

**Correction:** add the two rulings to the plan's "Decided" if the owner
made them, or mark them in BI as stated by the documents; name questions
50 and 51 in BI's questions 11 and 6.

**Weight:** wording only.

### 5.16 PL §3.17 calls the collection index "the one rule" that is looser

- PL §3.17: "**This is the one rule that is looser than today.**"
- PL §3.1: "**There are two exceptions**, both deliberate." OV, "Label
  templates": "with two deliberate exceptions". The plan's "Decided"
  lists both.

**Governs:** the ruling.

**Correction:** PL §3.17: "This is one of the two rules that are looser
than today (section 3.1)."

**Weight:** wording only.

### 5.17 Small mismatches between LS and the documents it cites

- **`void` in a function body.** LS §4.3 refuses `void` in tier R, and LS
  §5.1 allows "Every tier-R form, and in addition" a list without `void`.
  FA §3.2 has a rule for it: "Assignment to a local, the comma operator,
  `void` | None". LS §5.1 should allow it or refuse it by name.
- **`asSchema`.** BI, "Cell methods that create nodes": "`key(...)`,
  `asSchema(...)`, `get()`, ... | No node. | Cell operations." LS §4.7:
  `asSchema` is "not part of the language (`cell:unsupported-method`)". BI
  should drop it from that row.
- **What replaces the refused globals.** LS §9.11: "The effectful
  built-ins of `builtin-inventory.md` replace the first four", which are
  `Promise`, `fetch`, timers, and `structuredClone`. BI has the clock of
  `wish` for timers, which is class A, and nothing for `structuredClone`.
- **The writer binding.** LS §10.5, `cfc-write-authorized-by`: "Name a
  `handler(...)`, `module(...)`, or `requireEventIntegrity(...)` binding".
  LS §3.2 has three module-scope builders, `pattern`, `lift`, and
  `handler`, and BI's inventory of the surface has neither of the other
  two names.
- **The write floor.** LS §10.5, `cfc-flow:write-floor`, tells the author
  to change "the floor declared on the target". LS §8.1 has no annotation
  that declares one, and PL §4.4 says "No key in this table yields a
  `writeFloor` constraint" (its open question 15, which assumes
  `requiredIntegrity` on a path a body writes). LS §8.1 or the catalog
  row should name that annotation as the assumed one.

**Governs:** LS for the first, fourth, and fifth; LS over BI for the
second; BI for the third.

**Correction:** as each item says.

**Weight:** wording only.

### What I checked and found consistent

- The three tiers, the directive, and where the verifier runs (OV, LS,
  plan).
- What the compiler emits, and the cone partition (OV, PL §1.4, ES §2.1).
- The two exceptions to "equal or tighter" (OV, PL §3.1, FA §1.4, §7.2).
- The four kinds of cause and the two kinds of transaction (OV, PL
  Notation, ES §1.1, §1.2).
- The five outcomes of a failure (OV, PL §4.4, §5.2, ES §1.7).
- Element keys, the index, the salt, and what a client cannot name (OV,
  LS §4.4.1, BI, PL §1.3, ES §5.3, SS §11.1).
- The bound of ten evaluations and what follows it (OV, PL §5.2, ES §2.7,
  SS §8.1).
- The keep set, split points, and part documents (OV, ES §4.10, SS §4.2).
- State cell naming and what stays byte-identical (OV, LS §4.6, PL §1.3,
  ES §5.2, §5.7).
- The cache directive has no authored form (OV, LS §13 question 10, PL
  §1.4, ES §8.5).
- The table of which body may make which call (LS §5.2, BI, PL §3.14, FA
  §8).
- What a binding holds and its identity (OV, LS §5.2, BI, PL §3.14, FA
  §8.5, ES §5.5).
- An instance a computation makes: identity, argument, teardown, failed
  evaluation, effects (OV, LS §5.2, BI, PL §3.14, ES §2.8, SS §2.7).
- The `inSpace` identifiers and the order of the commit steps (OV, BI, PL
  §3.14, ES §5.6, SS §9.4).
- The scheduler's five responsibilities and its three units (OV, SS §1.6,
  §2.1).
- A journaled read is made current at the read (OV, SS §5.3).
- `navigateTo` as the one effect a client enacts (OV, BI, SS §6.7).
- The gates a client evaluates, and FabriChat's send gate (OV, SS §11.3,
  §11.4).
- Removed forms and their replacements; the eight `WithPattern` methods
  (LS §4.4.3, §10.2, BI).
- Context reads: the record of each and where each is legal (LS §5.2, BI,
  PL §3.16, FA §8.4).
- Every diagnostic identifier used in BI, PL, FA, and SS has a live row
  in LS §10, with the one difference of 5.12. OV and ES use none.
  `capability:unreadable-cell-argument` in FA §10.2 is today's identifier,
  used as such.
- LS §8.1's annotation keys against PL §4.4's table: every key is placed
  or named as having no rule.
- LS §5.4 against FA §1.3; LS §7.8 against FA §2.2 on `unknown`.
- FA §3.4 covers every member of LS §9, by a row or by a default.
- BI's label rule for `ifElse`, `str`, `map`, `filter`, `flatMap`, the
  aggregates, the index family, `reduce`, `findIndex`, `some`, `every`,
  `find`, `anchorsOf`, `cellFromUrl`, and `wish` against PL §3.5 to §3.19.
- LS §13 questions 7, 10, 11, 12, and 13 against ES questions 27 and 26
  and FA requests 6, 14, and 17; BI's questions 1, 3, 10, 12, and 13
  against plan questions 30, 15, 32, 19, and 6.

### What I did not read in full

- PL: §1.1 apart from `Body`, `StateCell`, and `Operation`; §2; §3.2 to
  §3.4, §3.6, §3.7, §3.9 to §3.12; §4.2, §4.3, §4.5, §4.6; §5.1, §5.3 to
  §5.5; §6; §7.
- FA: §3.5, §3.7, §9 to §12.
- ES: §1.3 to §1.6, §1.8, §1.9, §2.2 to §2.4, §3, §4.3 to §4.9, §6 apart
  from §6.2, §7 apart from the start of §7.2, §8 apart from §8.5, §9.5
  to §9.8, §10, and the text of §11 apart from its owner questions.
- SS: §2.2 to §2.6, §3, §4.3, §4.4, §4.6, §4.7, most of §5.1, §5.2, §5.5,
  §5.6, §7.3, §7.4, §9.1, §9.3, the end of §9.4, §10, §12.
- The first cross-read record: its headings and the first two findings of
  its section 3 only, for the form.
- I did not check OV's statements on provenance (ES §7.2), on migration
  (ES §9, SS §10.8), or on cache promotion (ES §8) beyond the sentences
  those sections open with.
