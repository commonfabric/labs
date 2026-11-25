# Compiled pattern language: where each branch stands and what to do next

This document is for a session that continues the build of the compiled
pattern language without the conversation that produced it. It says which
branch holds what, which branches are not merged with each other, what each
open line of work needs next, and how a round of work is briefed and
verified. The design is in `docs/specs/compiled-pattern-language/`, the
decisions and open questions in
[compiled-pattern-language.md](compiled-pattern-language.md), and the
measurements in
[compiled-pattern-language-integration.md](compiled-pattern-language-integration.md).

## Branches

Every branch is in the repository `commonfabric/labs`. Worktrees are under
`.claude/worktrees/` of the main checkout. A branch marked "local" has
commits that are not pushed; push it before relying on it.

| Branch | Worktree | Holds | Pull request |
| --- | --- | --- | --- |
| `claude/fable-pattern-language-redesign-vvh48e` | `mystifying-bassi-ae84b4` | The specification and the plans | #9788 |
| `claude/compiled-pattern-prototype` | `compiled-pattern-prototype` | The crate, the plan emitter and a first executor | #9942 |
| `claude/compiled-pattern-topics` | `compiled-pattern-topics-merge` | The crate on the corpus of `main`, Topics on the executor | #10016 |
| `claude/compiled-pattern-runner-m3` | `compiled-pattern-m3` | The trunk of the build: milestones 3 to 6 merged, the store with frozen values, a resume by units | #10140 |
| `claude/compiled-pattern-serving-m6` | `compiled-pattern-m6` | Lists of links in documents by default, the window construct, the cost of a FabriChat send | none |
| `claude/compiled-pattern-sandbox-m5` | `compiled-pattern-m5` | The merged branch at `5db1c2658d`: every branch of the build, and the two executor fixes of round twenty (P453) | #10183, stacked on #10140 |
| `merge-attempt/serving-m6` | none | The merge of the serving branch, at `31d73441f8`; the merged branch was fast-forwarded to it | none |
| `claude/compiled-pattern-scoped-rows` | `compiled-pattern-scoped-rows` | Rounds twenty-one to twenty-four, and the four link-following commits of `claude/fabrichat-row-rights-68447f` (P470, P471), and rounds twenty-five and twenty-six, at `a184f568a0`: a scoped read in the body of a per-element construct stored per row (P454 to P456), the basis list over parts (P457), the room's tree of the space and the rows of a `filter` (P458 to P461), the store step of a result (P462 to P464); cut from the merged branch at `5db1c2658d` | none (local) |
| `claude/fabrichat-row-rights-68447f` | `fabrichat-row-rights-68447f` | The FabriChat room, real and copy, whose message rows derive their own controls; the two executor fixes of round twenty, carried onto the merged branch | none (local) |
| `claude/compiled-pattern-write-integrity` | `compiled-pattern-write-integrity` | Write policies, write authorizations and the acting principal of a compiled piece | none |
| `claude/compiled-pattern-carry` | `compiled-pattern-carry` | Review fixes of #9942 carried onto the trunk's code | none |
| `claude/compiled-pattern-topics-runs` | `compiled-pattern-topics-runs` | The measured Topics boards; the serving branch is merged into it for measurements (local) | none |

Five pull requests against `main` came out of the work and are independent
of the experimental option, all merged: #10142, #10145, #10146 and #10147,
and #10184, which stops a memory server's currency arming from cycling
between two spaces that read each other (the stall of the
`fabrichat-deleted-room` test on `main`). The owner's instruction of
2026-11-23 (Z89) is to open one for any significant fix to today's runtime.

## What is not merged

`claude/compiled-pattern-runner-m3` is the trunk of the pull request #10140.
The work after it is on two branches:

1. `claude/compiled-pattern-sandbox-m5` is the merged branch. It holds the
   trunk head `7b2a492b82`, the carry branch, scopes and write integrity
   (at `121959d0fa`, notes 892, 980 and 981; now fast-forwarded to the
   head of item 2), and every gate passes
   there. A piece that has named a document of a scope resumes whole, with
   no row left as stored, and writes no list of readers (P354, note 892); a
   piece with no scoped document is woken by units as on the trunk. A piece
   with a `wish` has scoped state, so under the serving loop with resume 71
   corpus pieces are found current where the trunk finds 80.
2. `claude/compiled-pattern-serving-m6` is merged on the branch
   `merge-attempt/serving-m6` (head `31d73441f8`, notes 982 to 1010), cut
   from the merged branch. Every gate passes there, `test/compiled/` in
   full on both storages, since the labels of a compiled piece are written
   through the content-addressed path (Z95, P452). The merged branch
   `claude/compiled-pattern-sandbox-m5` is fast-forwarded to it, so both
   names hold every branch of the build. The owner chose a stacked pull
   request over moving the trunk: #10183 has the merged branch as its head
   and the trunk of #10140 as its base. Round twenty's two executor fixes
   and their notes (1011 to 1015) are carried onto it from
   `claude/fabrichat-row-rights-68447f`.

The merged branch becomes the trunk once the serving branch is in. For a
merge: resolve the textual conflicts, then check the places where both
sides changed the same machinery without a textual conflict, regenerate the
emitted fixtures (`cargo build --release` in `base/pattern-compiler`, then
`work/r17-merge/regen.sh` under the session's project directory, which
handles the three trunk fixtures that name their module from the repository
root), run the gates below, rerun one figure of each side, and run
`compare/runner-corpus.ts` in its four modes. Four merges each produced
defects neither parent had (two time values compared as equal; a
handler-sent event that was either not durable or threw; every row evaluated
at a wake and a restore that dropped another principal's memo entry; a wake
by units that left no row of a list stored in documents), so a merge is not
finished when the conflicts are gone.

**What the last merge showed, and what is open on it** (notes 982 to 1015
on `claude/compiled-pattern-sandbox-m5`; notes 1011 to 1015 are round
twenty).

