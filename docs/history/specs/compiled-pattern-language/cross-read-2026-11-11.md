---
status: historical
created: 2026-11-11
archived: 2026-11-11
reason: "Review snapshot: the contradictions found by reading the seven compiled
pattern language documents against each other at labs 905384d87c."
---

# Compiled pattern language: cross-read of the seven documents, 2026-11-11

This is the record of one review. On 2026-11-11 the seven documents under
`docs/specs/compiled-pattern-language/` were read against each other at labs
commit `905384d87c`, the first commit that holds all seven. Three of them,
`footprint-analysis.md`, `execution-and-storage.md`, and
`scheduler-and-serving-loop.md`, had been written that day by three authors
working in parallel, none of whom saw another's draft. The review lists every
place where two statements cannot both hold, where one document assumes
something of another that the other does not provide, where a reference points
at the wrong place, and where an open question has since been answered.

Nothing in the seven documents was changed by the review. The questions it
leaves for the project owner, and the order in which the corrections are to be
made, are in the continuation plan,
[`docs/plans/compiled-pattern-language.md`](../../../plans/compiled-pattern-language.md).

## How to read this record

The record has five sections, each from a different reader:

1. what the four authors of that day reported while writing;
2. where draft pull request #91 in `commonfabric/specs` differs from
   `plan-and-label-templates.md`;
3. `execution-and-storage.md` against `scheduler-and-serving-loop.md`;
4. `footprint-analysis.md` against the other six;
5. the overview and the first three detailed documents against each other.

Sections 3 to 5 are each one reader's report, in that reader's words and
first person, and each ends by stating what the reader did not read in full.
A reader was given section 1 before starting and was told not to repeat it,
so a finding in sections 3 to 5 is either new or says which entry of section 1
it extends.

Findings are numbered within their section: K1 to K19 in section 1, 1 to 26
in section 3, F1 to F21 in section 4, and A, B, C, and D numbers in section 5.
Each finding of sections 3 to 5 names the documents and sections on both
sides, which side governs, and the smallest correction. "Governs" follows the
continuation plan: a detailed document governs the overview, and each
document owns its subject.

Abbreviations: OV is `README.md` (the overview), LS `language-subset.md`, PL
`plan-and-label-templates.md`, BI `builtin-inventory.md`, FA
`footprint-analysis.md`, ES `execution-and-storage.md`, and SS
`scheduler-and-serving-loop.md`. "ES Qn" and "SS Qn" are the numbered entries
of that document's open-questions section. "The Decided list" is the list of
the owner's rulings in the continuation plan.

Where a finding says "by source", the reader checked the current system and
names the file and function. Every other statement about the current system
in the seven documents was left unverified by this review.

## 1. Reported by the authors while writing

These were reported by the authors of the three new documents and by the
author of the specification change of section 2, each in a closing report.
They are stated here in one line each, without the correction, because the
authors were not asked for one.

### Between the original four

- K1. BI "Element keys" says the plan records the key in `Collection.key`; PL
  has `Collection.bodyUses` and no `key`.
- K2. BI says the value code "has to report" the position origins of
  `filter`/`flatMap`; PL §3.7 says nothing is reported by emitted code.
- K3. `inspectConfLabel` on an interim value: BI (entry and open question 1)
  says `notAvailable`; PL §3.16 says it reads the instantiated template.
- K4. FabriChat handler bindings: BI says 49 sites; LS §11.1 says 24 handlers
  bound at 19 sites; a grep finds 46 sites and 25 handler definitions.
- K5. Corpus totals: LS §11.1 has 403 modules, 593 handlers, 45 lifts, 1,466
  computed, 246 actions, 188 inline; BI has 467 files, 619/72/1,499/249/193; a
  fresh run by the LS rule gives 423 modules, 620/73/1,493/249/188.
- K6. OV says a state cell document "carries no pattern metadata"; PL §3.16
  has `resultOwnerOf` read the document's back-link.
- K7. PL numbering skips §3.20.
- K8. PL §4.4 parenthetical reads as if `verifyTrustedEventRequirements` is in
  `ui-contract.ts`; it is in `cfc/prepare.ts`.
- K9. LS §5.4 lists "an input captured by a closure passed to a function whose
  body is not analyzed"; LS §5.5 gives imported functions data-typed
  parameters only, so no such function can receive a closure.
- K10. Effect request template: BI says "join of the slots that flow into the
  request"; PL §3.14 says the body's template.
- K11. BI describes staged access changes as a separate commit ahead of the
  handler's writes; on a serving runtime they are staged into the wave and
  applied first at its commit step.
- K12. Pattern closure (PL §3.15): integrity of the factory value unstated;
  the capture join is on the `value` template but "Coming back" relies on the
  `identity` slot; no rule for a closure a built-in instantiates as a tool;
  `params` root defined only for closures while OV says an inline pattern in a
  function body gets private parameters and `BodyCall` has no field for them;
  nothing refers to an entry of `Plan.closures` by index; conditional between
  closures is both "called where written" and a factory value (LS §4.4.2);
  closure through `inSpace` unspecified.

### Original four against source

- K13. `.for(tag)` in a handler: PL and BI present it as naming the same
  thing across events; today every identifier minted in a handler frame
  derives from a cause holding the event identifier.
- K14. PL §3.14 says an `inSpace` space identifier derives from the request;
  `docs/specs/random-space-identities.md` says creating a space returns a new
  identifier.
- K15. PL §1.3 "the event's key": today's event key includes the acting
  principal; the handling receipt leaves it out.
- K16. PL §3.9/§3.12 take today's handler argument schema to be the narrowed
  one; for an authored handler event it is the whole declared type.
- K17. PL §6.2 `commitSend` example: lists `messages` as a handle read and
  gives `event.replyTo` a `value` slot; source uses `messages` only for
  `spaceOf` and `push`; bodies B2/B3 are named `computed` where promotion
  makes the authored function the body.
- K18. OV "clients evaluate the same gates": not achievable for the egress
  ceiling of a handler-requested effect (sink ceilings are server
  configuration).
- K19. OV says every read through a handle is dynamic; FA §7.2 makes
  unconditional, anchored, static-path reads static.

### Requests the three new documents state in their own open questions

- ES asks PL for: computed captures on `Body`; cone inputs through incoming
  edges; order of `Plan.cones`/`Plan.outputs`; non-positional names; a scope
  on `Output`; a promotion directive on `Cone`; label rules for operation
  bookkeeping state, a cached output, provenance records, the prepared digest,
  the frozen `shape` entry at migration, and promotion as a channel.
- SS asks OV for a fourth cause (change of demand), "per cause and space",
  one drained batch = one cause; asks PL for label-dirty re-instantiation,
  a materializer write envelope on `Operation`, what a failed cone's
  write-edge targets take, which transaction a failed egress ceiling rejects,
  `inSpace` commit is a foreign-first sequence and not one commit.
- FA asks PL for: `Body.reads` to admit another cone's interim value; slot
  paths that cross a link; what `Body.handles` indexes; a per-handle read
  envelope; `WriteEdge.target` forms for a write through a handle and for an
  envelope; handler row "equal or tighter".
- FA settles PL open question 1 as one template per body.
- Both ES and SS set the cone iteration bound at ten per transaction.

## 2. Specs pull request #91 against `plan-and-label-templates.md`