- *Scaling, open and the largest defect on FabriChat: with its rows
  deriving, a send stores both session documents whole, so a room of 1,000
  messages cannot be seeded.* Every FabriChat figure taken before round
  twenty, on this branch and probably on the serving branch alone (which
  has the same defect and the same row code), was of a room whose message
  rows were all in an error state: a body handed each row of a `map` over
  an array of references could not resolve the row's reference (note
  1011). The send at 100 messages counted 148 records, 32 evaluations and
  19 documents of 525 to 532 KB, and the dump held 206 error values, one
  per row in each of two session documents. With the rows deriving, a send
  gives 148 records, 49 evaluations, 29 evaluations of element bodies and
  33 documents of 2.35 MB at 100 messages, and 11.0 MB at 500; the two
  session documents hold every row and are stored whole at each send. At
  1,000 messages the seed was refused with `MessageTooLargeError` after 30
  minutes at 27 GB resident. The fix is plan (b) of note 1007: the per-row
  form of a scoped read inside the body of a per-element construct, with
  places pulled only where their inputs changed for the acting scope key.
  Round twenty-one built it on `claude/compiled-pattern-scoped-rows`
  (`b5aa103f8f`, local, not on the merged branch; notes 1016 to 1026, P454
  to P456): an expression of a row that reads a scoped value is a cone of
  its own per element key, stored in a document of its own per output and
  element keys with an instance per scope key, and the row, of the space,
  holds a link to it. A send then changes 44 documents of 0.57 MB at 100
  messages, 2.10 MB at 500 and 4.02 MB at 1,000, with 172 records, 59
  evaluations and 31 evaluations of element bodies at every size; the seed
  at 1,000 completes (979 s, 6.46 GB peak). A send still grows with the
  room through three documents: the basis document, which lists every
  document of the piece (1.88 MB at 1,000); the room's rendered tree, still
  of the scope `session` through reads the plan cannot see as scoped
  (`Handle.resolveAsCell` returns the handle where today's runtime follows
  the link; `Instance.rootOf` reads the `failed` member of a wish's state;
  1.74 MB at 1,000); and the argument document of the stored messages. The
  first of those reads is also a soundness defect: a message stores a link
  of the scope `user` that each reader resolves in its own instance, so a
  second principal would see its own profile as every message's author (no
  test; FabriChat runs with one user). The round also fixed a defect of
  `Instance.#current` that kept an entry's old value where bringing a
  dependency up to date wrote a position the entry read. It regressed
  `examples/fair-share/main.tsx` in the corpus (writer-fit refusals at
  every event, and a resume refused whole; cause not checked) and
  `apps/redactor/vault.tsx` varies between runs. Whether to plan apart
  every operator expression that reads a handle or a value of another cone,
  at the cost of a cone instance per row for each, is the owner's decision
  (note 1025).
  Round twenty-two (`4df0c33bdf`, notes 1027 to 1034, P457) found the
  cause of the regression: P455 kept each value place's scope in the map of
  the scoped-outputs document's paths, so a refused commit of that document
  marked every place of every row stale (`Instance.#valueScopes` now keeps
  them apart). `fair-share`'s refusals remain for another reason, a liveness
  defect: the marker of a stream that a derivation writes for the row of an
  element carrying a confidentiality clause is written under no record,
  takes the join of what the derivation evaluated, and is refused at every
  derivation while the element exists; `vault` loses an event under the
  serving loop the same way. The owner ruled on 2026-11-24 (Z96) that the
  marker carries the label of its row, as a record of what it depends on
  would give; not built. The basis document's list is now
  spread over 256 part documents (P457): the basis is about 4 KB at every
  size and a send writes about 31 parts, so what it writes still grows, at
  1/256 of the rate. Leaving out the documents a resume derives again was
  tried and refused whole resumes in the corpus. A send at 1,000 messages
  now changes 2.37 MB (4.02 before); at 100, 75 to 77 documents of 408 to
  416 KB. Four reads keep the room's tree of the scope `session` (note
  1031): the `failed` read of `Instance.rootOf`; the spread `...view`
  emitted as a read of the whole record; `{profileWish[UI]}`, a path of a
  `wish` result of the scope `user` placed as a JSX child; and the rows'
  `authorProfile` (the link-following work). With the first three changed in
  a scratch worktree the tree is of the space and a send at 100 changes
  220 KB. Round twenty-two did not land `rootOf` without `failed`: it
  exposed an executor defect, a value that becomes scoped after `#generated`
  stored it in a document of the space was refused by
  `#refuseStoredForEveryKey` (note 1030). Round twenty-three fixed that
  defect, the `#generated` case included (P458), and landed `rootOf`
  without `failed` (P459). Emitting the spread as a pass, which stores less
  label, the owner ruled on 2026-11-24 (Z97); not built.
  Round twenty-three (`71fefaf1e3`, notes 1035 to 1043, P458 to P461) made
  the room's rendered tree of the space: a value that becomes of a scope
  after its array was stored in a document of the space moves to the scope
  instance (P458; before, one user's value was written into the space
  document every reader reads); an operation's result is the reference to
  its outcome, with no read of `failed` (P459); a member read by a well-known
  key of the API, as `profileWish[UI]`, is a static path (P460); a `filter`
  brought up to date looks only at the positions a change touched, 4
  elements per append at every size where it looked at 2,504 at 1,000
  (P461). A send now changes 329 to 331 KB at 100 messages, 480 KB at 500
  and 714 to 729 KB at 1,000 (2.37 MB before), and peak resident at 1,000
  is 4.69 GB (7.54 before). The time per send did not fall with the bytes:
  storing the result, which now holds the tree, places it again at each
  send and notes the records of every position again
  (`Instance.#noteRecord`, note 923): 29 ms at 100 messages and 404 ms at
  1,000, against 90 ms before. The harness's `Instance.streams()` walk adds
  353 ms per send at 1,000 (harness only). Planned in note 1042: register a
  record by the inputs it names, not by every position they reach; a
  `filter` over the rows of a `map`, now formed whole at each change, kept
  by row; the members of an assembly without positions (a change of
  representation). Still growing per send: the argument document of the
  stored messages, the basis parts, and each main-conversation row document,
  still of the scope `user` through `authorProfile` (the link-following
  work).
  Round twenty-four (`5fc3cf732c`, notes 1044 to 1053, P462 to P464): placing
  a result again skips a record or array that is the value placed before (83
  positions per send at every size, where it was 621); records whose inputs
  have equal content share one set of positions, so registrations per send
  fell from 6,798 to 1,012 at 100 messages; a `filter` over the rows of a
  `map` is brought up to date by row; the harness finds a stream once. A
  send at 1,000 messages took 323 to 337 ms of the piece's own time where it
  took 549 to 565 at the same load, with 300 records per send at every
  size. Open: registrations still grow about 8 per message; the index of
  label readers grows with the square of the room over its life (fixing it
  changes which records a label change reaches, CFC question 5 of the
  round).
  The link-following work (`017819452f` and `1f0c02922e` with their notes)
  was cherry-picked onto `5fc3cf732c` on 2026-11-24 at the owner's word; the
  only conflicts were two trailing parameters of `Instance.stored` and the
  notes. Every gate passes and the corpus is unchanged in its four modes,
  and the rows of the main conversation are now of the space. But a send
  follows the room again: 490, 1,290 and 2,290 records at 100, 500 and
  1,000 messages (300 before), and 191 to 197, 1,190 to 1,491 and 2,837 to
  3,155 ms of the piece's own time; the seed at 1,000 took 1,701 s.
  Round twenty-five (`8442957f6f`, notes 1067 to 1076, P472 and P473) found
  the cause in two paths older than round twenty-one that held only while
  the rows were of a scope, not in the merge's resolution: a change of
  labels re-gave the record of every row that read a `*` position of a
  changed document, though no label at its positions changed (P472: only
  records reading a position whose label changed are formed again); and a
  handler's test of whether a value is there copied the whole result held
  in place (P473: `Host.readChildren` reads none of the children). A send
  is back to 282 records at every size, 45 to 48, 146 to 152 and 287 to 367
  ms of the piece's own time at 100, 500 and 1,000 messages, and the seed at
  1,000 takes 287 s. `SCALE_GROWTH=1` in the FabriChat harness now fails
  when a send's counts differ between 100 and 200 messages, and the
  harness counts the error states the piece's documents hold.
  Open, found by that count: the merge put every message row's reactions
  in an error state ("a collection of a scope narrower than the space, in a
  row of another collection", one per row), since the row, now of the
  space, maps over a value of the scope `user`; the plan is a place per row
  and scope key for such a nested collection (note 1075), not built. Also
  brought by the merge and not traced: a Topics create gives 205 to 206
  records where it gave 111 to 123, and the first create of a run is
  refused once; `system/fabrichat/message-row.tsx` in the corpus handles
  fewer events. Observed at every commit and not traced, a possible
  under-label: a body that iterates `items.get()` and reads `item.title`
  stores no clause of the item at its outputs, where reading by
  `items.key(i).key("title").get()` stores it (CFC question 3 of the
  round).
  Round twenty-six (`a184f568a0`, notes 1077 to 1086, P474 to P478) fixed
  the reactions and answered the label question, and did not reproduce the
  Topics create: the rows of a scoped collection below a row of another
  collection are stored in a document per collection and outer element
  keys, with an instance per scope key, and an assembly is set aside with
  its element table when the acting principal changes (P474, P475), so FabriChat's
  dumps hold no error state at any size; Z96 is built (a row's stream
  marker carries the membership label of its row, P477, in a document the
  piece owns, P476), and `vault`, `fair-share` and `group-chat-lobby`
  commit every event in the corpus, and `profile-embed` handles 5 of 5
  (see its open item below); Z97 is built (P478),
  and the room's result document is 110 KB where it was 183 KB at 100
  messages. Both rulings were classified as conforming implementation, with
  no change of the specification (note 1083). The possible under-label
  does not hold: on today's path and the compiled path alike, a body that
  iterates `items.get()` stores the items' clauses once the titles are
  read (`compare/both-paths.ts`, option `labels`). The Topics create's 205
  records and refused first create did not reproduce at any commit,
  including those where round twenty-five saw them, so the cause is
  unresolved; the race between sessions' runs of P450 is one possible
  reading, not confirmed by a run. The
  `message-row` change is the module's own authorship check, reached now
  that `get()` follows one link. A send gives 304 records at every size and
  takes 37 to 38, 118 to 122 and 293 to 324 ms of the piece's own time at
  100, 500 and 1,000 messages, changing 256, 390 and 600 KB; the seed at
  1,000 takes 262 s. Open (note 1085): entries over the elements of a `map`
  over a `computed` output are compared at every pull (ruling Z53); a
  compiled start whose first derivation reads a value under a clause is
  refused where today's path commits (note 1079); the crate gives no value
  function for a `computed` declared in an element body whose result is
  the source of a collection (note 1082).
- *Fixed in round twenty, two executor defects (notes 1012 and 1013).*
  `Executor.#invoke` handed a body a plain value where an `identity` entry
  of `Body.computed` reached each row through `*`, so a body that resolved
  the row's reference failed; it now hands a handle at each row and reads
  nothing of what it names (test `body-argument.test.ts`, over an array of
  references and over an array of plain values in place). A read of one
  member of a value another cone computes, by a static path or by a key,
  depended on the whole value, and a `pick` over a container read the whole
  container; it now depends on that member alone (P453, emitted as one call
  carrying the path: `$h.output(n, path)`, `$h.value(n, path)`,
  `$h.slot(n, [key])`). Over an array of plain values in place, at 10 and
  100 members, adding a member no row reads evaluates 0 element bodies
  where it evaluated 10 and 100, and writing one row's member evaluates 1
  (test `member-read.test.ts`). In FabriChat a send evaluates 29 to 31
  element bodies at 100 and at 500 messages where it evaluated 131 to 133
  and 531 to 533; the time barely moves, because storing the two session
  documents dominates it. Open: a read of a path below the result of a
  `map` or `filter` still depends on the whole result; two CFC questions
  (note 1015) on the label of a `pick`'s container and of a reader whose
  member did not change.
- *Closed by Z95 (P452): a commit whose label table would expand past
  16 MB was sent with its labels inline and refused as too large.* This is
  a defect of today's runtime that a compiled piece reaches first: a
  document written with no plan record stores the join of what the
  transaction read, once per written path, and `compressLabelMetadata` in
  `runtime/memory/v2/label-metadata-table.ts` returns the message
  uncompressed when the references would expand past
  `MAX_LABEL_METADATA_EXPANSION_BYTES`; the server then refuses it at
  `MAX_UNTRUSTED_MESSAGE_SLOTS`. On today's path a transaction that reads
  200 documents under distinct clauses commits 256 written documents and is
  refused at 600 (test kept outside the repository,
  `work/r17-merge/today-wide-join.test.ts`; not yet a pull request against
  `main`). Every transaction of a compiled piece now sets the
  content-addressed label path (`setCfcContentAddressedLabels`): a label
  longer than `CFC_LABEL_INLINE_LIMIT` (128 bytes) is stored once as a
  `cid:` label document and referenced. The largest commit of a start over
  201 items, each under its own clause, went from 1,421,245 slots and
  34.7 MB, refused, to 22,224 slots and 452 KB; all commits of that start
  from 35.3 MB to 1.09 MB. An older runtime cannot read those documents,
  which the owner accepted ("don't worry about backwards compatibility").
  Tests: `content-addressed-labels.test.ts` (a client and a second piece
  read the labels equal to a run in version 1; today's path still writes
  version 1), and the 201-item cases. Open: a start still
  writes one label entry per written path of its lists of readers (884 at
  200 items), so the count of entries follows rows times parts; what label such
  a document owes is deferred question 1 of round thirteen.
- *Chunks of a list are not to be the default* (recommendation by Z91; no
  decision taken, the default is unchanged). With links in place, in one
  list document, or in chunks at 128, the list fixture's second client
  reads an add after 48, 57 and 5,023 ms at 1,000 rows and after 223, 408
  and 67,732 ms at 10,000, against today's 189 and 2,747 ms. A client that
  wants the rows of a chunked list in order has to watch the whole list.
  One list document rewrites the list at every add, so the piece's time
  follows the rows there (328 ms against 52 ms for 10 events at 10,000).
  Five cases of `link-lists` assert the chunked layout and fail with the
  whole-list limit unbounded.
- *A client that watches a whole list of 1,000 rows pays seconds per
  change in every layout,* and this is today's runtime code: the sink
  action re-traverses every row at each callback (`Cell.sink`,
  `subscribeToReferencedDocs`, `deepTraverse`), and 6.2 s of 8.8 s are the
  CFC preparation of that read-only action (`prepareTxForCommit`,
  `deriveFlowJoin`). Not measured on today's piece; a candidate for a pull
  request against `main`.
- *Fixed: a scoped array output was rewritten whole at an append.*
  `Instance.#putScoped` now splices the run of positions that differs. A
  FabriChat send at 100 messages gave 188 records after this fix and
  before P451 (688 to 698 before the fix, 189 on the serving branch), and
  gives 148 after P451, with the rows deriving as well (round twenty). Open:
  a scoped output still holds all rows in one document, so bytes and time
  of a send follow the room; the figures with the rows deriving are in the
  first item of this list. The figures recorded here earlier for
  `messageRights` (a `map` over the array of message references with a
  `PerSession` output) at 10, 100 and 1,000 messages were of rows in an
  error state and no longer stand. The plan to store it per row is note
  985, and per row and scope key note 1007.
- *Fixed (P451, which the owner agreed with on 2026-11-24, Z94; notes 990
  to 1002): a view that read one value of a scope was stored whole, once
  per scope key.* The board's view reads `hasProfile`, which reads the
  `#profile` wish of the scope `user`, so the whole `[UI]` entry was of
  that scope, with the cards of the `map` over the array of topic
  references settled into each principal's scope instance (3.39 MB at
  2,000 topics) and compared member by member at every edit. The scopes
  round (`75ad91d5f9`..`f315960774`) caused it on its own. Now an operator
  expression written as a JSX child or attribute value, outside every
  element body, that reads a name whose place is of a scope gets a cone of
  its own (`Emitter::eval_placed`, `hoisted_scope` and `place_scope` in
  `src/plan.rs`), and the cone around it holds a reference to the scoped
  place (`Host.output`, `Instance.scopedValue`), as today's runtime does
  with a node of its own. An edit of a Topics title is 1 derivation and 5
  evaluations at 100, 1,000 and 2,000 topics, 2.6 to 6.3 ms in the piece,
  which is what the serving branch alone gives; the scope instances are
  448 bytes at every size; a FabriChat send at 100 messages gives 148
  records (188 before). The owner ruled (Z94) that the other cases are
  covered as well. A bare `{name}` and an authored `computed` or `lift`
  body were already covered by the change: the crate planned them as
  cones of their own, and only `Host.output` had classed the tree as
  scoped (tests `scoped-bare.tsx` and `scoped-computed.tsx` at 10 and 100
  items; a `lift` over a scoped argument checked by plan inspection only).
  Not built: the read inside the body of a per-element construct (a `map`
  over an array of references, over an array of plain values in place,
  and over the result of another per-element construct); the plan is note
  1007. It holds a scaling finding: with `Instance.#pullScoped` as built,
  per-row scoped places would exist for every scope key the piece has
  seen and every run would visit all of them, rows times keys, so the plan
  needs places pulled only where their inputs changed for the acting key,
  and then places made on a reader's demand. Open:
  - `system/profile-embed` fails 4 of 5 events in every run, with writer-fit
    refusals on two documents outside the piece's store: the handler's
    copy of the profile's user-scoped name and bio carries the profile's
    and the acting principal's `User` clauses, which the targets' writer
    policy admits in neither. The scoped places store the same clauses the
    value had before P451, and the same refusal occurred before P451 in
    one run of two, so P451 does not record a larger label (note 1006).
    Whether the copy owes that label, so that the runs that handled every
    event under-labeled it, is open: a CFC question deferred by Z88, not
    settled. Today's path was not run on it. In round twenty-six's corpus
    runs the module handles 5 of 5 events; which change admitted the two
    documents is not traced (the round inferred P476, which enrolls a
    stream marker's document as a store the piece owns, but did not
    identify the refused entities), so the question stands.
  - No test checks the stored labels of the positions around a scoped
    value under clauses that differ between principals.
  - Note 892's rule stands: a piece with scoped documents resumes whole.
    The rows of the space are now units of the result whose bodies read
    nothing scoped, so what a wake by units still needs is a basis per
    scope key.
- *Fixed for one case (P450): the runs of one pass for several sessions
  read the result of an instance a handler made before its first
  derivation committed,* which refused a Topics create one to three times
  and gave every record of the board again (20,297 records at 1,000
  topics). `CompiledPiece.#madePending` holds the piece's other runs from
  deriving until the transaction of the run that made the first derivation
  ends. Today's runtime has no counterpart of this mechanism; it is a
  consequence of deriving once per session (note 892's open item). The
  refusals that remain, and the work of a create, follow the number of
  sessions (note 1005; counts at 100 and 1,000 topics alike): with 3, 5
  and 9 sessions of one principal a create takes 13 to 16, 25 to 30 and 50
  to 88 derivations, 197 to 229, 393 to 457 and 665 to 1,122 records, and
  1, 3 and 3 refusals; with 9 sessions of 7 principals, 96 to 105
  derivations and 1,111 to 1,271 records. From 5 sessions on, each refusal
  names the board's result document: the first session's run writes it,
  and the other runs read it stale and are refused. Each session's run
  derives the part of the space too; deriving that part once per pass and
  then each scope's part over committed documents is the fix, not built.
  Test `made-session.test.ts`.
- *Not built: a session no client holds any more is still derived at
  every change.* The piece derives for every scope key it has seen. On
  today's path a document of a session is derived because a client's
  subscription demands it, and a client that left demands nothing. The fix
  is that rule: a scope instance is derived only while something watches
  its documents, which also bounds the memory that follows the principals
  ever seen. It reaches the demand registry of today's runtime and is a
  round of its own. The serving runtime's own identity also keeps a copy of
  each scoped value that nothing reads.
- *Not diagnosed:* a create at 100 topics threw `TypeMismatchError` in
  `RuntimeTransactions.change` from `#storeResult` once and did not
  reproduce; 3 of about 24 serving runs went idle before the load (note
  931), two of them on the serving branch alone.

Provisional decisions were numbered per round to avoid collisions: P250 to
P253 serving, P270 to P275 and P330 to P335 resume by units, P290 to P296
and P350 to P360 sandbox and scopes, P310 to P316 and P370 to P382 write integrity, P410 and
P411 specification review; P420 to P425 resume by units, fourth round; P390
to P394 serving, round fifteen; P450 to P464 the merges and rounds nineteen
to twenty-four, P470 and P471 the link-following work, P472 to P478
rounds twenty-five and twenty-six (the next is P479). Note
numbers in `SPEC-NOTES.md` likewise: 692 to 704, 860 to 875 and 960 to 975
trunk, 940 to 944 carry, 742 to 752 and 880 to 892 sandbox, 760 to 772
and 900 to 914 write integrity, 851 to 866 and 920 to 932 serving, 980 to
1086 the merges and the rounds after them (1016 to 1086 on
`claude/compiled-pattern-scoped-rows`, 1060 to 1066 the link-following
work; the next is 1087). The plan documents hold decisions up to
P210 and P410 to P411; the rounds after that are in `SPEC-NOTES.md` of their
branches only and need a document round after the merges.

## Open lines of work

Each line names the notes that hold its plan. The notes are in
`base/pattern-compiler/SPEC-NOTES.md` on the branch named.

**A piece loaded again in another process** (trunk; notes 843, 860 to 875,
960 to 975).
"Takeover" in the notes and tables means that a serving runtime starts over
a space that already holds a compiled piece: a restart or deploy of the
server, or a move of the space to another process. It is not the first run
of a pattern. A piece whose sources did not change is found current from its
basis and evaluates nothing. The first event afterwards evaluates the whole
derivation unless the piece's collections are left as stored. Rows of a
`map` over an array of references are left as stored, with or without
handler bindings, at a named path or in a view node. By what the plan of
each module says, the wake takes 47 of the corpus's 84 row-document
collections at the trunk commit `a467194a96` and 81 of 84 at `7b2a492b82`,
which adds rows over the output of a `lift` (the `lift` is evaluated once at
the wake), over a `filter` and over a `sortBy` (the source evaluates one
body and reads one item document per element at the wake, so the wake still
follows the collection there), and rows whose body holds a `computed`,
another collection or a read of its position. A collection the plan takes
does not always leave its rows: in the corpus run with a takeover and
arrays written as references, the plan takes a collection in all 19 modules
that have row documents and an event behind the takeover, and 14 of them
leave rows as stored (note 971); with plain values in the argument none
does. Not
built, each with a plan that names the functions to change and the tests to
write first: the result of a body stored per element key, which the index,
the sort, the `flatMap` and an upstream left as stored all need (note 966);
the entries of the pattern's own body (967); the costs of the wake itself,
that is the registration per row and binding, the table formed whole and a
refused commit that evaluates every row (968). An array of plain values, in
place or generated by a `lift`, is evaluated whole. On the list fixture the
first event after such a start takes 172 ms at 10,000 rows against today's
55 ms, and peak memory is below today's at every size measured (resident
set 1.5 to 1.7 GB against 4.7 GB at 10,000 rows, with the server, the loop
and two clients in one process); the load is the peak, at about 23 KB
retained per row. Topics therefore still evaluates its whole
derivation at the first edit after such a start: 8.5 s at 2,000 topics. The
owner ruled on 2026-11-23 (Z90) that this step matters a lot: it is to be no
slower than today's path for the same pattern, and tearing a worker down and
bringing it back up is to be cheap. Peak memory is measured on the list
fixture alone; on Topics at 2,000 topics it is still to be measured, so
that a process is known not to run out there. This is the line of work with
the largest gap to the owner's rule.