On the same day the pattern closure was added to the draft pull request, in
`cfc/08-09-runtime-label-propagation.md` §8.9.5.1 (the slot root for a
closure's private parameters) and §8.9.5.2 (a bullet "A pattern closure"),
as prose only, which is the form child instances have there. The formal
documents list the closure among what the plan calculus does not model.

One sentence of that addition is not in PL and needs a ruling: PL §3.15 says
the factory value's `value` template is "the join of" the capture templates
and does not say what its integrity is, and the specification text now reads
"The join is of confidentiality: the factory value takes no integrity from
its captures." That is the most conservative reading, and a ruling can only
loosen it. The other gaps the addition met in PL are K12.

The author of the addition also listed where the pull request differs from
PL apart from the closure, and corrected none of it:

- **Stateful element bodies.** §8.9.5.1 says a compiler must refuse state
  and handlers "where the key can be a plain value without the index". PL
  §1.3 refuses only primitive element types and inline-constructed
  collections; for a record-typed input it compiles, and an inline element
  fails its cone at run time. §8.9.5.5 does not list that failure.
- **Child instances.** The bullet lacks the changed-factory rule (tear down,
  start again under the same name), which is on the Decided list; the
  run-time check that the resolved plan has the declared schemas, with the
  cone failing otherwise (PL §5.2 lists that failure and §8.9.5.5 does not);
  the "One transaction" rule (a child in the same space is evaluated in the
  cause's transaction, an `inSpace` child is not); and that a child's
  argument is always stored.
- **Calls in a function body (PL §3.14).** Absent are `inSpace` (identifiers
  known before the cross-space commit, which is on the Decided list, and the
  target space's write-side checks), `.for(tag)` with its frozen existence
  label, `asScope`, the materializer case of a cell cause computed from
  data, and the salting of captured values in a binding's identity.
- **Observation classes.** The `ObservationClass` pseudocode type in
  §8.9.5.2 omits `"labelMetadata"`, which §8.9.5.1 and PL §1.1 include.
- **Error states.** §8.9.5.5 says mismatched data fails "where the schema
  does not admit `undefined`"; PL §5.2 also excepts a declared default.
- **Context reads (PL §3.16) and PL §3.19.** The specification has only the
  sentence that access-list and search reads are `dynamic`. Missing are
  `eventKey`, `currentPrincipal`, `principalOf` and its relatives,
  `spaceOf`, `linksOf`, `equals`, `inspectConfLabel` on a computed value,
  `anchorsOf`, the parsing half of `cellFromUrl`, and `wish`.
- **`map`.** The specification says a body using the index adds the
  collection's `enumeration`; PL §3.6 also has a body using the array add a
  slot over the whole collection (see A1 in section 5).
- **Collection indexes and aggregates.** Group-mode `lookup`, `keys()`,
  `keyEntries()`, the omission of nullish keys, and the tie rules are
  absent (see A2 in section 5 for the tie rule).
- **Layout.** In §8.9.5.2 the paragraph "For every collection operation the
  runtime MUST…" sits unindented in the middle of the bullet list.
- **Description.** The pull request's description names the labs branch
  `claude/pattern-language-plan-labels-spec`, which is merged into
  `claude/fable-pattern-language-redesign-vvh48e`.

## 3. `execution-and-storage.md` against `scheduler-and-serving-loop.md`

The two documents divide one subject: ES has what happens inside the
transaction of one cause for one instance and what is stored, and SS has what
happens across instances and processes. Findings are ordered by how much
depends on them.

#### 1. An effect's completion: one transaction or two, and where the request is stored

- ES §1.1 (cause table, third row) and §6.4: the completion "is a cause of its
  own: its transaction writes the settled result with the label the boundary
  declares, and then evaluates what depends on it". ES §1.2 step 0 binds "the
  `operation` root for an effect completion". One transaction does both.
- SS §6.5: "The operation's completion transaction writes the result ... It
  commits by itself and does not seal into a wave", then the commit dirties the
  `operation` slots, and "that is a cause of the third kind. Its transaction
  evaluates the demanded cones". "They are two transactions because the first
  exists whether or not anything reads the result." SS §6.1: an effect
  operation "is never evaluated inside the transaction of another cause".
- Consequence of the ES form: a failed constraint in a cone that reads the
  result rejects the transaction that holds the result write, the result is
  lost, and ES §6.4 "If lost" requests the effect again.
- Same split on the request side for the reactive tier. ES §6.6: "Operation
  state is updated in the transaction of the cause that changes its input". SS
  §6.2: the hash and pending mark are written by the operation's own request
  transaction.
- SS Q13 (addressed to ES) is not met. SS §6.2 assumes the request is a kept
  output "written into the operation's state as the request, with the label
  `Operation.input` instantiates to". ES §6.4 lists the state as "the hash of
  the request, the claim, and the settled result or error", and ES §1.6 "What
  is instantiated" has no entry for a request. PL `WriteEdge.target` has no
  operation-request form, and PL defines `kept` as "reachable from the result
  cell", which a request is not.
- Governs: SS (effects are its subject by the plan and by ES's own header); OV
  "Built-ins and factories" also says effectful operations have "their own
  transactions".
- Correction: in ES, change the third row of §1.1, step 0 of §1.2, and §6.4
  "Writes" to say the completion transaction is the operation's and the cause's
  transaction starts from the dirty `operation` slots; exempt effects from
  §6.6's first sentence; add the stored request to §6.4 "State" and §1.6. SS
  §6.2 should stop calling the request "kept" and ask PL for a write-edge
  target for it.

### 2. When a kept output's value is staged, and the order of instantiation

- ES §1.2: side-writes are staged in step 3 (§2.2, §2.7), but kept outputs are
  staged in step 7 ("Changed values, labels and provenance are staged"), after
  instantiation and constraints. ES §2.2: a cone's slots are read "from
  storage" through the transaction. ES §1.9: the preparation runs once per
  cause "over everything the cause wrote for every instance".
- SS §3.5: "When cone evaluation stages a write, to a kept output or through a
  write edge, the scheduler matches that write against the index ... Slots of
  the same instance and of other instances become dirty", and "a cone made
  stale this way is evaluated in the same transaction". SS §10.2 "Order across
  instances" and PL §3.15 "One transaction" (a child in the same space is
  evaluated "by the pull that extends through its result") need a consumer in
  another instance to read the producer's new value inside the transaction.
- With staging at step 7 the consumer's slot is neither dirtied nor readable
  during step 3. ES §1.1 says "every step below is per instance", which cannot
  hold for step 7 (one commit) and conflicts with §1.9 (one preparation).
- Gap in all three documents: no order is given for instantiation when a slot
  is bound to an address the same transaction writes (a handler's write to a
  state cell that a step-3 cone reads; a side-write; another instance's kept
  output). The consumer's slot label has to be the label staged in this
  transaction, not the stored one, or the consumer's output takes the older,
  possibly looser label. PL §4.2 resolves slot labels "through the existing
  consumed-label index". SS §10.3 says only "when the transaction ... seals".
- Governs: ES for the steps of one instance, SS for order across instances, PL
  §4.1 for the order of instantiation.
- Correction: ES §1.2, stage a kept output's value when its cone is evaluated
  (step 3) and keep label staging in step 7; say which steps are per
  transaction. PL §4.1, state that write edges and producers are instantiated
  before the outputs whose slots are bound to what they wrote, and that slot
  labels resolve against the transaction's staged labels.

### 3. Slots supplied eagerly or on first read; which slots make a cone stale

- ES §2.2: `ConeHost.slots` is "the value of each slot in `Cone.slots`, by slot
  index, already validated". ES §3.1: `MemoEntry.slots` is "the reads of the
  slots in `Cone.slots`". ES §2.6 and §3.3: a cone instance is dirtied by any
  slot "in `Cone.slots` or in their journaled reads", and is evaluated when any
  recorded fingerprint differs. Only upstream cone outputs are lazy
  (`host.output`).
- SS §4.3 (SS Q12): "cone evaluation supplies a slot's value when the value
  code first reads it and not before ... If the runtime resolved every slot of
  `Cone.slots` before calling the value function, demand would follow every
  slot, and the producers of unselected branches would be evaluated."
- SS §2.2 (SS Q15) and §3.4: "a slot that only an unselected branch reads does
  not make a cone stale" and "causes no evaluation". SS's argument that slots
  need no trigger reads (§3.4, D9) rests on it.
- PL §5.3: "A `select` whose unselected branch is in an error state is
  unaffected, because it does not read it." Under eager, validated slots, an
  unresolvable or mismatching slot of the unselected branch fails the cone
  (PL §5.2).
- SS Q12 and Q15 are both unmet. Governs: PL §5.3 for the error case; for the
  rest ES owns cone evaluation, and SS's demand rule depends on the answer. PL
  §3.5 permits either for dirtying.
- Correction: ES §2.2, make `slots` resolve on first access and record in the
  memo only the slots read; ES §2.6 and §3.3, dirty by slots read. Or, if ES
  keeps eager slots, SS §3.4 and §4.3 have to drop the unselected-branch
  claims and PL §5.3 its sentence.

### 4. A slot whose path crosses a link (extends the known FA request to PL)

- SS §3.2: "Resolving a slot's path from its root can pass through links: an
  argument path usually holds a link to a cell of the parent. The resolution
  follows them and records each link's address as the slot's chain", and the
  chain's pointer labels are "part of the slot's label". Demand (§4.3), the
  writer map (§2.6) and the order across instances (§10.2) are all stated over
  slots bound this way.
- ES §4.4: a link to another instance's output is "a slot of class `identity`
  and a `dynamic` template for what is read through it (PL §3.10)". PL §2.2:
  "`identity` never reaches the target. A slot that follows the reference is
  two things."
- Under the ES and PL form, the read of another instance's output is a dynamic
  read. SS gives dynamic reads no demand propagation (§4.3 names slots only),
  registers them "one evaluation late" (§3.4), and attaches trigger reads to
  them. Then OV "the pull extends through the link into the producing
  instance's cone" and ES §1.3 "an argument link whose producer is another
  instance is brought up to date by the pull across instances" have no
  mechanism in SS.
- FA's open question 2(a) assumes the SS form. Governs: PL (slots and their
  labels). Needs the owner only if PL keeps §2.2 as written.
- Correction: PL §2.2 and §3.10 decide. If a slot path may cross a link, ES
  §4.4 changes to say so. If not, SS §4.3 and §10.2 need demand and pull
  through dynamic reads.

### 5. After a rejection, a dropped write, or an abort: memo "current", cone "stale", output unwritten

- ES §1.7 and §3.3: on a rejected or aborted transaction "the memo keeps the
  values of cones that performed no side-write"; such an entry "survives". ES
  §3.3 "Checking" then finds the entry current and evaluates nothing.
- SS §5.6: "a rejected transaction leaves the cones it evaluated stale". SS
  §3.5: "the slots the cause itself dirtied stay dirty". SS I3: a cone is
  evaluated again when "its cause's transaction was rejected". SS §5.5: a
  derived write dropped on a conflict leaves "its cone ... stale" while the
  rest of the transaction commits.
- PL §4.1 step 1 and ES §1.2 step 5 and §1.6 instantiate and write only "kept
  outputs whose cone instance was evaluated in this transaction". PL §5.4 says
  of memo-held results "the next cause that demands them stores them", and ES
  §3.5 says a commit may write values "taken from entries that are current".
  With the step-1 condition, a cone that is current in the memo and unwritten
  in storage is never written. ES §3.3 (a label changes "without an
  evaluation") contradicts the same condition inside ES; the known SS request
  to PL covers only the label-dirty case.
- ES §3.3 drops a side-writing entry only "if that transaction does not
  commit". Under SS §5.5 a transaction commits with one derived write dropped,
  and under SS §8.2 a failed cone's side-writes are withdrawn; ES has no rule
  for either.
- ES §1.9 item 3: one prepared digest covers everything the cause wrote, and
  "a read, a write or a new decision input after the preparation invalidates
  it". SS §5.5 removes single writes from a sealed transaction. SS Q4 flags the
  per-write rule for the owner but not its effect on the digest. ES §3.5 ("a
  write elsewhere ... fails the commit") assumes the whole-transaction
  alternative.
- Governs: SS for staleness and conflict handling; PL §4.1 for the step.
- Correction: PL §4.1 step 1 and ES §1.2 step 5, replace "evaluated in this
  transaction" with "evaluated in this transaction, or whose value or key in
  the memo differs from what is stored". ES §3.3, state what happens to an
  entry whose write was withdrawn. ES §1.9, say whether withdrawing a write
  re-prepares; this last point goes to the owner with SS Q4.

### 6. What is current after a restart (ES Q5 is met differently, and ES's form is unsound)

- ES §3.4 and §6.6: the runtime asks the scheduler for "the slots that changed
  since a given commit sequence number of the space ... the sequence number of
  the last commit that wrote the instance's result document or one of its
  operation state documents. Cone instances whose slots are not in the report
  are current."
- SS §10.4: rows per instance, cone, scope instance and input document with
  the input's sequence number; "a cone that is stale and not demanded is not
  evaluated, and its rows stay behind the heads"; a foreign input's row
  records "that space's sequence number" (§9.1).
- The ES rule gives a wrong answer where the SS rule does not: cone A is
  undemanded and its slot changes at sequence 5; cone B of the same instance
  writes the result document at sequence 9; after a restart ES asks for
  changes since 9, A's slot is not reported, and A's stored output is taken as
  current. The equality cutoff also means a cone can be evaluated without the
  result document being written, and a foreign input has no sequence number of
  the home space.
- Governs: SS (dirty slots, the basis index).
- Correction: ES §3.4 and §6.6, replace the request with "the scheduler marks
  the stale cones from the basis rows of SS §10.4"; ES Q5 is then withdrawn.

### 7. Two positions with one key: labels are per position, the memo and the bindings are per key

- PL §1.3: "Values are per key, labels are per position ... The element slots
  of a template are therefore bound per position, to the address the element
  was read from."
- ES §3.1 and §3.2: one `MemoEntry` per cone instance, keyed by element key,
  with one `ReadFingerprint` (address and label identifier) per slot index.
  "The last is what lets step 5 form an instantiation key for a kept output
  without resolving a label again." Two positions that hold equal plain values
  at different addresses, with different labels, get the first position's label
  identifiers.
- SS §3.2 says "one entry per position and slot, tagged with the element's
  key", but `InstanceRecord.bindings` (§2.2) is keyed "for element slots by
  slot index and element key", which holds one binding per key.
- Governs: PL.
- Correction: ES §3.1, keep element-slot fingerprints per position that holds
  the key, or have step 5 resolve element-slot labels per position. SS §2.2,
  key element bindings by slot index and position.

### 8. Routing an event to its binding (ES Q6 is not answered)

- ES §4.7 and Q6: "the event queue finds the instance and the binding of a
  stream identifier without a stored document per stream". ES §4.9's document
  counts for a row ("None when created") and §9.2 ("A stream ... Its document
  is no longer needed and is left") depend on it.
- SS §5.1: an event "is a durable entry of a stream document ... That is
  unchanged, and so is everything about an entry". By source,
  `docs/specs/server-side-execution/events.md` §1: an event is "an authored
  append to a stream document", admitted on "append authority on the stream
  doc". So a stream that receives an event has a document.
- SS §5.2 step 2 says "the binding the stream belongs to gives the handler",
  and §4.1 loads an instance when "one of its streams has a queued event",
  without saying how a stream identifier leads to an instance that is not
  loaded. SS §4.4 finds an instance from a document's metadata. A stream
  identifier of ES §5.2 is a hash over `within` steps and element keys and
  cannot be inverted.
- Governs: SS (the event queue). Gap: neither says what a stream document
  holds or who creates it.
- Correction: SS §5.1 or §5.2, state the lookup (a back-link in the stream
  document, written by whom and when). ES §4.7 and §4.9 then count that
  document.

### 9. Element entries: built at load without reading data, or built by evaluation

- SS §3.2: loading "reads no cell data beyond link structure", registers "one
  entry per position and slot, tagged with the element's key", and "nothing is
  evaluated". SS I2: "loading, dirtying, and releasing it read no cell data".
- ES §2.5: the element table (keys, positions, cone instances) is kept "per
  scope key" in process memory and built in steps 1 and 2 of evaluating the
  `map`, "the only read of the collection the `map` itself makes". PL §1.3:
  the key of a plain value is the hash of the value. A collection derived by
  `map` or `flatMap` has positions only after evaluation.
- So the entries SS registers at load need element values (cell data) for
  plain-value keys, and an evaluation for derived collections. Two components
  also hold the same table.
- Governs: needs the two authors to agree; ES owns the element table, SS the
  index.
- Correction: SS §3.2, register element entries from the element table after
  the collection's first evaluation, and narrow I2's "no cell data" for
  loading accordingly.

### 10. A handler's reads through handles (SS Q11 is not met)

- SS §5.3 and Q11: for a read through a handle at a computed path, or through
  a link found in data, "the runtime ... evaluates a stale cone that writes the
  address before it returns the value, inside the same transaction".
- ES §1.3: the writers of "a state cell the handler reads, or holds a handle
  to" are evaluated in step 1, before the body, from the plan alone. "The
  body's reads through handles are not known before it runs. They are
  journaled." ES has no pull at the read, so a read that reaches another
  instance's stale output through data returns the stored value.
- Materializers: ES §1.3 says a materializer whose envelope such a read falls
  in "is promoted by the scheduler, as today". SS §5.3 says "the transaction is
  withdrawn whole, the materializer runs, and the event is dispatched again".
- Governs: SS for the materializer rule (its subject). The pull at a read is
  inside one cause's transaction, so ES has to provide it or SS has to drop the
  assumption.
- Correction: ES §1.4 and §2.4, add the pull at a handle read, or state that it
  does not happen; ES §1.3, replace "promoted ... as today" with a reference to
  SS §5.3.

### 11. Is a failed cone evaluated again by the next cause?

- ES §1.7: "A cone instance that fails stays dirty ...: the next cause that
  demands it evaluates it again." ES §2.7: "A later cause evaluates the failed
  cone instances again."
- SS I3: a cone "is evaluated again only when a slot it read is dirty or its
  cause's transaction was rejected". SS §5.5: "A cone fails in the first or
  third part ... Retried: No." SS §10.4: an evaluated cone replaces its basis
  rows, so after a restart a failed cone is not stale.
- Under ES a cone on a cycle that does not converge is evaluated ten times in
  every later cause while it is demanded; ES's "dirty" is memo state and does
  not survive a restart, so the two processes behave differently.
- Governs: SS (which cones are stale); whether a budget failure should be
  retried is for the owner.
- Correction: ES §1.7 and §2.7, delete the two sentences, or limit them to
  failures that are not a function of the inputs (a time or memory budget)
  and ask SS for a rule.

### 12. Reaching the bound: which cones fail

- ES §2.7: the cone instance "that would need an eleventh evaluation fails
  ... and so does every cone instance still dirty in the same cycle".
- SS §8.1 and §8.2: "the cone fails", "cones that read it fail in turn", and
  its staged side-writes are withdrawn.
- A cone that is still dirty in the cycle but reads only the state cell the
  failed cone side-wrote fails under ES and, with the write withdrawn, does not
  under SS. SS §8.1 requires that "the server and a client ... arrive at the
  same error states", so one rule has to be the definition. The count is also
  kept twice (`InstanceRecord.evaluations` in SS §2.2, and ES §2.7).
- Governs: ES for a cycle inside one instance, SS across instances; one rule
  is needed for both.
- Correction: ES §2.7, adopt SS §8.1's rule and refer to it, or SS §8.1 adopts
  "every cone instance still dirty in the cycle"; state the withdrawal of
  side-writes in the same place (the known request to PL).

### 13. Staged requests come after the fixed point

- ES §1.2: step 4 (cells, child instances, effect requests and bindings "are
  given their identifiers and their initial documents") follows step 3. ES
  §1.5: "A child instance in the same space that something demands is evaluated
  in this transaction", in step 4.
- SS §1.4 (row §5.3): "a child created in a transaction is evaluated there
  exactly when something demanded reads it". PL §3.15: by "the pull that
  extends through its result".
- A step-3 cone that follows the link the handler just stored reads a child
  that has no argument document yet. The child's evaluation in step 4 then
  dirties that cone, and the sequence has no return to step 3.
- Governs: ES.
- Correction: ES §1.2, perform the staged requests at the end of step 2 (the
  identifiers are known at the request, §1.4), or state that steps 3 and 4
  repeat together under the bound of §2.7.

### 14. What a client can derive (ES Q10 is not answered, and SS states the opposite for bindings)

- ES §5.3: "a client cannot read" the element-key salt, so it "learns the
  identifier of per-element state over plain values, and of a binding made from
  copied captures, only from a link the server stored. What a client shows for
  such state before the server's result arrives is for SS."
- SS does not mention the salt. SS §3.2 binds a `state` slot by deriving its
  identifier from "the instance, the element keys, and the cell's name", which
  a client cannot do for a salted key. SS §11.6: "The cells and instances a
  speculative handler creates are therefore the ones the served handler
  creates." PL §1.3 identifies a binding made in a handler by its salted
  captures, so a speculated handler that binds with copied captures cannot name
  the stream the server will name.
- Governs: SS (client speculation). Whether a client may read the salt is ES's
  assumption and affects a confidentiality property, so it needs the owner if
  SS wants the client to derive these identifiers.
- Correction: SS §11.1 or §11.6, add the case: the cones that read such a state
  cell, and the result of such a binding, are pending on a client until the
  stored link arrives; limit "identifiers agree" to cells, instances and
  effects.

### 15. The handling's identity: receipt or event key (extends K15); sent events and overlay entries (SS Q16 not met)

- ES §5.4: `createRef({ request }, { handling: <receipt identifier> })`; "the
  receipt leaves the principal out ... and this document follows the receipt".
- SS §11.6: what a handler creates "is named by the event's key ...
  (`deriveEventKey`
  in `scheduler/event-identity.ts`)". By source, `deriveEventKey` hashes the
  event identifier, the actor and the stream; `handlingReceiptId` hashes the
  event identifier and the stream.
- The two documents chose different sides of K15. Both are the same on a
  client and the server, so speculation agrees under either; they differ when
  two principals send one event identifier to one stream.
- SS Q16, addressed to ES: "an event a handler sends is named by the event's
  key and its order", and an overlay entry for a result document "carries kept
  paths". ES §5.4's ordinal counts "cells, instances, effects", ES §1.4 gives a
  sent event no identifier, and ES §3.5 sends client reconciliation back to SS.
  Neither document owns the overlay entry's form.
- Governs: PL §1.3 for the identity (with K15); SS for overlay entries.
- Correction: PL §1.3 settles receipt or key and names sent events; ES §5.4 and
  SS §11.6 then cite it. SS takes Q16's overlay half as its own.

### 16. The identifier of a space an `inSpace` request creates (extends K14; ES Q11 not answered)

- SS §9.4: "The identifiers of an `inSpace` instance and of a space it creates
  are known before the commit (a ruling), so the second attempt writes the
  same documents and its foreign step changes nothing." The ruling on the
  Decided list reads "An `inSpace` instantiation's identifiers are known before
  the cross-space commit" and does not name the space.
- ES §5.6: the authoritative runtime "obtains the space's identifier when the
  request is made, and records it in the calling space's allocation record in
  the cause's transaction", "without saying which of the two holds" (ES Q11).
  ES leaves "how the space's identifier comes to exist before its first
  commit" to SS, which does not say.
- If the identifier is obtained and not derived, SS's convergence fails in the
  case it is stated for: the foreign step commits, the home step (which holds
  the allocation record) does not, the event runs again, finds no record, and
  obtains a second space.
- Governs: needs the owner (K14 is the same choice).
- Correction: SS §9.4, drop "(a ruling)" for the space and state the
  convergence claim conditionally; or write the allocation record in a step
  that commits before the foreign step.

### 17. A change of demand: fourth cause or second kind (extends the known SS request to OV)

- ES §1.1 and Q8: a first evaluation and returning demand "are presented by
  the scheduler as a cause of the second kind".
- SS §4.5: "a fourth kind of cause" with a transaction of its own that "runs
  as the principal whose session demanded, for the scope instances of that
  principal".
- ES Q8 is met differently. The difference that matters to ES is attribution:
  ES §1.8 evaluates a storage change for every demanding scope key, SS §4.5
  evaluates a demand change for one principal.
- Governs: SS, pending the owner's answer to SS Q2.
- Correction: ES §1.1, add the fourth row and bind "the dirty slots already
  recorded" in step 0; ES §9.4 step 4 names its cause accordingly.

### 18. Where the watch set and the dynamic reads are held (ES Q9 is met differently); trigger reads

- ES Q9 and §2.4: "the scheduler takes that set from the memo entry". ES §3.3:
  entries are dropped "under memory pressure in any order".
- SS §3.2: slot entries come from the plan and the bindings at load, for every
  slot. SS §2.2 and §3.4: dynamic reads and trigger reads are held in the
  instance record, "part of the instance record and not of the memo".
- ES has no trigger reads at all: §1.9 item 4 and `OutputProvenance.dynamic`
  take the `dynamic` label from the journal of the evaluation, and the
  instantiation key (PL §4.3) holds "the labels its journaled reads consumed".
  SS §3.4 requires that the label of each trigger address joins "whether or
  not the new evaluation reads that address again". No interface passes them
  from the instance record into ES step 5, and ES §1.9 item 3 does not bind
  them in the digest.
- Granularity: SS §2.2 and PL §4.2 (`dynamicLabel(reads)`) keep reads per
  `dynamic` node; `MemoEntry.dynamic` is one list per cone instance.
- Governs: SS for the holder; PL §3.10 for the trigger-read rule.
- Correction: ES §3.1, key `dynamic` by `DynamicReads` index; ES §1.2 step 5
  and §1.9 item 3, take the trigger reads from the scheduler and bind them. ES
  Q9 is withdrawn.

### 19. "A cone has no gate" against the remote-echo gate and the instance's backoff fields

- SS §1.3 (P8) and §5.3: "A cone has no gate"; the reasons an event waits are a
  load, a materializer, and an unconfirmed origin.
- SS §1.4 (row §8) and §8.4: the remote-echo gate "is kept and keyed by
  instance and cone". SS §2.2: `InstanceRecord.gate` holds `backoffUntil`,
  `backoffStreak` and `echoBackoffUntil`, "the convergence and remote-echo
  gates", while §8.1 fails a cone at the bound and §8.3 applies backoff to
  materializers and effect operations only.
- ES §1.5 evaluates every cone instance that is dirty and needed, and has no
  gate check. If a gated cone is in a handler's read closure, SS §5.3 gives the
  event nothing to wait for.
- Governs: SS.
- Correction: SS, either remove the echo gate and the two backoff fields for
  instances, or say what a held cone does to step 1 and step 3 and ask ES for
  the check.

### 20. Migration and the serving loop (gap)

- ES §9.4: an instance is migrated "when a runtime ... starts it", by an
  evaluation "as a cause of the second kind with every slot dirty" written in
  "a setup transaction in the sense of the serving loop (§3e)"; "a space can
  hold migrated and unmigrated instances"; an instance the compiler refuses
  "keeps running on the builder path". ES §9.3: "Binding reads the [carry-over]
  record on every start." ES §9.6: the serving runtime deletes retired
  documents "in a transaction of its own".
- SS does not mention migration, setup transactions, or builder-path
  instances. It removes "start modes" (P9: "There is no `fresh` or `resume`")
  and loads an instance "without a step that starts a piece" (§4.4). Its
  dispositions "Removed" (the node record, ordering, preflight, provisional
  demand) cannot hold in a space where builder-path instances still run. SS
  §3.2 binds a `state` slot by derivation and does not read the carry-over
  record or the stored scheme of ES §5.2.
- Neither document says how a node run's transaction and a cause's transaction
  coexist in one space, where a setup or deletion transaction sits in SS
  §10.2's cycle, or what a compiled cone's slot bound to a builder node's
  output is in the writer map.
- Governs: needs the owner for scope (whether one serving runtime runs both
  schedulers in one space); then SS.
- Correction: SS §10, add a subsection on a space with both kinds of instance
  and on setup transactions; SS §3.2, bind `state` through the carry-over
  record. ES §9, use "loaded" for the trigger.

### 21. What a materializer returns, and where (gap)

- SS §2.1 and §7: a materializer is an `Operation` of kind `materializer`
  with its own transaction, "not part of the compiled evaluation of its
  instance".
- ES §4.1 and §6 list operation state documents for "one aggregate, `reduce`,
  index, effect or forced cache", and ES §2.4 runs bodies only through
  `host.invoke` inside a cone.
- A `lift` that writes dynamically also returns a value that an output may
  depend on. Neither document says where that value is stored, under what
  identifier and label, or how a cone reads it (PL's `operation` slot root is
  "the stored result of a durable operation"). I did not check BI for this.
- Correction: ES §6, add the materializer's state document; SS §7.2, say that
  its result is read through an `operation` slot.

### 22. Overview against ES and SS

- OV "State cells": "Existing stored state of an instance then keeps its
  identifiers, and migrating an instance consists of no longer writing its
  per-node documents." ES §5.7: a state cell inside a compiled-in sub-pattern
  does not keep its identifier and is found through a carry-over record; ES
  §9.2: migration is a setup transaction that rewrites the result document.
  ES governs; correct OV.
- OV "Pull and dependency cones": "Each output path has a dependency cone: the
  part of the pattern that path's value depends on." ES §2.1: "Every value the
  instance computes is computed by exactly one cone", cones are a partition
  joined by `ConeEdge`, and a cone computes several outputs. One term, two
  things. ES and PL govern; correct OV.
- OV "The scheduler": "tracking which instances are demanded". SS §4.2: demand
  is "held on kept outputs, per path". SS governs; correct OV.
- OV "Provenance": a kept output "carries ... the identities of the inputs
  bound to the template's slots". ES §7.2: the identities "are not copied into
  the record where the plan and the document determine them". ES governs;
  correct OV's wording.

### 23. Against the Decided list

- "Clients ... never request effects." SS §6.7: "Navigation is the one effect
  a client enacts from a speculative run". `navigateTo` is on SS §6.1's list of
  effectful built-ins. The author did not flag it. SS §2.5 also lists the
  effect operation and the materializer as demand sources on "Both" runtimes,
  while SS §6.7 and §11.1 say a client has no effect operations and say nothing
  of materializers on a client. Needs the owner for navigation; SS corrects the
  §2.5 table.
- "(a ruling)" for the space identifier in SS §9.4: see finding 16.
- No other statement in ES or SS contradicts a ruling without the author
  having flagged it (SS Q1, Q3, Q4, Q19 are flagged).

### 24. A change of label alone opens no transaction in the cycle (SS, with ES)

- SS §3.6: for a label-dirty slot "no cone is stale", and "the transaction of
  the cause instantiates the template again". SS §10.2's cycle runs a
  transaction only "if a demanded output is stale". ES §1.5's step 3 input is
  "a set of dirty slots", with no label-dirty set, though ES §3.3 handles the
  case once an entry is marked.
- Correction: SS §10.2, "stale or reached by a label-dirty slot"; ES §1.5 and
  step 0, accept label-dirty slots.

### 25. Terms

- A cone that needs evaluation is "dirty" in ES (cone instances and slots
  both) and "stale" in SS, where only slots are "dirty". ES "current" is a
  state of a memo entry; SS has no word for it and uses "not stale". Finding 5
  is partly a consequence.
- "Pass": ES §2.3, "one repetition of step 3"; SS §1.4, "the pass becomes the
  processing of one cause".
- "Evaluation": ES Terms, one run of §1.2 for an instance and a cause; SS (and
  ES §2.7 itself), one run of a cone's function.
- ES "cone instance" has no name in SS, which writes "one cone ... for one
  element key and one scope instance".
- ES "started", "stopped", "setup" against SS "loaded", "released" (finding
  20).
- "Unit": SS, what the scheduler holds a record for; ES §2.1, "the unit of
  value code is the cone".
- Correction: ES adopts "stale" for cones and "loaded"; SS adopts "cone
  instance"; one of the two renames its "pass".

### 26. The worked send (extends K17)

- ES §10.1 traces "an event on the send stream" handled by `commitSend`, sent
  from the sender's rendered session, and has `k0` pass on the UI contract.
- SS §11.4: the composer's click "is bound to `commitComposerSend`. The
  exported `sendMessage` stream is bound to `commitSend` and to no rendered
  control", and an event on that stream without the surface's provenance fails
  `k0`.
- By source, `patterns/system/fabrichat/room.tsx`: `sendMessage` is
  `commitSend({...})`, `composeSend` is `commitComposerSend({...})`, and the
  composer's `onClick` is `composeSend`. SS is right.
- Correction: ES §10.1, trace `commitComposerSend` (its read closure adds
  `composer` and the file store), or state that the event reaches `commitSend`
  from another pattern's reviewed surface.

### Count

26 findings. 14 are conflicts between ES and SS (1, 2, 3, 5, 6, 9, 10, 11,
12, 13, 14, 18, 19, 24); 5 extend known items (4, 15, 16, 17, 26); 3 are gaps
neither document covers (8 in part, 20, 21); 1 is a label conflict with PL
that both documents share (7); the rest are the overview (22), the Decided
list (23) and terms (25).

Assumptions addressed between the two documents, by outcome:

- ES to SS, not met or met differently: Q5 (finding 6), Q6 (8), Q8 (17), Q9
  (18), Q10 (14), Q11 (16).
- SS to ES, not met or met differently: Q11 (10), Q12 (3), Q13 (1), Q15 (3),
  Q16 (15).

### Assumptions checked and found met

From ES about SS:

- Q7 and §1.8: several scope keys in one transaction, each evaluation
  attributed to its acting principal. Met by SS §10.3 (third bullet), §5.6 and
  Q1.
- Q12: a sent event and a handler's effect request leave through the commit
  and are causes of their own. Met by SS §1.4 (row §7.6), §5.1, §6.2 and §9.3.
- §1.1: the order in which instances are evaluated is SS's. Given in SS §10.2.
- §1.9: how the wave and the cause's transaction relate is SS's. Given in SS
  §10.2 and §10.3, and SS keeps what serving-loop §3c protects in the form ES
  expects (labels per written path).
- §2.4: journaled addresses are watched beside the bound slots. Met by SS §3.1
  and §3.4 (the holder differs, finding 18).
- §3.5: how a client reconciles is SS's. Given in SS §11.6.
- §4.6: the commit that spans two spaces is SS's. Given in SS §9.4.
- §5.6, second half: what a client's speculative run of an `inSpace` handler
  sees. Given in SS §9.4 (it does not speculate without an allocation record).
- §1.5: a dirty cone nothing demands keeps its stored value and label. Same in
  SS §4.6.

From SS about ES:

- Q14 and §2.1: scope instances per cone, narrowed at first evaluation. Met by
  ES §1.8.
- §2.2: the last selections and the memo are held by cone evaluation. Met by
  ES §3.1 (and `OutputProvenance.selections`, §7.2).
- §3.6: a label-only change is instantiated again from the memo's value
  without evaluation. Met by ES §3.3.
- §4.7: when to release a record is decided with the memo's retention. ES §3.3
  "Removal" covers it.
- §5.2: what is evaluated in each of the three parts is ES's. Given in ES §1.3
  to §1.5.
- §5.3 and §6.6: what a handler creates is named by the event and the order of
  creation, so a second attempt names the same things. Met by ES §5.4 (which
  identity, finding 15).
- §5.5: the handler's stale reads include what the first part read. Met by ES
  §3.5.
- §6.1 and §6.6: an operation's state document is named by its cause. Met by
  ES §6.
- §8.1: ten evaluations per cone, element key and scope instance in one
  transaction. Same number and unit in ES §2.7 (the failure rule differs,
  finding 12).
- §10.4: rows keyed by result cell, compiled pattern and cone index. Same key
  parts as ES §3.2.
- §10.5: the result cell names the compiled pattern. Met by ES §7.1.
- §10.6: the memo starts empty at recovery. Same in ES §3.4.
- §11.2: the instantiation key is stored with the committed label. Met by ES
  §7.2 (`key`).

Checked without finding a conflict: a handler body that throws (ES §1.7, SS
§5.5, PL §5.4); a failed constraint rejecting everything the cause wrote (ES
§1.7, SS §5.5 and §5.6); own-write suppression (ES §1.4 and §2.7, SS §3.5);
state-cell side-write ordering (ES §2.3, SS §10.2); `inSpace` children
evaluated by their own space (ES §4.6, SS §9.3); effect loss repeating the
request (ES §6.4, SS §6.6); one result document per instance and demand per
path (ES §4.2, SS §4.2); the client compiling nothing and measuring nothing
(ES §8.2, SS §10.5).

### What I did not read in full

- ES and SS: read in full.
- The continuation planument: read in full.
- OV: read from "What the compiler emits" to the end. Not read: the first 150
  lines (the problem, the language, the example).
- PL: read §1, §2, §3.5, §3.10 to §3.12, §3.14, §3.15, §4, §5 and §8. Not
  read: the rest of §3, §6 and §7.
- FA: only open question 2 and a search for link crossing.
- LS and BI: not read.
- Source: `runtime/runner/src/scheduler/event-identity.ts` (`deriveEventKey`,
  `handlingReceiptId`, their comments); `patterns/system/fabrichat/room.tsx`
  (the bindings of `commitSend` and `commitComposerSend`);
  `docs/specs/server-side-execution/events.md` §1; a search of
  `serving-loop.md` for the stale-read rule. Nothing else in source was
  checked, so SS's and ES's other citations of source are unverified by me.

## 4. `footprint-analysis.md` against the other documents

Findings are ordered by how much depends on them.

#### F1. A container passed by reference into an effect request is outside the egress check

- FA §3.8: an effect request is one of the destinations that "keep a
  container or a handle by reference"; "The content is not read." FA §8.3:
  "Each member of the request is recorded by the reference rule."
- PL §3.14: "The request's arguments carry `T_b` and form the `input` of an
  `Operation` of kind `effect`, on which the egress ceiling is checked." PL
  §4.4: the ceiling is "`C` of the effect operation's `input` template". SS
  §6.2: for a handler, "Its arguments carry the handler's template, the
  egress ceiling is a constraint of that transaction."
- Together: a handler that passes `state.record` whole inside a request
  (legal for every effectful built-in, LS §5.2) records `identity` at it, so
  `T_b` holds the pointer label and not the record's content label. The
  effect serializes the content, and no document has the operation
  dereference the link and check the ceiling again. PL applies the reference
  rules to instantiation arguments and bindings, and does not mention them
  for effect requests.
- This is separate from K10 (which template the request has).
- Governs: PL owns the label rule and the constraint; BI owns which operands
  of a built-in are references.
- Smallest correction: FA §3.8 and §8.3: an effect request reads the content
  of its members (`value`, a conversion), except an operand the inventory
  declares a reference, such as the target of `navigateTo`. The alternative
  is a rule in PL §3.14 and SS §6.2 that the request transaction follows the
  links and checks the ceiling on the target labels.

### F2. Which handles a body is handed (extends K19 and FA request 2)

- FA §1.1: `handles` is "The handles the body reads through in ways no static
  entry covers"; FA §13 request 2(e): "`Body.handles` lists a handle only
  when some read through it is dynamic."
- PL §7.3: the runtime "hands it only the listed handles". ES §1.4: "hands
  the body the listed handles". ES §2.4 step 2: "hands the body the handles
  in `Body.handles`".
- Together: a body that only writes through a handle (`chosen.addUnique(name)`),
  or reads through it only statically (`composer` in FA §12), has the handle
  in no list and is handed nothing to call `set` or `get` on. FA's requests
  ask what `Body.handles` indexes and do not say this.
- K19 names OV only. The same statement, that every read through a handle is
  journaled, is also in PL §1.1 (`Body.handles` comment), PL §3.9, PL §3.22
  ("a read a body makes through a cell stays journaled"), PL §5.4 ("A
  handler's read closure is static"), ES §1.3 ("The body's reads through
  handles are not known before it runs"), ES §1.4, and SS §5.3 ("Those
  addresses are not slots"). ES §10.1 step 1 repeats the handle list of PL
  §6.2 (`myProfile`, `messages`, `threadInfo`), which K17 and FA §12.5 show
  is wrong.
- Governs: PL owns the record; FA owns when a read is static.
- Smallest correction: PL §1.1 and §7.3: a body is handed a handle for every
  handle-typed position its record names (an `identity` entry of `reads`, a
  write target, or an entry of `handles`), and `handles` lists the ones with
  a dynamic read. ES §1.3, §1.4, §2.4 and SS §5.3 then refer to that.

### F3. A captured value another cone computed: narrowed by the runtime, or passed whole

- FA §4.2: the runtime builds the argument "entry by entry"; FA §13 request
  1: an entry on a computed input maps to "the sub-template of the producing
  expression at that path". FA §9.2 rows 1 and 2: body narrowing does not
  rest on the analysis because it "is enforced by the runtime".
- ES §2.2: `invoke(body, computed)`, where "`computed` holds the values the
  body captures that this evaluation computed, by capture position"; ES §2.4
  step 1: "the computed part from what the cone passed". The computed part
  is not narrowed, and the emitted cone code supplies it.
- Both documents list a request to PL about computed captures (known). The
  two assumptions differ. Under ES, a missing entry on a computed capture
  does not starve the body: the body reads the path, and its label holds
  only the sub-templates the footprint named. FA §9.2's "No" then holds for
  slots only.
- Governs: PL (the record and §7.3, §7.4).
- Smallest correction: PL decides one. Either the body record lists entries
  (path and class) per computed capture and the runtime narrows the value
  the cone passes; or ES's form stands, the label of a computed capture is
  its whole template, and FA §9.2 says so.

### F4. The read envelope has no counterpart in ES or SS

- FA §7.3: "The handle's `get()` returns the value narrowed to the envelope,
  so the journal holds those reads and no others." FA §13 request 8 asks ES
  to confirm it. FA §13 request 9 assumes "a handle of `Body.handles` stands
  for its read envelope when the order of evaluation is decided".
- ES §1.4 and §2.4: a read through a handle "is a read through the
  transaction and is journaled". Nothing narrows it. SS §5.3 evaluates a
  stale writer "at the read instead of ahead of the body", and SS §5.2 step
  3 tests "the cell behind one of its handles" against materializer
  envelopes. Neither uses an envelope of paths.
- What depends on it: the "Under this analysis" column of FA §12.4 for
  `state.message` and `event.message`, and the sentence "This is where the
  analysis is tighter than today" in FA §7.3. Without the narrowing,
  `target.get()` reads the whole message as today.
- Governs: ES for what `get()` returns; SS for order.
- Smallest correction: ES §2.4 step 2 states that a handle's `get()` and
  `sample()` read under the handle's envelope schema. SS §5.3 needs no
  change if FA request 9 drops its second clause.

### F5. A static side-write target is any anchored handle in FA and a state cell elsewhere (extends FA request 3)

- FA §6.2: a target is static when "The handle is an anchored handle ... and
  the path below it has only static segments", named "by the position of the
  handle among the body's inputs". That includes a cell reached through the
  instance's argument.
- PL §1.1: `ConeEdge.via` is `output` or `state`. ES §1.3: "A state cell the
  handler reads, or holds a handle to, can be the target of a static
  side-write. The plan records that as a `ConeEdge` through the state cell."
  ES §2.3: only "A slot with root `state`" is ordered behind its writer. SS
  §2.6 lists the writer map's targets as "a state cell, a child's argument
  document, a created cell, an anchors document". SS §8.2 computes the
  compile-time cycle report from `Plan.edges`.
- Together: for a static write through an argument handle, the plan has no
  edge, ES does not evaluate the writer before a reader or before a handler
  body, and the cycle report of SS §8.2 does not see it. FA §6.6 and request
  9 assume that report is computed from the read and write sets of all
  bodies. Two anchored positions can also link to one cell, which a target
  named by position does not show.
- The list of section 1 has the `WriteEdge.target` form. It does not have
  `ConeEdge.via`, ES's order, or the cycle report.
- Governs: PL (records); ES (order).
- Smallest correction: PL adds the handle form to `ConeEdge.via` together
  with `WriteEdge.target`, and ES §1.3 and §2.3 say "a cell a cone writes
  statically" in place of "a slot with root `state`".

### F6. Nine of the ten corpus materializers have an envelope SS cannot index

- FA §6.2: "For a created cell it is the creation site." FA §11.5: nine
  `lift` bodies create a cell under a cause computed from data, "all are
  materializers with a creation site as their envelope".
- SS §2.4: the envelope is "paths relative to the cells the body writes
  through". SS §7.2: promotion "is a lookup of the cone's bound addresses in
  the envelope index".
- A creation site names no address, so no reader's address can be found
  inside it and promotion never happens for these. FA request 9 assumes "the
  envelope of a materializer is the one of §6.2".
- The list of section 1 has the missing field on `Operation`. It does not have
  the
  mismatch of forms.
- Governs: SS for what an envelope index holds; FA for what the analysis can
  name.
- Smallest correction: SS §2.4 and §7.2 state what a site envelope means for
  promotion (no promotion, the one-evaluation-late rule of §7.3), or FA §6.2
  gives the created-cell case another envelope.

### F7. The return value of a materializer body has no home

- FA §6.3: "A body with one write that is not static is a materializer for
  all of its writes", and FA §6.1 counts `return` as a write.
- SS §7.1: "A materializer is not part of the compiled evaluation of its
  instance." It has its own transaction. ES §4.1 and §6 list operation state
  for an aggregate, `reduce`, an index, an effect, and a forced cache, and
  none for a materializer.
- No document says where the value such a `lift` returns is stored or how a
  cone reads it. The nine corpus lifts of F6 return a value.
- Governs: needs PL (is it the `operation` slot root?) and ES (the state
  document).
- Smallest correction: one sentence in PL §3.11 and a row in ES §4.1.

### F8. A label-metadata observation is always a slot in PL and sometimes journaled in FA

- PL §3.16: `principalOf`, `principalsOf`, `profileOwnerOf` are recorded as
  "The `identity` slot of the target and a `labelMetadata` slot on it". BI
  ("Context reads"): "a `labelMetadata` slot".
- FA §8.4: "When the operand is one anchored handle and the call is
  unconditional, the `labelMetadata` entry is static. Otherwise the
  observation is journaled ... and the operand is listed in `Body.handles`."
  FA §12.3 lists "label metadata (authored-by)" under the handles.
- `DynamicReads.why` (PL §1.1) has `link`, `handle`, `space`, `search`, and
  no form for a journaled label observation.
- By FA §1.4 requirement 2, PL's static slot is wider than today on a run
  that skips a conditional `principalOf`, since the runtime records the
  observation when it happens (`recordCfcLabelMetadataObservation`, cited in
  PL §2.4).
- Governs: PL owns the rule; the Decided ruling "equal to or tighter"
  supports FA.
- Smallest correction: PL §3.16 says the observation is a slot when FA §7.2
  makes it static and journaled otherwise, and says which `DynamicReads`
  kind carries it.

### F9. "Unconditional" ignores runs that throw, and those runs carry labels

- FA §3.7: "A `throw` does not make what follows it conditional, since an
  execution that throws does not return normally." FA §7.2: the three
  conditions "are the cases in which a static entry reads exactly what the
  body's transaction reads today". FA §1.4 requirement 2: "For every body".
- PL §5.2: "A failed body contributes its whole footprint, the `reads`
  slots and whatever its handles had read." PL §5.4: a handler's failure "is
  an outcome with a label".
- In FA §12, `composer.get()` is static because the statements before it
  "can throw and cannot return". On a run that throws at step 1, today's
  transaction never reads `composer`, and the labeled outcome holds
  `composer->editing`.
- Governs: needs the owner if it counts as a second exception to the ruling;
  otherwise FA.
- Smallest correction: FA §1.4 and §7.2 state requirement 2 over runs that
  return normally, and say that an error state or a failed handler's outcome
  carries the static entries.

### F10. A test "the type decides" records nothing, and the narrowed argument is outside the type (internal to FA)

- FA §2.2: "`typeof name` where `name` has type `string` ... record nothing.
  A body never receives a value outside its input's type (§1.3)".
- FA §9.1, corollary: "The argument the runtime builds from `F` agrees on
  `F` with the full input. By S1 the body behaves on it as it would on the
  full input."
- The narrowed argument lacks every path with no entry, so it is outside
  the declared type at exactly those paths. A body whose only use of
  `x.name` is `typeof x.name === "string"` receives no `name`, the test is
  false at run time, and the body takes the other branch. The full input
  and the narrowed one agree on `F` and behave differently.
- Smallest correction: FA §2.2 records `shape` for such a test unless
  another entry already materializes the path; or FA request 8 asks ES to
  build a stand-in of the declared kind at such paths, and S1 is stated over
  arguments that conform to the type where the footprint is silent.

### F11. Three observations S1 needs are not recorded (internal to FA)

- The key or index expression. FA §3.1 records only "`enumeration` at `v`"
  for `v[i]`, `v.at(i)` and `v[k]`, and says "The index itself is whatever
  its own expression is." FA §7.1 records "Nothing" for `h.key(k)` and
  `h.elementById(id)`. FA §7.1 does record "`value` at `k`" for
  `index.lookup(k)`, and §3.4 records `value` at a `Map` key. PL §3.18 (as
  LS §4.4 cites it) says a chosen child "observes the key". With
  `rows[event.i].price`, two arguments that differ only in `event.i` agree
  on `F` and return different values.
- The handle written through. FA §6.1 records the handle's abstract value
  and no observation. S1 requires "the same writes ... to the same targets",
  and FA request 3 has a write target name "a handle's `identity` slot". A
  body that only writes through `h` has no such entry.
- The inner arrays of `flat`. FA §3.4 gives `flat` "`enumeration`" at `v`
  and "A bag of `v/*`". The result's members are `v/*/*`, and its length
  depends on the enumeration of each `v/*`.
- Smallest correction: FA §3.1 and §7.1 add `value` at a key or index that
  is a scalar projection; §6.1 adds `identity` at the handle; §3.4 gives
  `flat` a row of its own.

### F12. What a widening is, and what `Widening` can record

- PL §1.1, `Widening.slot`: "The slot that now stands for a whole subtree."
  PL §2.2: "a widening ... replaces several narrow slots by one `value` slot
  at their common ancestor". PL §3.22: "A widening affects only slots the
  runtime materializes into the argument". OV ("Pull and dependency cones"):
  "Where footprint analysis gives up it widens a static slot, and no dynamic
  tracking is involved." LS §10.3: the hint names "the subtree the footprint
  widened to".
- FA §5.1: a widening on a key "continues with `*` in place of the key", so
  W1 yields several entries (`prices/*/amount` and the `enumeration` of
  `prices`) and no `value` slot at an ancestor. W7 widens "The projections
  involved". FA §5.1 and §7.4: a handle the analysis loses "becomes a handle
  the body reads through dynamically", with "the handle's whole declared
  type as the envelope", and makes the write surface too broad.
- FA request 5 raises the difference with LS §5.4. It does not raise the PL
  record or the OV sentence.
- Governs: PL for the record; FA for the causes; OV is corrected.
- Smallest correction: `Widening` takes a list of slots (or one entry per
  slot) and admits a handle; PL §2.2 and §3.22 and the OV sentence are
  reworded to "covers the entries it replaced".

### F13. What a handler binding copies, and whether the copy is within requirement 2

- FA §8.5: a captured container is recorded as "`value` at the paths the
  bound handler's own footprint reads of it. They are copied".
- LS §5.2: "A data value is copied into the binding", and the binding's
  identity derives from "each copied data value". BI ("A handler binding
  made in a body"): "the copied captures are stored with the binding". PL
  §3.14: "Captured data values | Copied into the binding's state document".
  ES §5.5: capture keys hold "per state path, the salted hash of a copied
  value".
- Two bindings whose captured records differ only at paths the handler does
  not read are one stream under FA and two under the plain reading of the
  others. FA also does not say what is copied where the bound handler's
  footprint has `shape`, `enumeration` or `identity` at a captured path. An
  `identity` entry would make the binding hold a link, which LS §5.2
  excludes for a data value.
- FA §13 question 2 says of a returned record: "The alternative, a copy,
  reads the record in full and is wider than today." FA §3.8 then makes a
  binding "the one destination that copies", and FA §10.2 has no row
  comparing a binding body with today. I did not check in source what
  today's binding body reads.
- FA §8.5 has no entry for the callee when it is a handler factory value. PL
  §3.21 records "the slot that holds the factory, observed for `identity`",
  and FA §8.1 has the matching row for a pattern factory.
- SS open question 24 asks FA whether the analysis can bound the cells a
  handler factory value may write. FA does not answer.
- Governs: LS owns the capture rule; ES owns the identifier.
- Smallest correction: LS §5.2 says whether the copy is the whole value or
  the paths the handler reads; FA §8.5 adds the classes other than `value`,
  the factory row, and a line on requirement 2; FA §13 answers SS question
  24 (the declared state type's writable cells, or "no").

### F14. `sample()` is in no scheduling or memo rule

- LS §4.7: `sample()` reads "without making the body depend on the cell for
  recomputation". FA §7.5: "`sample()` has the footprint of `get()`"; FA
  request 2(d) asks PL for "a flag on the slot".
- SS §3.1 to §3.4 mark a cone stale on any slot or dynamic entry. ES §2.4:
  the journaled addresses "are what the scheduler watches". ES §3.1
  `MemoEntry` and §3.3 treat every read alike. Neither document mentions
  `sample`.
- Governs: SS (dirty slots), ES (memo).
- Smallest correction: SS §3.1 and ES §3.3 exclude a sampled read from
  marking, once PL has the flag.

### F15. `linksOf` and `spaceOf`: dynamic in BI, slots in PL and FA

- BI ("Context reads", after the table): `linksOf`, `resultOwnerOf`, the
  access-list reads and "the pointer reads of `spaceOf`" are "a `dynamic`
  read, journaled like a read through a handle". BI's table says `spaceOf`
  reads "after following links".
- PL §3.16: `spaceOf(x)` is "The `identity` slot of `x`"; `linksOf(list)` is
  "The `enumeration` slot of the list and the `identity` slot of each
  element". FA §8.4 follows PL.
- Governs: PL.
- Smallest correction: BI's paragraph lists only `resultOwnerOf` and the
  access-list reads as dynamic, or PL §3.16 says what a chain of links below
  `x` contributes for `spaceOf`.

### F16. "The one destination that copies" against pattern closures (extends K12)

- FA §3.8: "The state a handler is bound to is the one destination that
  copies."
- PL §1.1, `Closure.params[].capture`: "A data value is copied into the
  factory value; a cell stays a link." LS §5.1 allows "an inline
  `pattern(...)` used directly as the callee of an instantiation" in a
  function body.
- FA §8.1 has no row for what a body records for the captures of such an
  inline pattern.
- Governs: PL §3.15, once K12 is settled.
- Smallest correction: FA §3.8 and §8.1 name the closure's captures as a
  second copying destination, or state that they are passed by reference.

### F17. The normal form drops `labelMetadata` and disagrees with §5.4 (internal to FA)

- FA §2.3: a `value` entry at `p` "removes every entry at or below `p` ...
  other than `identity` entries".
- FA §5.4: "a `value` entry at `p` covers every class at every path at or
  below `p`."
- PL §2.2 and §2.4: a `value` slot consumes `value`, `shape` and `enumerate`
  entries. `labelMetadata` "does not read the value at its path" and has a
  label of its own. So §2.3 removes a `labelMetadata` entry that a `value`
  entry does not cover, and §5.4 contradicts §2.3's exception for
  `identity`.
- Smallest correction: both sentences say "other than `identity` and
  `labelMetadata` entries".

### F18. `unknown` has no row

- FA "Notation" and §1.3: every position is "a scalar, a container, or a
  handle".
- LS §7.1 and §7.8: `unknown` in a data type "declares a reference to
  another piece that is not read". `Record<string, unknown>` and `JSONValue`
  are the stated replacements for `any`.
- FA §2.2 gives no class for truthiness, a `typeof` test, a conversion, or
  passing on at a position typed `unknown`.
- Smallest correction: a fourth column or a sentence in FA §2.2 (`identity`
  when passed on, `shape` for a kind test, a widening for a conversion).

### F19. Members of the surface with no rule

FA §3.4: "Every member `language-subset.md` §9 lists has a rule." These have
none and are not reached by the default for scalars:

- `Array.from(v, mapFn)` (LS §9.2): the mapping callback's parameters.
- `new Map(v)` and `new Set(v)` from a projection (LS §9.9): the
  `enumeration` at `v` and the members.
- `Map.prototype.forEach`, `size`, `clear`, `keys` (LS §9.9).
- `JSON.stringify` with a replacer function (LS §9.7): the callback.
- `Array.of`, `new Array(n)`, `Object.create(null)` (LS §9.2, §9.3). These
  are constructions and need a line at most.
- Runtime forms without a row: `asScope(scope)` on a pattern factory (LS
  §4.7; PL §3.14 has it), the `options` of `inSpace` (BI lists `grants`,
  `root`, `spaceKind`, `selfOwned`), a cell created in a handler with an
  explicit cause, and a `lift` result called inside another body (BI:
  "an ordinary call").

Smallest correction: rows in FA §3.4 and §8.1, or a stated default ("a
callback of a listed method is bound as for `map`; a constructor taking an
iterable is `Array.from`").

### F20. The worked example and the corpus tables against FA's own rules

- FA §12.3 lists `event body : shape, value` and
  `event target/value : shape, value`. FA §2.3's normal form removes the
  `shape` entry under a `value` entry at the same path.
- FA §12.3: "the eleven static entries". FA §1.1 defines an entry as "a
  triple of a formal input, a path, and a class". The listing has eleven
  paths and seventeen triples, fifteen after the normal form.
- FA §12.3 has "calls: context reads only: currentPrincipal, principalOf,
  spaceOf, equals". FA §8: the four creating kinds have "their sites in
  `Body.calls`", and `BodyCall` has no context-read kind. The entry should
  be "none".
- FA §12.2 step 6 calls the value written to `body` "`Computed`". By §2.1
  and §3.6 it is the alternatives `{event.body, event.target/value}` and a
  constant. The label is unaffected.
- FA §11.3 measures W6 as "a recursive authored function". FA §5.2 defines
  W6 as "A path that enters a recursive type a second time", which a loop
  can do. The row does not measure the cause. W7 has no row.
- FabriChat promotion (extends K5): FA §11.2 and §11.6 have 109 of 112
  promoted and 3 bodies. LS §11.5 has 106 of 111, and ES §10.1 cites that.
  By source, the eight modules hold 112 `computed(` calls and 25 handler
  definitions.
- FA §12.1 and §12.2 match the source of `commitEdit`, `resolvedProfile`,
  `messageInRoom`, `isDeleted`, `isActorAuthor`, `textOf` and `hasTextIn` in
  `patterns/system/fabrichat/room-records.tsx`.

### F21. Smaller gaps and stale statements

- FA header: ES and SS "are not yet written, and nothing here depends on
  them." Both exist, FA §9.2 says its fourth row "depends on how the runtime
  builds an argument", and requests 8 and 9 are addressed to them. LS §5.4
  says FA "is not yet written".
- FA §8.1: reading through the link an instantiation returned "in the same
  body is a dynamic read". PL §3.14: the child is created "when the
  transaction commits"; ES §1.5 creates it in step 4. There is nothing to
  read in the same invocation, and `Body.handles` (an index of input slots,
  by FA request 2(b)) has no form for a created value.
- FA §6.1 does not count the binding state document as a write. ES §1.5 and
  §4.7: "A binding made in the body writes its state document", under an
  identifier derived from captured values (ES §5.5). FA §6.2 makes a cell
  created "under a cause computed from data" a dynamic target. No document
  says why a `computed` that binds a handler to data-dependent captures (27
  corpus sites by BI's count) is not a materializer by the same reasoning.
  One sentence in FA §6.3 would settle it.
- BI ("An instantiation request from a handler") records for each argument
  path "whether the value is copied or is a cell handle". FA §3.8 keeps a
  container argument by reference. This is the subject of FA §13 question 2
  to the owner; BI's wording is one more place it shows.

### Count

21 findings. F1 to F9 are between documents (three of them extend a known
entry: F2 extends K19, F5 and F6 extend recorded requests). F10, F11, F17
and F20 are internal to FA. F12 to F16, F18, F19 and F21 are smaller
conflicts or gaps between FA and one other document.

### Checked and found consistent

- Which bodies the analysis runs on: FA §1.2 against LS §4.4, §4.6, §5.2,
  §6 and PL `Body.kind` (`lift`, `computed`, `action`, `handler`, `assert`,
  `function`, `imported`).
- Imported TypeScript: FA §1.2 against LS §5.5 and PL §3.9 (one `value`
  entry per parameter, no handles, no writes, no calls).
- The five classes: FA "Notation" and §2.2 against PL §2.1, §2.2 and §2.4,
  including truthiness (`value` for a scalar, `shape` for a container) and
  navigation observing nothing.
- One template per body: FA §4.1 against PL §3.9, §3.14 (`T_b`) and PL open
  question 1.
- `Body.outputs`: `passes`, `oneOf` and `required` in FA §3.8 against PL
  §1.1 and §3.9, and the runtime's identity check against ES §2.4 step 4.
- A passed reference stored as a link: FA §3.8 against ES §4.2 ("a part of
  the argument ... A link to that address"). ES confirms it for results; FA
  §13 question 2 stays with the owner.
- The handle method surface: every method of LS §4.7 legal in tier F has a
  row in FA §6.1 or §7.1; the collection methods are refused in both.
- LS §9: String, Number, Boolean, BigInt, Math, Date, RegExp, Error, URL,
  `console`, `Object.keys`/`values`/`entries`/`fromEntries`/`hasOwn`/
  `assign`/`freeze`/`getPrototypeOf`, and the Array members other than those
  in F11 and F19 have a rule or fall under the scalar default.
- Diagnostics: `footprint:widened`, `cell:collection-method-in-function`,
  `cell:unsupported-method`, `function-body:ambient-read`,
  `mergeable-push:read-then-push` exist in LS §10 as FA uses them; the three
  new ones are FA's stated request 5.
- The five kinds of call and which body may make which: FA §8 against LS
  §5.2, BI "Which body may make which call", PL §3.14 and the Decided list.
- `BodyCall` fields FA uses (`identifiedBy` `order`, `tag`, `cause`;
  `builtin`; `binding`) and the `created` and `argument` targets of
  `WriteEdge` exist in PL §1.1.
- Cell creation: constant cause or whole-element cause is static, a cause
  computed from data is a materializer, in FA §8.2, PL §3.14 and ES §5.5.
- What makes a computation a materializer: FA §6.3 against OV
  ("Computations that write"), PL §3.11 and SS §7.1; its own transaction in
  PL §3.11, ES §1.9 and SS §2.1.
- A refused write fails closed: FA §6.4 and §9.2 against PL §7.4, ES §1.4
  and SS §1.3 (P4).
- Slot paths that cross a link: FA request 2(a) is met by SS §3.2 (the
  binding chain, observed for `identity`).
- Idempotency contract and validator: FA §6.6 against LS §4.7, ES §2.4 and
  SS §8.1. A cycle warning: FA request 5 against SS §8.2.
- The iteration bound of ten: ES §2.7 and SS §8.1; FA states none.
- What rests on the compiler: FA §9.2 rows against PL §7.3 (body narrowing,
  references, dynamic reads) and §7.4 (writes and calls fail closed), apart
  from F3.
- The Decided list: no statement in FA contradicts a ruling. FA §13
  questions 1 and 2 are flagged as arguments for the owner.
- FA §11 arithmetic: the totals of §11.2 (1,962 and 129), the shares and
  by-kind sums of §11.3, the three rows of §11.4 (1,201) and its 116
  breakdown, and the 33 and 10 of §11.5 add up.
- Source names FA cites that I looked up exist: `annotateWithBackToCellSymbols`
  (`runtime/runner/src/schema.ts`), `wholeValueDestination`,
  `isKnownIdentityArgumentCall`, `trackDynamicRead`,
  `markWildcardFromExpression`, `isBooleanConditionUsage`,
  `resolveValueRefs`, `getStaticPathKey`, `isInterproceduralSummaryTarget`
  (`base/ts-transformers/src/policy/capability-analysis.ts`),
  `hasCompleteSchedulerScopeSummary` (`lift-applied-strategy.ts`).

### What I did not read in full

- `footprint-analysis.md`, the plan, and section 1: read in
  full.
- `language-subset.md`: read §2, §4.3, §4.4 (table and the three rules),
  §4.5 to §4.7, §5, §6, §7, §9, §10.1 to §10.3, §11.5. Not read: §1, §3,
  §4.1, §4.2, §4.4.1 to §4.4.3, §8, §10.4, §10.5, the rest of §11, §12, §13.
- `plan-and-label-templates.md`: read the header, §1, §2, §3.1 to §3.3,
  §3.9 to §3.14, §3.16, §3.21, §3.22, §4.1 (first part), §4.4, §5, §6.2, §7,
  §8. Not read: §3.4 to §3.8, §3.15, §3.17 to §3.19, §4.2, §4.3, §6.1, §6.3
  to §6.5.
- `builtin-inventory.md`: read "Calls inside function bodies" (not the
  middle of "Pattern instantiation in bodies"), "What the plan records for
  calls in bodies", and "Factory values". Not read: everything before
  "Calls inside function bodies", and "Summary", "Decisions", "Open
  questions".
- `execution-and-storage.md`: read the header, §1, §2, §3, §4.1 to §4.7,
  §5.4 to §5.7, §10, §11. Searched by keyword only: §4.8, §4.9, §5.1 to
  §5.3, §6 to §9.
- `scheduler-and-serving-loop.md`: read the header, §1, §2, §3, §5, §6, §7,
  §8, §12. Searched by keyword only: §4, §9, §10, §11.
- `README.md`: read "The language" up to "Labels in the type system",
  "Label templates", and "Execution". The rest by keyword only.
- Source: I read `commitEdit` and its helpers, counted `computed(` and
  handler definitions in the eight FabriChat modules, and read the comment
  on `wholeValueDestination`. I did not verify FA §10.1's account of the
  transformer beyond the names above, and I did not check what a binding
  body reads today (F13).

## 5. The overview and the first three detailed documents

The continuation plan recorded that OV, LS, PL, and BI had not been read
against each other in full since their last revision. This section is that
read. The findings are in four groups: (a) contradictions between detailed
documents, (b) corrections to the overview, (c) wrong references, and (d)
open questions that have since been answered.

### (a) Contradictions between detailed documents

**A1. The array parameter of a collection callback, and whether it joins the
element key.**
- LS §4.4.1: "A third parameter (the whole array) is refused
  (`collection:callback-parameters`)"; and "The index is part of an element's
  key exactly when the callback declares the index parameter and its body
  uses it."
- PL §1.1 `Collection.bodyUses: { index, array }`; §1.3: "The position is
  part of the key only when the body uses it: `bodyUses.index`, or
  `bodyUses.array`"; §3.6: "A body that uses the array argument adds a `value`
  or narrower slot over the whole collection"; §7.3, §7.4: "unless the body
  asks for the array".
- BI `map` label rule: "on the whole input only when the body uses the array
  argument". BI "Element keys" itself has only the index in the key.
- Decided list: "The index joins the key only when the callback uses it."
- Governs: LS for the grammar (no array parameter), the Decided list for the
  key. Correction: in PL drop `bodyUses.array` and the "array argument"
  sentences of §1.3, §3.6, §7.3, §7.4 (a body that needs the array captures
  it by name, which is an ordinary slot); in BI `map` drop "only when the body
  uses the array argument". If capturing the source array by name is meant to
  put the position in the key, that is a new rule and needs the owner.

**A2. Tie-breaking by element key against "no element value enters the
choice".**
- PL §1.3: the key of a plain element is "the element's value, canonicalized
  and hashed".
- PL §3.17: the `key`-mode winner "is the element with the smallest element
  key in the canonical order, so no element value beyond the index key enters
  the choice"; PL §3.8: a `minBy`/`maxBy` tie "goes to the element with the
  smallest key in the canonical order of keys". The `choice` templates
  (§3.18) hold membership and a fold of the selector, nothing of the element.
- BI collection-index label rule: "the winner among equal keys is decided by
  element identity, so no element value beyond the key flows into the
  choice"; BI "Element keys": "the one with the smallest element key".
- For plain-value elements the element key is a function of the whole
  element value, so the choice does depend on element values the `choice`
  template does not contain. The two statements hold together only for
  elements keyed by cell identity.
- Governs: PL (label rule). Needs the owner or the specs change, since it
  changes a label. Smallest correction: break ties by first position in
  source order (order is already in the membership label), in PL §3.8, §3.17
  and BI "Element keys" and the index entry.

**A3. When the writer policy is checked for a handler received by reference.**
- BI "Binding a handler received by reference": "Both checks run when the
  binding is made, and a failure is a run-time refusal of the binding"; "a
  received handler that is not listed fails the check at binding time".
- PL §3.21 table: "When the handler writes: the resolved `Body.code` against
  the policy of the cell it was bound to"; "found when the handler first
  writes, not when the pattern is compiled".
- Governs: PL. Correction in BI: the schema fit is checked when the binding
  is made, the writer policy when the handler writes.

**A4. Durable state of `reduce`.**
- BI `reduce`: "The baseline is no value checkpoints: recompute the fold
  when anything it read changed, and store the result only if it is kept."
- PL §3.13: "`reduce` is an `Operation` of kind `reduce`. The baseline state
  is the result alone", with the multiset of step label identifiers
  maintained. LS §4.4.1: the accumulator is a data type because "the fold's
  state is stored". ES §6 cites BI as saying `reduce` has durable state.
- Governs: PL for the record. Correction in BI: "the baseline state is the
  result and the label multiset; no value checkpoints".

**A5. How a read of a child's output, `linksOf`, and `spaceOf` are recorded.**
- BI "A pattern factory value in the reactive tier": a read of a child
  output "is a read through the link to the child's result cell ... a link
  hop, dynamic by nature". PL §3.15: the plan "refers to the child's result
  through slots with root `child`"; "A `child` slot resolves to the label
  stored at that path of the child's result, like any slot."
- BI "Context reads", after the table: `linksOf` and "the pointer reads of
  `spaceOf`" are "a `dynamic` read, journaled like a read through a handle".
  PL §3.16: `linksOf` is "the `enumeration` slot of the list and the
  `identity` slot of each element"; `spaceOf(x)` is "the `identity` slot of
  `x`".
- Governs: PL. Correction in BI: both passages take PL's static slots; only
  `resultOwnerOf` and the access-list reads stay dynamic.

**A6. Compile-time constraint diagnostics.**
- PL §4.4 has five constraint kinds (`requiredIntegrity`,
  `maxConfidentiality`, `writeFloor`, `writerFit`, `writer`), says "A
  violation is a compile error that names the slot and the annotation", and
  adds a sixth report: "The compiler can still report the case where no
  element of the compiled pattern that binds the handler sits under a
  surface carrying the required pattern" (also §3.21 table, "Compile time
  (section 4.4)", and §6.3).
- LS §8.6 and §10.5 reserve three identifiers: `cfc-flow:max-confidentiality`,
  `cfc-flow:required-integrity`, `cfc-flow:write-policy`.
- A compile-time write-floor failure, a writer-fit failure, and the
  missing-surface report have no catalog entry, and for the last no severity
  is stated anywhere.
- Governs: LS for the catalog, PL for the conditions. Correction in LS §10.5:
  add `cfc-flow:write-floor`, `cfc-flow:writer-fit`, and an entry for the
  unbound UI surface; PL §4.4 states the severity of the last.

**A7. A factory-typed element is "never plain".**
- LS §4.4.1: "Never plain: an element type that is a cell handle type, a
  pattern instance, or a factory type. Such an element is identified by its
  cell." LS §1 and §7.2: a factory value "is a reference to a compiled
  definition", a data value.
- PL §1.3: the key is the value's hash unless "the slot holds a link". A
  factory value stored in a list is a value, so two equal factories share a
  key, and a stateful body over them shares state, which
  `collection:shared-element-state` exists to prevent.
- Governs: PL for the key, LS for the diagnostic. Correction in LS: move
  "a factory type" to the plain side (or PL states that a factory value is
  keyed by position).

**A8. `.for(tag)` on an instantiation has no form in the grammar.**
- PL §1.1 `BodyCall` `instantiate.identifiedBy: "order" | "tag"`, §1.3 table
  ("A handler, `.for(tag)`"), §3.14 table; BI "Pattern instantiation in
  bodies" ("The four `.for(tag)` sites show the explicit form").
- LS §4.4.2 and §5.2 give an instantiation the modifiers `asScope` and
  `inSpace` only; LS §4.7 declares `for(cause)` on "every handle type" and
  says the table is "the whole method surface".
- Governs: LS for the grammar. Correction in LS §4.7: the `for(cause)` row
  also names the value a pattern instantiation returns, legal in a handler or
  action. (K13 is about what the form means against source; this is that the
  form is missing.)

**A9. `inSpace` on a statically resolved callee in the reactive tier**
(adds to K12).
- LS §4.4.2: a statically resolved callee "denotes an anonymous sub-pattern
  compiled into the surrounding instance", "optionally through the modifiers
  `asScope(scope)` and `inSpace(space, options)`"; LS §4.7 makes the
  modifiers legal "where the instantiation they modify is legal". PL §1.1:
  a call "of a pattern the compiler can see" has no plan of its own.
- PL `Child.space` is the only place `inSpace` is recorded, and §3.15 says a
  child created with `inSpace` is not evaluated in the cause's transaction.
  A sub-pattern compiled into an instance of one space cannot live in
  another.
- Needs the owner: either `inSpace` in tier R always makes a `Child`, or it
  is refused there (the corpus has it in handlers only, BI corpus table).

**A10. Identity of a binding made in a handler, inside BI.**
- BI "Which body may make which call", reasons: "A binding creates a stream
  and the state the handler is bound to. In a handler it is new per event."
- BI "A handler binding made in a body": "A binding made in a handler can use
  the same rule; nothing there needs the event in the identity." PL §1.3
  table: "A handler binding is the exception: it is identified as in the last
  row everywhere."
- Governs: PL. Correction in BI: delete "In a handler it is new per event".

**A11. "The one node that depends on a value".**
- PL §1.1, comment on `select`: "The one node that depends on a value."
- PL §3.13: for `findIndex` "The label is a function of the match position,
  which is the value, in the way a `select`'s label is"; §4.2: the value code
  reports the position for `fold.through`; §3.18: the value code reports the
  key for a `pick` over a container. BI `findIndex`: "the rule is
  value-dependent in the way a conditional is."
- Governs: PL §3. Correction: the comment reads "One of three nodes whose
  label depends on a value, with a `fold` that has `through` and a `pick`."
  (OV has the same sentence, B9.)

**A12. What is instantiated.**
- PL §4.1: instantiation runs "only for kept outputs and write edges".
- PL §4.4: the egress ceiling is checked on "`C` of the effect operation's
  `input` template"; §3.14: captured data values are "copied into the
  binding's state document with `T_b`"; §3.15: a copied capture "is stored
  with the factory value under its instantiated template". None of the three
  is a kept output or a `WriteEdge` target kind. (§3.16's interim
  `inspectConfLabel` is K3.)
- Governs: PL. Correction in §4.1: add operation inputs, binding state and
  closure parameters to the list, or give each a `WriteEdge` target kind.
  (SS open question 13 asks ES the related question for effect requests.)

**A13. Catalog entries that do not match the rule that motivates them, and
refusals with no entry** (LS §2 rule 3: "No construct is refused without a
catalog entry").
- `opaque-get:invalid-call` (§10.2): condition "not a cell or stream type",
  message "Only `Writable<T>` and `Cell<T>`". The rule (§4.4, §4.7) is "not
  `Cell`, `Writable`, or `ReadonlyCell`", and "`Stream` ... has no `get`".
  Correction: condition and message name `Cell`, `Writable`, `ReadonlyCell`.
- `function-body:ambient-read` (§10.3) covers "a promoted expression, or the
  pattern body"; §5.1 states the rule for a `lift`, a `computed`, and
  authored functions they call, and by §9.5/§9.6 with §4.4 the same call in
  tier R is `reactive:unsupported-call`. One of the two has to own tier R.
- No entry for: `llm` and `streamData` (BI class D, Decided), `byRef`,
  `cell(...)`, `nameInstance` (BI summary, class D). Under §4.4 they fall to
  `reactive:unsupported-call`, whose message ("wrap in `computed`") is the
  wrong rewrite. Correction: one `removed-form:builtin` entry naming
  `generateText`/`generateObject`, the fetch family, `Cell.of`.
- No entry for LS §5.5's two refusals in a tier-I module: a cell-typed
  parameter, and importing a value from `commonfabric`.
  `import:signature-not-in-subset` is conditioned on "a type the subset
  refuses", which `Cell<T>` is not.
- No entry for BI `inspectConfLabel` and BI open question 1: "the compiler
  reports the case when it can see it statically" (adds to K3: if PL §3.16
  stands, the report goes away; if BI stands, it needs an entry).
- No entry for OV "The compiler reports the cycles it can see statically"
  (SS open question 21 already asks LS for it, as a warning), and no
  construct in LS for OV "An author annotation can force or forbid the
  promotion" (ES open question 26 already asks).

**A14. Inside LS: statements that cannot both hold.**
- §2 rule 2: an accepted program "is also accepted by the TypeScript compiler
  against the published `commonfabric` typings, so an editor shows no error
  the compiler does not also report." §8.6.1: "The typings change when the
  transformer, which reads the brands, is retired ... Until then one
  difference remains"; §13: the typings "become identity aliases". Until the
  typings change, `note.set(text)` without the cast (§12.5, which the
  compiler prefers and warns against the cast) is an editor error under the
  brand typings, so rule 2 does not hold in the interim and there is more
  than one difference. Needs the owner: state rule 2 as holding from the
  typings change on, or publish the identity typings at once.
- §3.2: "`computed`, `action`, and `assert` take a function and are written
  in tier R only"; §5.1, §5.2, §11.4: `action` is accepted in tier F.
  Correction in §3.2: "`computed` and `assert` in tier R only; `action` also
  in tier F (§5.2)".

**A15. The plan record against what BI says it has to hold for `inSpace`.**
- BI "An instantiation request from a handler", static part: the target kind
  ("a space identifier, the space of a given cell, a name the calling space
  resolves, or anonymous"), the options `grants`, `root`, `spaceKind`,
  `selfOwned`, and "the request's position among the body's `inSpace`
  requests".
- PL §3.14 repeats the four target kinds in prose, but `Child.space?: Index`
  is "the slot that names the target space": no form for a constant, a name,
  or anonymous, and no field for the options.
- Governs: PL for the record. Correction: `Child.space` becomes a union of
  the four kinds with the options.

**A16. Numbers that differ** (beyond K4 and K5).
- `reduce`: LS §11.4 "29 calls, all in function bodies today"; BI `reduce`
  "8 times in a `computed`, once in a `lift`, and 42 times in helper
  functions" (51).
- Inline event handlers in function bodies: LS §11.4 "8 (5)"; BI "Handler
  bindings in computeds": "Eleven more inline JSX event handlers sit inside a
  computed."
- `action` in a function body: LS §11.4 "1 (1)"; BI "What the corpus calls
  inside bodies": "No body in the sources, tests, or fixtures calls ...
  `action`".
- Inside LS: §11.4 has `some` 135 "all but 2 ... in function bodies" (133),
  `find` 65, `findIndex` 78; §11.7 has, in function bodies by name, `some`
  134, `find` 63, `findIndex` 77. A by-name count cannot be below a
  with-callback count.
- BI's `findIndex` (8 + 50 + 12 = 70), `some` (31 + 2 + 63), `every` (2) and
  `find` (17 + 25) are lower than LS's 78, 135, 14, 65; BI does not say
  whether helper functions are counted, so these may be scope, not error.
- Correction: one script and one method statement for both documents, as for
  K5.

**A17. One thing under two names, one name for two things.**
- `countTruthy`: PL §3.8 and §3.22 list it beside `count(predicate)` as an
  aggregate "as `builtin-inventory.md` lists them". In BI it is the internal
  operation name of the `aggregate` built-in; the authored surface (BI "Cell
  methods that create nodes", LS §4.4, §4.7) has `count(pred)` only.
  Correction in PL: drop `countTruthy`.
- `equals`: PL §3.16 lists `equals(a, b)` as a context read; BI lists it
  under "Pure functions and constants", omits it from the context reads of
  its summary, and counts it ("`equals` 108") under context reads in the
  corpus table; LS §5.2 does not list it and has it as a cell method (§4.7).
  Correction: BI and LS adopt PL's row, or PL moves it to §3.9.
- "selector": in PL a `Selector` record is a selection point of a `select`
  (§1.1), and "the selector" is also the key callback of `minBy`, `groupBy`
  (§3.8, §3.17, §3.18, "a `fold` of the selector's template"); `fold.through`
  is "the position that selector reports". Correction: call the callback the
  "key function", or the record `Selection`.
- "cause": the trigger of a transaction (OV "One transaction per cause", PL
  `SlotRoot.cause`) and the seed of an identifier (OV "the cause of their
  creation", LS `X.for(cause)`, PL `StateCell.name` "the cause"). Needs the
  owner; the second sense is inherited from the runtime's `.for(cause)`.
- Observation classes: OV and BI ("The overview's four observation classes")
  say four; PL §1.1 and §2.1 have five members of `ObservationClass` and call
  `labelMetadata` "a fifth class"; the continuation plan says "four observation
  classes plus label metadata". See B7.
- OV "Built-ins divide into two groups"; BI has "four classes" A to D.

### (b) Overview corrections

**B1. Staging, stage 3.** OV: "Template labels must be equal or tighter, and
never looser." PL §3.1, §3.17, §7.5 and the Decided list: one deliberate
exception, the collection index. Corrected: "Template labels must be equal or
tighter, with one deliberate exception: the membership label of a collection
index bucket is wider, because it includes the keys of absent elements
([plan format and label templates](plan-and-label-templates.md), §3.17)."

**B2. Staging, stage 4.** OV: FabriChat "exercises confidentiality, event
integrity, and per-row instances together". PL §6: "FabriChat declares
integrity and write policy, and no confidentiality"; §6.4: every
confidentiality in the example is empty in the deployed configuration.
Corrected: "because it exercises event integrity, write policy, and per-row
instances together."

**B3. Function bodies.** OV: the bodies "are full JavaScript and run in the
sandbox". LS §5.1: "Tier F is JavaScript with the restrictions below" (no
`async`, generators, classes, `this`, `var`, `for...in`, dynamic code). LS §1
also puts `assert`, inline JSX event handlers and module-scope functions in
the tier. Corrected: "The bodies of `lift`, `handler`, `computed`, `action`,
inline event handlers, and module-scope functions are JavaScript with a
stated set of restrictions ([language subset](language-subset.md), §5.1) and
run in the sandbox."

**B4. One transaction per cause: three outcomes, not two.** OV: "A cone that
fails, for example because a function body throws, does not [reject the
transaction]". PL §5.4 and ES §1.7: "A handler body that throws aborts the
transaction, as it does today." Corrected, added after the cone sentence: "A
handler body that throws aborts its event's transaction, as it does today;
the body of a `lift` or a `computed` that throws fails its cone."

**B5. Compile-time constraint checks.** OV: "Where the labels of the slots
are declared in schemas the compiler checks the constraint and reports a
violation as a compile error. Otherwise the check runs when the template is
instantiated." PL §4.4: "A compile-time check does not replace the run-time
one ... a compile-time pass on `maxConfidentiality` settles nothing, and only
a compile-time *failure* is final." Corrected second sentence: "The check
also runs when the template is instantiated, because a declared label is a
lower bound on what a slot carries; only a writer policy and a declared
integrity that satisfies a requirement are settled at compile time."

**B6. State cells and migration.** OV: identifiers derive from "the parent
instance, the element key where there is one, and the cell's name"; "Existing
stored state of an instance then keeps its identifiers, and migrating an
instance consists of no longer writing its per-node documents. State declared
inside a `map` body is the exception". ES §5.2, §5.7, §9.2: a cell declared
anywhere but directly in the pattern body gets a new identifier that includes
the enclosing compiled-in call sites; state inside a compiled-in sub-pattern
is found through a carry-over record; migration is a setup transaction.
Corrected: "the parent instance, the compiled-in calls and element bodies
that enclose the declaration, and the cell's name. A state cell declared
directly in the pattern body keeps the identifier it has today. One declared
inside a sub-pattern that is now compiled in has a new identifier and is
found through a carry-over record, and one declared inside a `map` body is
not carried over ([execution and storage](execution-and-storage.md), §5.7 and
§9)."

**B7. Observation classes.** OV, Label templates: "one observation class
(value, shape, enumeration, or identity)"; Function bodies likewise. PL §2.1,
§2.4: five, `labelMetadata` is "a fifth class". Corrected: "(value, shape,
enumeration, identity, or label metadata)".

**B8. Reactive expressions.** OV: "no function creation other than the
callbacks of the constructs below ... the array methods `map`, `filter`, and
`flatMap` are reactive constructs here". LS §4.4, §4.5: also `some`, `every`,
`find`, `findIndex`, `reduce`, the aggregates and the index methods; functions
are also written as the argument of `computed`, `action`, `assert`, as inline
event handlers, and as inline `pattern(...)`. Corrected: "no function
creation other than the callbacks of the reactive collection methods, the
bodies given to `computed` and `action`, inline event handlers, and inline
patterns. ... the array methods `map`, `filter`, `flatMap`, `reduce`,
`findIndex`, `some`, `every`, and `find`, the aggregates, and the collection
indexes are reactive constructs here". In "Built-ins and factories" the
prefix sentence names `findIndex` only; PL §3.13 and the Decided list give
the same rule to `some`, `every`, and the choice of `find`, and the
accumulator of `reduce` is a data type.

**B9. Conditionals.** OV: "This is the one place a template depends on a
value." PL §3.13, §3.18 (see A11). Corrected: "A template depends on a value
in three places: the branch a conditional selected, the prefix a `findIndex`,
`some`, `every`, or `find` stopped at, and the child a dynamic key or a
`minBy`, `maxBy`, or keyed lookup chose."

**B10. What is instantiated.** OV, one paragraph: "instantiates label
templates for those stored outputs alone"; Label templates: "The runtime does
this only for outputs it stores". PL §4.1, ES §1.6: also every write edge
(side-writes, a child's argument, a created cell), and effect requests (PL
§4.4). Corrected: "instantiates label templates only for what it stores:
kept outputs, the targets of side-writes, the arguments of child instances,
and effect requests."

**B11. Sandboxed calls.** OV: "the output's template is the union of the
slots in the body's footprint." PL §3.9: plus what the body read through its
handles, and a reference passed through or a required path is refined.
Corrected: "the output's template is the union of the slots in the body's
footprint and of what the body read through the cell handles it was given; a
reference the body passes on unchanged keeps its own label."

**B12. Imported TypeScript.** OV does not state the Decided marker. LS §5.5.
Add: "A module is imported TypeScript when it begins with the directive
`"use typescript";`."

**B13. Effectful operations.** OV lists "the staged changes to a space's
access list". BI "Staged changes" and "Decisions": `nameBlob` is an effect
request too, and `fetchProgram` is its own class B entry. Corrected: "the
fetch family and `fetchProgram`, ..., and the staged changes
(`grantSpaceAccess`, `revokeSpaceAccess`, `nameBlob`)."

**B14. Things a handler creates.** OV: "the cells and instances it creates
are new on every call and are identified by the event and their order within
the invocation." PL §1.3: a handler binding is identified by its handler and
captures everywhere, and `.for(tag)` names the same thing across events.
Corrected: add "A handler binding is the exception: it is identified by the
enclosing instance, the handler, and what it captures."

### (c) Dangling or wrong references

- **C1.** PL §3.18: "`language-subset.md` (open question 3) assumed the
  container's enumeration as well". LS open question 3 is now "A pattern
  closure written in a function body"; LS §4.4 and §13 state PL's rule.
  Correction: delete the sentence's reference.
- **C2.** PL §5.2: "which settles `language-subset.md`'s open question 2".
  LS open question 2 is now "Inline records in a stored list"; the settled
  point is in LS §13's "Settled by" paragraph. Correction: refer to LS §13.
- **C3.** BI `reduce`, label rule: "a `fold` in the sense of
  `plan-and-label-templates.md` §3.8". §3.8 is aggregates; `reduce` is §3.13
  and `fold` is defined in §3.2. Correction: "§3.13".
- **C4.** LS introduction and §5.4: "`footprint-analysis.md`, which is not
  yet written"; "Three documents beside this one own their subjects". FA
  exists, and ES and SS do too. Correction: drop "which is not yet written",
  and §5.4 refers to FA §5.2 for the causes of a widening (FA open question 5
  lists how LS §5.4's list differs; K9 is one of the four).
- **C5.** LS §4.4, calls table: "A context read, where the built-in inventory
  makes it legal in the pattern body | As `builtin-inventory.md` specifies".
  BI states legality for `handler`/`action` and `lift`/`computed` only, and
  "Legal in" in its context-reads table describes today. Nothing says which
  context reads tier R may make, though LS §10.3 refuses `eventKey` and
  `currentPrincipal` there. Correction: BI adds a pattern-body column to
  "Which body may make which call".
- **C6.** LS §8.1: "What an annotation means for the label of a stored value,
  and how declared annotations combine with label templates, is specified in
  `plan-and-label-templates.md`." PL covers `confidentiality`, `integrity`
  (`Slot.declared`, §2.3), `requiredIntegrity`, `maxConfidentiality`, and the
  writer policies with `uiContract` (§4.4). It has no rule for `exactCopyOf`
  or `projection` (`ExactCopy`, `ProjectionPath`, `ProjectionOf`,
  `Projection`), mentions `addIntegrity` only by example (§3.12), and does
  not say which annotation key yields a `writeFloor` or a `writerFit`
  constraint. Correction: PL §4.4 gains a table from LS §8.1's annotation
  keys to `Constraint` kinds and declared entries.
- **C7.** BI "What the plan records for calls in bodies": the `Body` record
  "has no entry for the calls of this section"; "The plan's `WriteEdge`
  targets are outputs and declared state cells, so a created cell needs a
  target kind of its own". PL §1.1 has `Body.calls`, `BodyCall`, and the
  `created` target. BI "Handler bindings in computeds": "`language-subset.md`
  §5.2 specifies the inline arrow and `action(...)` forms; the named form ...
  needs the same capture rules"; LS §5.2 specifies the named form.
  Correction: BI states these as present.
- **C8.** PL §3.5: "This settles the first case of `builtin-inventory.md`'s
  open question 1, more narrowly than the value observation it assumed". BI
  open question 1 and the `ifElse` entry now state PL's rule. Correction:
  delete the clause.
- **C9.** The continuation plan, "Open, and not needing the owner": "The
  overview lists the
  cross-cutting ones: gates under speculation, residual termination channels,
  cycles through side-writes, cache promotion, and migration." OV lists six;
  "Commits that span spaces" is missing.
- No broken file link or heading anchor was found in the four documents; all
  twenty linked files checked exist.

### (d) Stale open questions and met requests

- **D1. Inline records in a stored list.** LS open question 2 (to PL): "The
  runtime then keys them by value, and a body that declares state over them
  shares it ... The plan has to say what the runtime does there: add an
  ordinal among equals to the key, or fail the cone." PL §1.3 and open
  question 11, and BI open question 5, say the element's cone fails, "so that
  sharing never happens silently"; the continuation plan records that
  assumption. PL
  open question 11 and BI open question 5 in turn say LS "may prefer a
  type-level way"; LS §4.4.1 has chosen a static rule on element type and
  source. Correction: LS open question 2 states the fail-the-cone assumption
  and drops the description of sharing; PL 11 and BI 5 cite LS §4.4.1.
- **D2.** PL open question 3 ("The accumulator of `reduce` is a data type ...
  a rule for `language-subset.md`") and the same sentence in §3.13. LS §4.4.1
  and `collection:reduce-accumulator` have it. Correction: move to PL §8's
  settled paragraph.
- **D3.** BI open question 4 ("The label of a factory value") and BI
  "Binding a handler received by reference" ("The design also has to say what
  a factory value's label is"). PL §3.21 (the factory's `identity` slot joins
  everything the handler writes) and §3.15 (child instances, closures) say
  it, as BI assumed. Correction: move to BI "Decisions" with the references.
- **D4.** BI requests phrased as "the plan must" that PL has met: the fold's
  shape, tie rules and exact sum (BI `aggregate`; PL §3.8, "private to the
  runtime"); the anchors document among static write targets (BI `anchorsOf`;
  PL `WriteEdge` target `anchors`); the reference semantics of a conditional
  (BI `ifElse`; PL §3.5); the records of C7. A2 reopens the tie rule.
- **D5.** PL open question 9 ("Where provenance and origins are stored").
  ES §7.2 and §7.3 specify the record in the result envelope. Correction:
  refer to ES.
- **D6.** OV open questions that a newer document now answers or narrows, and
  that should cite it as "Residual termination channels" cites PL §5:
  - "Gates under speculation": SS §11.3 (the table of gates) and §11.5; what
    is left is SS owner question 7.
  - "Cycles through side-writes ... what the iteration bound ... is": ES §2.7
    and SS §8.1 (ten evaluations of a cone per transaction, already known).
  - "Cache promotion": ES §8 proposes the cost model and where the cache
    lives.
  - "Migration": ES §9 proposes the procedure; what is left is ES owner
    questions.
  - "Commits that span spaces": SS §9.4 and SS owner question 6, beside BI
    open question 3.
- **D7.** LS open question 7 ("Stored source ... part of the overview's
  migration question") and LS §10's preamble. ES §9.4 compiles stored source
  and lists the refused case as an owner question. Correction: cite ES §9.4.
- **D8.** BI open question 5's alternative and PL open question 1 are covered
  by D1 and by the known FA finding.

### Counts

- (a) 17 findings (A1 to A17; A13, A14, A16, A17 each hold several items)
- (b) 14 overview corrections (B1 to B14)
- (c) 9 references (C1 to C9)
- (d) 8 entries (D1 to D8)

### Decided rulings checked across OV, LS, PL, BI and found consistent

A document that does not treat a subject was counted as consistent when it
states nothing to the contrary.

- Rust compiler; kernel and scheduler stay in TypeScript.
- JavaScript value code and a data plan; no interpreted representation, no
  WebAssembly.
- Trust is unconditional and a property of the deployment; no fallback label;
  the statelessness check is the enforcement for subset modules and the
  load-time verifier runs only on imported TypeScript.
- Server-authoritative execution; clients speculate from the same artifact
  and never request effects (the "same gates" part is K18).
- One transaction per cause; a failed constraint rejects it; a failed cone
  takes a labeled error state (OV omits the handler-abort case, B4).
- Three tiers and the `"use typescript";` directive (OV does not state the
  directive, B12).
- `ifElse`, `when`, `unless`, `str` removed, with interim acceptance and a
  warning on the stated condition.
- The eight reactive collection constructs; `reduce` takes an expression and
  a data-typed accumulator (OV's tier section lists three, B8).
- `any` refused; identity-alias typings; no editor plugin (the timing of the
  typings is A14).
- `streamData` and `llm` removed; `wish` structural (no diagnostic, A13).
- `patternTool` removed in favor of a pattern closure (details are K12).
- Five kinds of call in a function body.
- A `lift` or `computed` neither instantiates nor requests an effect; a
  `handler` or `action` may, and so may a pattern a handler instantiates.
- Two kinds of factory value, resolved from their own compiled records; a
  `lift` result is not one.
- The keep set, the `[UI]` tree included; interim values not stored and not
  labeled (K3 is the one exception found).
- State cell identifier from its cause, named after the assigned variable.
- Element key by value or cell identity; value-derived keys salted (the
  index part is A1; factory-typed elements are A7).
- Equal plain values share a cone for computation only; the compile error.
- Stored per-element state is not carried over.
- The prefix rule of `findIndex`, `some`, `every`.
- A changed factory value tears the child down and starts one under the same
  name; `inSpace` identifiers known before the cross-space commit.

Stated differently in one place: "equal to or tighter, with one exception"
(OV stage 3, B1) and "the index joins the key only when the callback uses
it" (PL, A1).

### What was not read in full

- OV, LS, PL, BI and the continuation plan were read in full.
- FA: headings, §10.2, and §13 (open questions) only, plus searches for
  imported functions and diagnostics.
- ES: the introduction, §1 (all), §4.1, §5.1, the first half of §5.2, §5.7,
  §6 to §6.2, the starts of §7, §8 and §9 (through §9.2), §8.4, §8.5, and
  searches; not §2, §3, the rest of §4 and §5, §10, or §11.
- SS: the introduction, §1.6, §2.1, §2.6, §4.5, §8.1, §11.1 to §11.3, and
  §12 (open questions); not the rest.
- OV was checked against FA, ES and SS only through those sections, so an OV
  statement contradicted elsewhere in them may be missed.
- No claim about the current system was checked against source, and no
  corpus count was re-run; A16 compares the documents' numbers with each
  other only.