**A step that changes a list as long as the collection** (serving branch;
notes 851 to 866 and 925 to 930). Row links are stored in list documents by
default (P392); a list of at most 128 rows is one document and reads as an
array (P393, option `listWhole`). Under the serving loop at 2,000 topics an
edit of the mentions takes 121 to 134 ms against 347 to 405 ms with the
links in place, and a create 205 to 236 ms against 560 to 737 ms. Open:
above 128 rows a runtime client reads an array of chunks, and no flattening
is built in the runtime; a reader of one row of a chunked list pays about
35 ms more for the edit of a middle title, not profiled; the record of
bucket links stays one document (P394; 349 KB changed by an edit of the
`shortName` at 2,000 topics). A handler's write of an input it changes at
one position is already positional (test `handler-positions.test.ts`).

**A piece set up under the serving loop that is never run** (serving
branch; note 931). In 4 of about 66 runs of the Topics `serving` arm the
serving runtime was quiescent, the setup had committed, the result document
held nothing at `mentionable`, and no failure was reported. The cause is not
found. `SCALE_LAYOUT` on the Topics harness prints the layout and the count
of pieces the serving runtime runs. This is the first thing to diagnose on
that branch.

**A FabriChat send** (serving branch; notes 732 to 741, 860 to 862, 920 to
932). The owner's rule that a send does not grow with the room is not met:
at the head `c0e0a41014` a send on the runner path takes 66 to 72 ms at 10
messages, 197 to 207 at 100 and 829 to 892 at 1,000, about 0.75 ms and
1.3 KB per message held. These figures were probably of rows in an error
state (the branch has the defect of note 1012 and the same row code; not
checked there); with the rows deriving on the merged branch the bytes of a
send are about 23 KB per message held (first item under "What the last
merge showed"). Built in round fifteen: the record of a place a
comparison left as it was is not given again (P390, `exec/inputs-digest.ts`;
88 to 90 records per send); the window construct `xs.last(n)` and
`xs.first(n)` (P391), which an append moves by one splice over an array of
references and over the result of a `filter` or `sortBy` over one, and which
is formed whole over the result of a `map`; the main conversation of the
room's copy as a `filter` of the stored messages, a `map` over its result
and a window. Open, with the plan in note 923: `places`, `authors`,
`entries`, `threads` and the counts are still one body, so `facts` reads 5
positions per message held; `Instance.#noteRecord` registers each record at
every position its inputs reach (331 of 830 ms in one profile at 1,000);
`rowFactsForSession` reads every row of the rights; `Store.#deep`; the
`filter` branch of `Instance.#reassemble` forms its rows from every element;
a `map` over the result of a body kept by key and the schema of a link
stored once (note 861); `elementById` and `resolveAsCell` in the reactive
tier; the keys of a `groupBy` in creation order. A soundness defect seen on
the fixture `unchanged-place.tsx` is open: a cone that is evaluated again,
binds a slot to another position and returns an equal value gives no record,
so the place keeps the label formed from the earlier position.

**More than one user on a piece** (sandbox branch; notes 880 to 892).
Documents of the scopes `user` and `session` are held once per principal.
Open: the runs of one pass for several principals do not see each other's
writes, so an entry of a scope that reads a row document written in the same
pass is refused and runs again (plan: two scheduler actions, one for the
space and one for the scopes); a piece with a `wish` or scoped state resumes
whole and is never found current (P354, note 892; needs a basis per scope key); the
assembly of a scoped collection is formed again per principal; memory
follows the principals ever seen; a `wish` for a seeded profile does not
resolve under the serving loop (not diagnosed); FabriChat with two users was
not run.

**Write integrity** (write-integrity branch; notes 760 to 772 and 900 to
914; P310 to P316 and P370 to P382). A compiled handler is named by the
crate's content-addressed module identity and the binding path, only where a
writer policy of the program names the binding and the artifact is one the
runtime compiled or a host vouched for (`CompiledPieceOptions.attested`).
FabriChat's room sends and Home starts with their declared policies. A
harness, `compare/both-paths.ts`, runs one scenario on today's path and on
the compiled path with the same gestures and principals and compares
commit, message, values and stored claims: 12 of 14 hand-written scenarios
are equal, and in the 28 corpus modules that declare a write policy and run
compiled no step is committed on one path and refused on the other. The
harness found six cases where the compiled path committed what today's
refuses or stored a weaker claim; all six are fixed. Open:

- A piece a serving runtime starts from a stored argument: the client
  writes the argument document under no schema, so the claims of the
  argument type are stored for a field only when a handler of the piece
  first writes it, and its first values are attributed to no one. This is
  the path a deployed piece takes, so it is the first thing to close.
- A state cell document created by a write other than its seed stores no
  policy of the cell's schema; no path to that state is known.
- No module succession for a compiled writer (note 910 lists what an update
  of a compiled pattern needs).
- FabriChat's room with two principals was not run on both paths.
- The compiled path is stricter than today's for a computed output whose
  result type names a writer (P379).

The rules the specification pull request has to state are the first three
deferred questions of the first round and the first six of the second.

**Stand-ins that remain in the FabriChat and Home copies**
(`base/pattern-compiler/compare/fabrichat/`, `compare/home/`): `any` and the
re-typing overloads removed, handle declarations changed, a guard written as
a conditional expression, `elementById` and `resolveAsCell` moved into
authored functions, Home without a hand-made schema. Seven built-ins and
every effect other than the four fetch effects are unanswered.

**A server that compiles** (sandbox branch; note 749). A toolshed installs a
compiler for the serving loop on the main thread. Open: the loop in Workers,
and the compile inside the serving loop's wait.

**Review fixes carried** (carry branch, pushed; notes 940 to 944). The four
findings of the first review of #9942 and the missing observation for
`Object.fromEntries` (P411) are fixed there, and a round of tests for a
handler that writes, reads and fails found and fixed one soundness defect: a
cone whose side-write a refused commit took back was never evaluated again
(`Instance.restore` now drops the memo entries of the cones that wrote a
restored document). Open from that round:

- `compare/values-corpus.ts run` gives 7,314 of 7,463 values equal on the
  trunk's code where note 571 has 7,325; the comparator fix does not change
  the count, and which change lowered it by 11 is not found.
- The agreement figures of note 534 (6,013 of 6,107 and 1,484 of 1,584) were
  taken on the prototype branch and are not rechecked there:
  `pattern-compiler emit --corpus` panics on that branch. On the trunk's
  code every comparison that `firstDifference` decides was run with the
  comparator before and after its fix and gave the same counts and the same
  lists of differences, so the fix lowers no figure there; whether note
  534's own figures hold at their commit stays open until the panic is
  fixed or the figures are replaced by the trunk's.
- The fix for the left operand of `??`, `||` and `&&` on the prototype
  branch (#9942, `Host.selected`) tests the operand through an `identity`
  slot; the same form failed the stored-labels soundness check on the
  trunk (fixture `held-in-place`), where the fix was built differently
  (`Host.operand`). Check the prototype branch's form against that check.
- A handle on a kept output in a handler's state reads the result-document
  position, which only the store step of a derivation writes, so the second
  event of a batch can read a stale value through it.
- `new Map(v)` in `src/footprint.rs` records no `value` at `v/*/0`, the gap
  closed for `Object.fromEntries`.
- `CompiledPiece.#keepMinted` writes into a transaction a failed handler
  aborted and logs an uncaught error.
- `compare/values-fixtures.ts` stops at the first fixture today's runtime
  refuses to compile and prints no table; run it per fixture.

**Review findings on #9942 not yet addressed** (three, from the review of
the commit `b11109b6fb`; each is a claim to check with a failing test first,
on the prototype branch, and then on the trunk, whose `exec/store.ts` was
rewritten since):

- `Store.write` and `Store.put` in `exec/store.ts` compare stored values by
  a serialization that erases the difference between an `undefined` position
  and `null`, so a change of `[undefined]` to `[null]` is dropped (review
  comment 4670306219). On the trunk the comparison is `sameStored`; check
  whether it tells the two apart.
- `Store.undo` restores the previous value of a write beyond the end of an
  array and not the array's length, so an undone write at index 3 of an
  empty array leaves length 4 (comment 4670306234).
- `structure` in `src/emit.rs` joins the entries of an array literal with no
  final separator, so a literal that ends in a hole loses a position:
  `[x,,]` is emitted with length 1 and `[,]` with length 0 (comment
  4670306243).

Each thread on the pull request gets a reply and is resolved when its
finding is fixed or shown not to hold.

**Review findings on #9788 not yet addressed** (three, from the review of
the commit `243e0368a4`; each is a claim to check against the specification
text, and a design point settled is a provisional decision with a question
for the owner, as P410 and P411 were):

- `footprint-analysis.md`, the array methods table: `entries()` of an input
  array is modeled as the members `rows/*` and not as pairs of a computed
  index and `v/*`, so `for (const [, row] of rows.entries())` followed by
  `row.price` gives an observation at `rows/*/1/price` where `rows/*/price`
  is read; `keys()` likewise needs computed indices (review comment
  4670309323). A wrong footprint narrows the argument wrongly.
- `scheduler-and-serving-loop.md` §10.4, the basis index: for an array of
  references `[D, D, E]` the two occurrences of D are two cone instances
  that share one basis row for the document D. Demanding the first after D
  changed advances that row while the second occurrence's stored output is
  stale, and a restart then takes the stale output as current (comment
  4670309332). This bears on the resume by units as built: check whether
  `PieceUnits` and the basis of a piece have the same gap for a document two
  rows read.
- `footprint-analysis.md` §7, the syntactic exclusions that make a handle
  read conditional: the body of a `do...while` and a bypass through `break`
  or `continue` are not among them, so
  `do { if (skip) break; h.get(); } while (false)` has its read classed as
  static, and the target is demanded and its label joined on the path that
  skips the read (comment 4670309338). That is an over-label and an
  unneeded demand, against §1.4.

**Questions of Contextual Flow Control** are deferred by the ruling Z88 and
listed in the plan as questions 391 to 467 and 512, and per round under
"CFC questions deferred" in `SPEC-NOTES.md`. Several are suspected
under-labels; a construct that has one is not to be relied on for labels.

**The window is to be written as `slice`** (Z92, 2026-11-23; not built).
The owner ruled that the language adds no method regular JavaScript arrays
lack. After the serving branch is merged: the crate recognizes
`xs.slice(-n)` and `xs.slice(0, n)` on a collection and plans the window of
P391 for them (`api::is_window_method`, `window` in `plan.rs`,
`array_method` in `infer.rs`, `collection_call` in `check/mod.rs`); `last`
and `first` are removed, with their entry in `api::is_handle_member`; the
room's copy, the fixtures and the tests `window-construct.test.ts` and
`window.test.ts` are rewritten to `slice`. The window gives what
JavaScript's `slice` gives for every value of the count: the forms
recognized are `xs.slice(-n)` and `xs.slice(0, n)` where `n` is a positive
integer literal, or an expression whose value the executor checks at each
evaluation, taking the window for a positive integer and the result of
`slice` evaluated whole for any other value (`xs.slice(-0)` is the whole
array, and a negative `n` in `xs.slice(0, n)` counts from the end). A
`slice` with any other arguments is evaluated as today. The round reports a FabriChat
send with the window and with the `slice` evaluated whole, and does not
extend the window over the result of a `map` before the general costs of a
send are fixed (the registration of a record at every position, the deep
comparison in the store).

**`sortBy` is to be written as `toSorted`** (Z93, 2026-11-23; not built).
The crate recognizes `xs.toSorted(compare)` on a collection and plans the
sorted collection the trunk built for `sortBy(key)`, which is removed. The
executor keeps order by a key today, so a comparator needs either an
insertion by comparison or the recognition of comparators of the form
"compare one key of each". `groupBy`, `keyBy` and `lookup` are methods of
today's runtime and stay, by the same ruling.

**Per-element forms over the members of a record** (trunk; not built).
`Object.entries(record).map` is built for a record that is an input of the
pattern, over a record of references and over a record of plain values in
place (P70); over a record the instance computed it is evaluated whole.
`Object.keys(x).map`, `Object.values(x).map`, and a `filter` or a `flatMap`
over the entries of a record are evaluated whole. The owner named these on 2026-11-23 as the
recognition to do before `Object.groupBy`, which is in the plan's section
"After the launch". Under `patterns/`, 59 `.tsx` files call one of the
three functions; 25 of those are not named `*.test.tsx`. Counting `.ts`
and `.tsx` files together it is 133.

**Authored `computed` bodies that are not promoted** (all branches).
`language-subset.md` §6.1 promotes a `computed` whose body is
expression-shaped and pure, and a per-element construct inside a promoted
body is planned as one. The bodies of the FabriChat room that read every
message are not promoted because of gaps of the crate, not of the
specification: a guard in the block body of a collection callback, and
`elementById` and `resolveAsCell` in a promoted body. Closing those gaps is
a general fix for the send that grows with the room, and comes before any
construct added for the room.

**The owner's rule on optimizations** (Z91, 2026-11-23). A goal is to be
met because the compiled approach is generally better, not by an
optimization for the measured case that today's runtime has no counterpart
of. An outlier, such as the first edit after a restart or a FabriChat send
that grows with the room, is studied as the sign of a general defect, and
the fix sought is one that helps every pattern. Each brief repeats this, and
each round reports figures with and without an optimization it adds.

## How a round is briefed and checked

A round is one agent in one worktree with a written brief. The briefs of
the rounds so far are kept outside the repository, under the session's
project directory, as `work/r<N>-<subject>-brief.md`; a new brief repeats
these rules:

- Work in the one worktree; never in another, never in the private
  specification repository, never in the main checkout. Do not push.
- Read `AGENTS.md`, `docs/development/DEVELOPMENT.md` and
  `docs/development/code-comment-style.md` first, and
  `docs/development/cfc-spec-correspondence.md` for code that decides a
  label.
- Test first: the failing test, seen failing for the stated reason, then the
  code. One commit per step, each type-checking.
- No timeouts, sleeps, retry loops or polling; no browser.
- With the experimental option off nothing changes.
- A question of Contextual Flow Control is written down and reported, not
  resolved, unless the owner asked for it. A change that could store or
  consume less label is said first in the report.
- A decision the round takes is a provisional decision of the coordinator,
  numbered in a range given in the brief, never worded as an owner ruling.
- Structural, scaling and soundness findings lead the report.
- An optimization the round proposes says whether today's runtime has the
  corresponding mechanism, and its figures are reported with and without
  it. An outlier is studied as the sign of a general defect, and the fix
  sought helps every pattern (Z91).
- No method that regular JavaScript arrays lack is added to the language;
  the crate recognizes the JavaScript form (Z92).
- No work goes into compatibility with older runtimes or with data that
  earlier builds of the compiled path stored (the owner, with Z95).
- When writing about `map`, `filter` or another per-element construct, name
  the case: an array of references, an array of plain values in place, or
  the result of another per-element construct.

Gates of a round, each read by its exit status: `deno task check`,
`deno fmt --check`, `deno lint`, `deno task check-cfc-correspondence`,
`deno task check-skill-facts`, `deno task check-dependency-direction`,
`deno task check-package-cycles`, `deno task check-no-waitfor`,
`deno task check-test-shuffle`,
`deno test -A base/pattern-compiler/compare/test/ base/pattern-compiler/exec/test/`;
from `runtime/runner`,
`ENV=test deno test --shuffle=1 --no-check --preload=test/clock-preload.ts -A test/compiled/`
and the same with `COMPILED_PIECE_STORAGE=socket`; after a change of Rust,
`cargo test --no-fail-fast`, `cargo fmt --check` and
`cargo clippy --all-targets -- -D warnings` in `base/pattern-compiler`.

The coordinator then reruns the tests and one measured figure itself before
pushing, because a round's report is model output and two reports so far
held a wrong explanation (a missing label that was a missing input label;
a figure taken in a posture no deployment runs).

Harnesses, all run from `base/pattern-compiler` with
`deno run -A --no-check`: `compare/topics/scale.ts <arm> <topics>` (arms
`runner`, `serving`, `serving-today`, `today-labeled`; needs the boards of
the measurement branch), `compare/fabrichat/scale.ts <executor|runner|serving> <room|manager|home> [sizes]`,
`compare/serving-path.ts`, `compare/runner-path.ts`,
`compare/sandbox-cost.ts`, `compare/runner-corpus.ts run <file>` then
`report <file>` (with `--serving`, `--resume`, `--references`).
