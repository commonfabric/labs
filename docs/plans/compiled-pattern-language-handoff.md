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
| `claude/compiled-pattern-scoped-rows` | `compiled-pattern-scoped-rows` | Rounds twenty-one to twenty-four, and the four link-following commits of `claude/fabrichat-row-rights-68447f` (P470, P471), and rounds twenty-five to twenty-seven, at `e157bd950b`: a scoped read in the body of a per-element construct stored per row (P454 to P456), the basis list over parts (P457), the room's tree of the space and the rows of a `filter` (P458 to P461), the store step of a result (P462 to P464); cut from the merged branch at `5db1c2658d`; and round twenty-eight at `9b0d83a3d0`: the real Topics board and the modules it imports declared to the compiler's check (Z98, P484), an event a body sends stored as a write (P482), `cellFromUrl` for compiled pieces (P483); and round twenty-nine at `dcaad56391`: a client's scoped writes read by a served handler (P490), the stream-events sidecar per Z99, a first append stored as an array (P489), verbs, schema metadata and receipts of instances a body makes (P486 to P488); and round thirty at `860154a073` (P491 to P494) | none (pushed) |
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
  Round twenty-six (`a184f568a0`, notes 1077 to 1086, P474 to P478) fixed the
  reactions and answered the label question, and did not reproduce the Topics
  create: the rows of a scoped collection below a row of another collection are
  stored in a document per collection and outer element keys, with an instance
  per scope key, and an assembly is set aside with its element table when the
  acting principal changes (P474, P475), so FabriChat's dumps hold no error
  state at any size; Z96 is built (a row's stream marker carries the membership
  label of its row, P477, in a document the piece owns, P476), and `vault`,
  `fair-share` and `group-chat-lobby` commit every event in the corpus, and
  `profile-embed` handles 5 of 5 (see its open item below); Z97 is built (P478),
  and the room's result document is 110 KB where it was 183 KB at 100 messages.
  Both rulings were classified as conforming implementation, with no change of
  the specification (note 1083). The possible under-label does not hold: on
  today's path and the compiled path alike, a body that iterates `items.get()`
  stores the items' clauses once the titles are read (`compare/both-paths.ts`,
  option `labels`). The Topics create's 205 records and refused first create did
  not reproduce at any commit, including those where round twenty-five saw them,
  so the cause is unresolved; the race between sessions' runs of P450 is one
  possible reading, not confirmed by a run. The `message-row` change is the
  module's own authorship check, reached now that `get()` follows one link. A
  send gives 304 records at every size and takes 37 to 38, 118 to 122 and 293 to
  324 ms of the piece's own time at 100, 500 and 1,000 messages, changing 256,
  390 and 600 KB; the seed at 1,000 takes 262 s. Open (note 1085): entries over
  the elements of a `map` over a `computed` output are compared at every pull
  (ruling Z53); a compiled start whose first derivation reads a value under a
  clause is refused where today's path commits (note 1079); the crate gives no
  value function for a `computed` declared in an element body whose result is
  the source of a collection (note 1082).
  Round twenty-seven (`e157bd950b`, notes 1087 to 1094, P479 to P481) made the
  compiled path runnable locally: `EXPERIMENTAL_COMPILED_PATTERNS=true
  ./scripts/start-local-dev.sh --port-offset=300` builds the compiler and
  starts a toolshed whose serving workers compile and serve compiled pieces
  (P481); `cf piece new` against it compiles the program with the local
  binary and creates a compiled piece where the compiler accepts it, or a
  piece on today's path where it refuses, and says which (P479); a list of
  row links is one document by default, so a client reads it as the array it
  is (P480; chunks stay an option). The commands are in the section
  "Compiled patterns" of `docs/development/LOCAL_DEV_SERVERS.md` on the
  branch `claude/compiled-pattern-scoped-rows` (local, not pushed; worktree
  `compiled-pattern-scoped-rows`), not on this branch or any pushed one. On
  2026-11-25 the coordinator used it in the
  desktop app's browser: the counter (`patterns/examples/counter`) renders and
  each click increments it; the todo list (`patterns/examples/todo-list`)
  adds items from its input, ticks a checkbox, edits a title and derives its
  counts and summary; the FabriChat room copy renders, creates a profile and
  sends a message from its send button. Open: removing a todo from its row's
  button does nothing on the compiled path and works on today's path (the
  row sends `removeItem` with its item and `items.remove(item)` removes
  nothing; not diagnosed); the room's author chip reads "Unknown author" (not
  compared, since the room copy uses the window `.last(n)` that today's path
  lacks); a path read through a link from the CLI returns nothing, since a
  compiled piece's result document carries no schema metadata (a CFC
  question, round twenty-seven's question 1); the serving loop does not
  start a piece demanded before its setup committed (the CLI no longer
  demands early; a shell that opens an address early could); the Topics copy
  and the real FabriChat room and Topics board are refused by the compiler's
  check (`subset-type:mismatch`), so they run on today's path; a CLI send to
  the room copy is refused (its write policy expects a gesture from the send
  surface).
  Round twenty-eight (`9b0d83a3d0`, notes 1095 to 1109, P482 to P484): by
  Z98 and the owner's "Fix both here", the real Topics board
  (`patterns/apps/topics/`), `product/collection-naming/` and
  `system/profile-face/` declare the cells they hand to functions as cell
  types, the board's `upgrade` record declares the stored types, and the
  board's whole program passes the compiler's check with no stored schema
  changed; an existing board created from the old source updates to the new
  one (`cf piece setsrc --check`, then `setsrc`). An event a body sends is
  stored as a body's write is, so a row's `removeItem` carries a link and
  `items.remove(item)` removes the item (P482); a compiled piece answers
  `cellFromUrl` (P483). The rewrite patch of the Topics harness is gone; the
  harness copies the board as it is. On 2026-11-25 the coordinator checked in
  the browser: removing a todo from its row now works on the compiled path;
  the real Topics board renders on the compiled path and reads the acting
  profile, but its Start button creates no topic, where the same click on
  today's path does (the handler reads the per-session `newTitle` the input
  writes and returns when it reads blank; not diagnosed). Open from the
  round: a topic is an instance inside the board's piece, so the CLI cannot
  call its verbs or write its cells (no argument link and no schema
  metadata for instances a body makes); a verb's receipt carries no result;
  a topic read through the board comes back whole; an empty outcome cell
  reads `null` where today's path reads `undefined`; no Topics figures were
  taken on the real board.
  Round twenty-nine (`dcaad56391`, notes 1110 to 1118, P485 to P490):
  - The board's Start button: the handler read the per-session draft blank
    because the instance of a scope that a client wrote was never read from
    the replica, and a client's write of a place the piece had read as
    absent was dropped (P490). Both are fixed for every pattern whose handler
    reads a per-session or per-user cell a client wrote.
  - The stream-events sidecar follows Z99 as a host arrangement: a stream's
    entries document is measured for writer fit under no join, and only an
    entry's `payload`, `error` and `reason` keep the transaction's join
    (commit `854faa3f7f`, meant for `main` as well). The consumer of an
    event still takes no label from the payload. With the residency refusal
    gone, that under-taint now reaches across spaces too: a served handler
    that read another space's labeled value can send it, and the consuming
    handler writes it unlabeled. The same commit changes
    `docs/specs/cfc-conformance-statement.md` and
    `docs/specs/cfc-enforcement-matrix.md` §4 to say so, on the round's
    branch only: this branch's copies are unchanged, and its §4 still
    describes the residency refusal. Whether the consumer should take the
    payload's label is open, a CFC question the round deferred.
  - The first append onto a list the storage did not hold stored a record
    `{0: …, length: 1}`, which emptied a resumed room's window (P489).
    Rooms created before the fix keep the record.
  - An instance a body makes has an `argument` link and `schema` metadata,
    so `cf piece call` and a path through the board reach its verbs (P486,
    P487).
  - A handler's return value is in its receipt (P488).

  On 2026-11-25 the coordinator checked the board in the browser after
  restarting the 8300 servers on `dcaad56391`. Clicking Start now creates
  the topic and clears the box. Enter does nothing on either path, because
  the board binds no submit to its input. A topic does not open: its card's
  Open link and its address both show "Content hidden by policy" to the
  identity that created it, because the topic's result document carries a
  `User` label of another principal, the CLI identity that holds a session
  on the board. The label is written in the commit that handles the
  creating click. The topic reads `wish("#profile")`, a value of each
  viewer. Not diagnosed.

  Open from the round:
  - A topic's `mentions` stores copies of the mentioned topics rather than
    links, so the board's crossrefs never match. A body that returns a value
    it read through a link stores the copy, against ES §2.4. This is
    reproduced on the executor, not fixed.
  - `cf cell set <topic> title` is refused, because a made instance's
    argument lacks the defaults its type declares.
  - The empty `cellFromUrl` outcome still reads differently from today's
    path.
  - The root piece's result has no `schema` metadata.
  - Every session the serving loop holds derives every topic. Each create
    writes about 132 + 5.4n documents and 165 KB + 39 KB·n, where n is the
    number of topics held, and each new session writes O(topics) documents
    once. Derivation by demand is the fix.
  - No Topics figures were taken.
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
rounds twenty-five and twenty-six, P479 to P481 round twenty-seven, P482 to
P484 round twenty-eight, P485 to P490 round twenty-nine (the next is P491). Note
numbers in `SPEC-NOTES.md` likewise: 692 to 704, 860 to 875 and 960 to 975
trunk, 940 to 944 carry, 742 to 752 and 880 to 892 sandbox, 760 to 772
and 900 to 914 write integrity, 851 to 866 and 920 to 932 serving, 980 to
1118 the merges and the rounds after them (1016 to 1118 on
`claude/compiled-pattern-scoped-rows`, 1060 to 1066 the link-following
work; the next is 1119). The plan documents hold decisions up to
P210 and P410 to P411; the rounds after that are in `SPEC-NOTES.md` of their
branches only and need a document round after the merges.

## The independent review of rounds twenty-five to twenty-nine, and the change of method

On 2026-11-25 the owner asked for a review of the recent rounds and then
set a new order of work. Five reviewers that had not written the rounds
each read one round at `dcaad56391`. What has to hold before the option is
turned on for users is in
[compiled-pattern-language-ship-criteria.md](compiled-pattern-language-ship-criteria.md),
a draft for the owner to edit. The order: the comparison of both paths with
two principals as a standing gate (round thirty-one, branch
`claude/compiled-pattern-two-principal-gate`, cut from `dcaad56391`), then
derivation by demand, then the record. Round thirty (the topic hidden from
its creator, and a returned value stored as a link) runs on the build
branch. A round's result counts once a reviewer that did not write it has
read it.

Findings, the coordinator's confirmation said for each. None is fixed.

- *Soundness, confirmed by reading:* the serving worker's compile cache
  (`compiles` and `compiledFor` in `runtime/runner/src/compiled/serving.ts`)
  is keyed by the source document's id and shared between spaces, and the
  text read is not checked against the id (`patternSourceDocumentOf` is
  used in `setup.ts` only). A writer of one space can store other text at
  the id of a program and have its compile served to another space's piece.
  Older than round twenty-seven, which made it reachable on a toolshed.
- *Soundness, the test change confirmed by reading:* the sidecar commit
  `854faa3f7f` is not fit for a pull request against `main`. It keeps the
  transaction's join on an entry's `payload`, `error` and `reason` only and
  skips writer fit for the whole entries document, so a labeled value
  written to any other position of that document is stored unmeasured and
  unstamped (the reviewer's scratch test; whether pattern code can address
  the document is not shown). Three cases of `cfc-processed-claim.test.ts`
  that asserted a refusal now assert none, the forged-claim case is
  deleted, and the overwrite case writes `false` where it wrote a secret.
  The round classified it as a host arrangement;
  `docs/development/cfc-spec-correspondence.md` records the narrower
  own-space skip as a semantic gap pending a specs pull request. The
  reviewer's narrower form: skip writer fit for the declared tail append
  and the processed claim only, and keep the stamps.
- *Soundness, not confirmed:* P476 enrolls every stream marker document as
  a store the piece owns, while `#recordsOfMarkers` gives a record only to
  a marker with element keys; every other marker takes the transaction's
  whole join, now admitted where it was refused. The reviewer reads
  `profile-embed` going to 5 of 5 as this admission. P474 stores, at the
  link a row of the space holds to its scoped rows, a label resolved with
  the inputs of one scope key's run. Both are possible causes of a foreign
  `User` clause in a document of the space, and were given to round thirty
  to check.
- *A difference from today's path, confirmed for the fixture:* by P471 a
  handler's write through a link replaces the link where today's path
  writes the linked record, and the `replace` event of the fixture
  `set-over-link` in `compare/values-fixtures.ts` is no longer sent. This
  needs the owner's ratification as a difference of the language.
- *Suspected, not run:* by P470 a redirect to an argument position is
  stored at depth 0 or 1 of the result only, so a client's write through a
  deeper result path would be lost at the next derivation; `Store.write`
  creates a document for any absent target.
- *The gates, confirmed by reading:* `SCALE_GROWTH` in
  `compare/fabrichat/scale.ts` compares nine counts, leaves out reads,
  registrations, bytes, writes, documents and time, never compares the
  error states it prints, and exits 0 with fewer than two sizes. No test
  stores labels under clauses that differ between two principals.
- *Scaling:* P474 writes a document per outer row and principal; with one
  list document by default (P480) the Topics figures above at 2,000 topics,
  taken with chunks, no longer describe the default.
- *The CLI:* `checkCompiledProgram` in `runtime/cli/lib/piece.ts` treats
  every compile failure but a missing binary as a refusal of the program.
- *Round twenty-eight has no blocking finding.* The 10 failing board tests
  pass with server execution off, as continuous integration runs them; with
  it on they fail by the defect #10204 fixes, which the branch lacks. The
  upgrade handles of `topic.tsx` now declare stored authors as complete, so
  the type checker sees the guards for partial legacy data as unneeded.

## Rounds thirty and thirty-one, and what their reviews found

The build branch `claude/compiled-pattern-scoped-rows` is pushed at
`a04632cb2c` (round thirty and the merged comparison), with no pull
request. The comparison was built on
`claude/compiled-pattern-two-principal-gate` (worktree
`compiled-pattern-two-principal-gate`, local, cut from `dcaad56391`) and
is merged into the build branch. An investigation of today's path is on
`claude/served-two-principal-clause-crossing` (worktree of the same name,
local, cut from `main` at `f51440a49c`). Next numbers: notes from 1173,
provisional decisions from P535 (P495 to P519 are unused).

**Round thirty** (`860154a073`, notes 1119 to 1124, P491 to P494). The
coordinator reran the gates (239 in compare and exec, 71 of 71 in
`test/compiled/` on both storages, 71 in the CFC tests,
`check-cfc-correspondence` and `deno task check` at 0) and walked the real
board on the 8300 servers with two CLI identities, one that holds a session
and one that creates; no browser was at hand. Three topics are created, the
mentions commit, the board's `crossrefs` list both sources for topic 1, and
no topic's result document is among the documents of the space that gained
a `User` clause; 34 internal documents did (basis parts, the minted
document, and 20 not identified), each with the clause of the identity that
only held a session. Error states: 0.

- The round found three ways one session's run put its principal's clause
  into shared documents and closed each: a position of a space document
  that holds a link to a scoped place takes a record with no label (P491);
  a made instance's result is an empty record from the handler's
  transaction, so its root no longer takes the first derivation's join
  (P492); the basis affirms unconfirmed documents with a read that adds no
  flow label (P493). All three store less label. A body that returns
  unchanged an element reached through a link stores the link (P494).
- The round found no value of another principal in a document the creator
  reads, on a copy of the 8300 store. Nothing the creator's click wrote
  carried a `User` clause, so an over-labeled event input does not explain
  the hidden topic; today's path was not traced for the same click.
- The reviewer's findings. The cause stands: a run for one session derives
  the space's part and the session's part in one transaction, so every
  write under no record takes that session's clauses; the round removed
  three written positions from that. P493 has no test (`hidden-made.test.ts`
  passes without it). That test walks the executor's own documents only, so
  it cannot see the internal documents, and it never asserts what the
  second principal reads. P491 as coded also strips the label of a link a
  body chose from data by a labeled value (suspected, not run); it should
  apply to the output's own scoped place only. P494 runs `store.locate`
  once per element for every body with a `*` entry and no handle; no figure
  was taken. The reviewer agrees with the classifications of P492 and P493
  and with P491 once narrowed.
- Open, a wrong value: `items.map((item) => ({ ...item, done: true }))`
  over an array of references stores `[{done: true}, …]` on the executor;
  every other member is lost. Older than the round; the crate's footprint
  reads a spread as the identity of its argument (`footprint.rs`,
  `SpreadProperty`).
- Open: a second principal is not served a made instance's scoped place;
  piped event input to `cf piece call` arrives `undefined` on the compiled
  path; FabriChat with two members was not run.

**Round thirty-one** (`c48a43267a`, notes 1150 to 1155, P520 to P527)
extends `compare/both-paths.ts` to run each scenario on both paths under a
serving loop with two principals under differing clauses: 32 hand-written
runs, 9 named scenarios, 378 corpus modules. At `dcaad56391`, 276 ran, none
was equal and 143 were skipped. Its reviewer's reading of what can be
relied on:

- Reliable: the compiled path commits writes today's path refuses (23
  findings in 17 scenarios; reproduced by the reviewer on
  `cfc-trusted-write/main`), because a piece set up through
  `setUpCompiledPiece`, the route `cf piece new` takes, stores no write
  policy at its argument; the earlier "12 of 14 equal" was taken on a route
  no deployment uses. Error states in 4 modules on the compiled path. The
  existence of foreign and crossed clauses on the compiled path, the Topics
  board among them.
- Not reliable: every count that involves a scoped value, and the value
  differences. Today's path is not a stable reference there: in one run of
  four of the scenario "instance a handler makes" it stored both
  principals' `User` clauses in each principal's instance and refused both
  the cards, a difference in what is stored after quiescence. The
  investigation on `claude/served-two-principal-clause-crossing` is about
  that. The harness also reads before the demand its reads cause has
  settled, compares clauses as debug strings, pools the documents no walk
  reaches, searches for known strings as its check of one principal's value
  reaching another, and exits 0 when no scenario matched.
- For the owner to rule on: 13,843 `TransformedBy` flow atoms of the kind
  `compiled` at positions where today's path stores no flow atom, and 500
  atoms of today's path with no compiled counterpart. They are integrity
  atoms and their placement differs, not only their identity.
- 35 corpus modules that `emit --corpus` accepts are refused by the serving
  compiler, which compiles the whole program; the corpus acceptance figures
  taken per module overstate what a server runs.

**Round thirty-two and the merge.** Round thirty-two (`73705b041e`, notes
1160 to 1172, P530 to P534) repaired the comparison: a rule for positions of
a scope that each path is held to by itself, reads repeated until a pass
writes nothing, clauses compared by value hash, flow atoms as a kind of
their own, a run of no scenario failing. The gate branch is merged into the
build branch at `a04632cb2c` (pushed; 244 tests of `compare/test` and
`exec/test` pass). The command, from the repository root:
`deno run -A --no-check base/pattern-compiler/compare/both-paths.ts <results.jsonl> [--sets=hand,named,corpus] [--only=a,b]`.
Two full runs gave the same counts for `commit` (23 in 17 scenarios),
`policy` (63 in 25), `message` (11 in 8), `error-state` (4 modules),
`read-failed` (2) and, but for Topics, `flow` (about 14,200: 13,765
positions where only the compiled path stores a flow atom, about 433 where
only today's does, 63 where both do). Every kind that depends on which
principal's clause is stored where varies between runs, in about a dozen
scenarios, on both paths. Its reviewer's limits: in 9 corpus scenarios
today's path refuses the start, which supplies a protected field, and the
later findings of those scenarios compare against nothing (about 17 of the
24 `policy` findings whose today's side is empty); the scope rule is the
ship criteria's and flags a clause that arrives by a conforming flow, so
`today-foreign-clause` is no list of defects of `main`; the exemption for a
declared `User` clause covers the wrong principal too; the loop that waits
for the store can end early; the exit status is not yet a gate. On the
merged head one run of the named scenarios gives, for the Topics board on
the compiled path, 172 foreign and 111 crossed clauses where the run before
round thirty gave 724 and 192: fewer, not none, and both are among the
kinds that vary.

**Today's path crosses clauses between principals** (branch
`claude/served-two-principal-clause-crossing`, `91993233fa`, local; the
test `runtime/runner/test/executor-two-principal-profile-clauses.test.ts`
fails on `main` on purpose, 20 of 20 runs, and the coordinator reran it). A
node with an instance per user reads, per principal, that principal's home
root and profile, documents of the scope `space`. A change or first load of
one arrives as a cause with no scope key; `dirtyFanOutForCause`
(`scheduler/fan-out.ts`) dirties every instance, `causesForInstance`
(`scheduler/run.ts`) hands each run the cause, and the trigger reads of
`deriveFlowJoin` join the other principal's `User` clause. Clauses cross,
values did not. `docs/specs/server-side-execution/serving-loop.md` states
the fan-out and two scheduler tests assert it. A fix that dirties, and
hands the cause to, only the instances whose last log read the document
makes the test pass and consumes less label; it waits for the owner. The
reviewer of round thirty-two reads the Topics crossing on today's path as
partly a second mechanism: the handler that files a topic reads the
creator's labeled profile and writes shared documents under that label,
which is the class Z100 is about.

## Rounds thirty-three to thirty-eight, the fixes on `main`, and the derivation design

State on 2026-11-26. Rounds now run on Fable agents; each is reviewed by an
agent that did not write it, and the coordinator reruns the gates. Every
review so far found defects the round's own tests did not, so a round's
report is not evidence until its review is in. Briefs, logs and the
reviewers' probes are under the session's `work/` directory
(`r33-fixes`, `r34-derivation-measure`, `r35-setup`, `r36-body-reads`,
`r38-argument-read`, `review-r35`, `main-fanout-fix`). Provisional decisions
in use: P535 to P539 (P535 and P536 withdrawn), P550 to P557, P560, P561,
P580 to P583, P620 to P622; later rounds were given notes from 1240, 1280,
1300 and decisions from P600, P640, P660.

### Branches added

| Branch | Worktree | State |
| --- | --- | --- |
| `claude/compiled-pattern-scoped-rows` (build) | `compiled-pattern-scoped-rows` | `7eb87d6743` pushed (round 33); round 35 at `ac296044df` and its continuation local |
| `claude/compiled-pattern-derivation-split` | `compiled-pattern-derivation-split` | off `a04632cb2c`; round 34's instruments at `6743be8f25`, then the design's round 2; local |
| `claude/compiled-pattern-body-reads` | `compiled-pattern-body-reads` | off `7eb87d6743`; round 36 at `0ba7879878`, round 38 on top; local |
| `claude/served-two-principal-clause-crossing` | same name | pull request #10262 against `main`, head `e3f8b4c1b9` |
| `claude/own-write-link-stale` | `own-write-link-stale` | off `main`; local until reviewed |

The three compiled branches have to be merged into the build branch; they
touch `transactions.ts`, `executor.ts` and `both-paths-serving.ts` in
different regions. One more local branch off `main` holds work the owner
decides how to publish; the coordinator's session notes name it.

### Defects of `main` found by this work

- **A space-scoped cause reached every per-user instance** and joined one
  principal's `User` clause into another's. Fixed in #10262 after three
  review passes; the reviewer's verdict is ready to merge. Open by decision:
  a debounce timing residual (the question for the specification is written
  in `work/main-fanout-fix/specs-question-debounce.md`, not filed), matching
  by document and not by path, and a viewer's arrival restarting every
  given-up instance.
- A cause arriving mid-pass was never carried as a trigger read; fixed in
  #10262.
- **A client that stored a document by a raw transaction write and reads it
  through a link from a schemaless cell stays stale.** Fix in progress.
- The review of round 35 produced further findings about `main` that are
  held with the owner and not recorded here.

### The compiled path

- **Setup (rounds 33, 35).** A client no longer writes the argument; it
  writes a request and the server creates the argument with value, schema,
  seeds and attempted-write marks in one transaction (P560). The review
  found defects in it (the first-start decision, the resume check after a
  source change, the request's values stored under no label, a corrected
  request never started, a wait on every sync of the runtime, two
  implementations of making the argument, and the serving identity stored
  as the acting user where §8.15.4 names the authenticated acting
  principal). The continuation is repairing these.
- **What a body reads (rounds 33, 36, 38).** Three passes fixed forms and
  left adjacent ones wrong. At `0ba7879878` a checked-in matrix
  (`compare/test/body-reads-matrix.test.ts`, 95 fixtures against today's
  path) lists 22 differing; the absent-input guard differs from today's rule
  in 13 of 28 arguments; over plain values held in place any write in a row
  re-runs every body over the array (38.8 ms at 8,000 rows). Round 38 builds
  one read of a body's argument under the declared type in place of the
  per-form rules.
- **"Invalid cell link" on the Topics board** was the comparison's own
  reader on a cyclic value, not a stored link.
- **Error states.** Two corpus modules throw on both paths; today's path
  stores nothing and the compiled path stores `{ $error }` by design. For
  the owner.

### The derivation design and its measurement

`docs/plans/compiled-pattern-derivation-by-demand.md` is the design, revised
after round 34 measured it; nothing in it is a ruling, and its recommended
answers are the working assumption. Round 34's numbers, on the corpus and
the real Topics board with two principals:

- A create evaluates the shared part once (31 evaluations) and writes 74 to
  88 shared documents at every session count and from 0 to 40 topics.
  Transactions per create are 4, 18, 31, 114 at 1, 3, 5, 9 sessions held,
  with 0, 4, 10, 35 failed commits.
- 182 of 187 `foreign-clause` findings sit where a keyed derivation wrote
  into a document of the space; the other five of the 187 are a handler
  writing event input into a per-user cell (Z100's case). Of the 604 keyed
  writes that no plan record covers, 544 are bookkeeping.
- 156 of 228 `crossed-clause` findings are in documents no compiled
  transaction wrote; the traced ones are the `wish` action
  (`compiled/wish.ts`), a fanned-out action of today's path, so they wait on
  #10262 reaching the build branch.
- The plan gives no scope to 106 of 257 cone instances found scoped; two
  static rules would cover 100.
- A renderer-like session watches 6 scope instances at every size; a
  session with a sink on the board's whole result watches 22 per topic.
- Not explained: with one session a create takes 4.3 s at 10 topics and 29 s
  at 40 and writes 130 kB at 0 topics against 871 kB at 40, with the
  document count flat. Times include the harness's clients.
- With one session held, the third headless `addTopic` and every later one
  is refused (writer-fit misfit on the receipt under the actor's `User`
  clause); being diagnosed on the derivation branch.

The design's next round (its round 2) is the refusal of scoped reads under
the load alone; it must take 199 writes of the serving runtime's own scope
instances to 0 with no value the comparison reads changed.

### Waiting on the owner

- Merge of #10262, and filing the debounce question with the specification.
- How the held findings about `main` are published.
- The design's nine questions (its section 5), first the reach of Z100 for a
  handler and whether an instance whose existence depends on a scoped value
  is refused.
- Whether an error state is stored where today's path stores nothing.
- Today's path's own inconsistency between a spread and `JSON.stringify` of
  the same record (the compiled path implements the declared type).

## The reviews of rounds thirty-five to thirty-nine, and the merge

State on 2026-11-27. Each line below was reviewed by an agent that did not
write it, sent back to its author with the review, and gate-checked by the
coordinator at the head named. Reports are under the session's `work/`
directory: `r38-argument-read/report-3.md` with `review-r38-2/report.md`,
`r35-no-scope-key/report-3.md` with `review-r35-2/report.md`,
`r39-setup-findings/report.md` with `review-r39/report.md`, and
`rounds-merge/report.md` for the merge.

### Branches

| Branch | Head | State |
| --- | --- | --- |
| `claude/compiled-pattern-scoped-rows` (build) | `c12d442929` | local past `7eb87d6743`; round 39 (setup) on top |
| `claude/compiled-pattern-body-reads` | `d8a20351b9` | round 38 after three passes; local |
| `claude/compiled-pattern-derivation-split` | `a9db79ae27` | the design's round 2 after three passes; local |
| `claude/compiled-pattern-rounds-38-39-merge` | `640de36de0` | the build head with the two branches above merged; local. The full gates passed one commit earlier, at `3d0fa913a1` |
| `claude/own-write-link-stale` | `e7b3789ae4` | pull request #10283 against `main`; five review comments answered |

Before any compiled branch is pushed, its diff is read for material the
owner has not released; the coordinator's session notes say what that is.

### The stale read on `main`

#10283 makes a read through a link load a document the runtime's own commit
stored and no watch reaches. Not fixed by it: a load that resolves carrying
an error keeps its reservation, so that document is not loaded again.

### Setup (round 39)

The review of round 39 found the class its fixes address still open, and
one regression: after the serving loop restarts, a piece with a per-user
cell that its creator can read does not resume. The findings and the
choices for closing the class are with the owner; nothing more is built on
this line until the owner answers.

### What a body reads (round 38)

- The decisions of the read (union branch, defaults, required keys) are
  today's functions, called through
  `runtime/runner/src/compiled/argument-rules.ts`. The walk in
  `exec/argument-view.ts` is still a second implementation of today's.
- `argument-probes`: 63 outputs listed as differing, by cause: the element
  code of a construct 27, the members a body reads 17, recursive types 9,
  today's path against itself 4, note 1304 4, a primitive at an `unknown`
  position 2. `body-reads-matrix`: 82 of 95 agree. `argument-guards`: all
  60 agree.
- **The element code of `map`, `filter` and `reduce` inside a `computed`
  reads raw slots**, with none of the rules a function body's read applies.
  Over an array of plain values held in place, one of the listed outputs
  differs on a valid argument. Routing those reads through the view needs
  the view to record a read through a reference by key as a keyed read
  first; without that, a move of elements re-evaluates them
  (`r38-argument-read/cont3/executor.element-view-attempt.ts` is the attempt
  that was set aside). The same gap exists for a `lift` handed the result
  of a `filter`, and no test holds it.
- **Two label differences older than the round are open and block
  shipping**, held by ignored tests in
  `compare/test/open-label-gaps.test.ts`: plain argument rows whose members
  the type declares `Confidential` give an output stored with no clause
  where today's path stores the rows' clauses; and rows of another piece
  carry a sibling's clause and none of their own.
- A union-of-records member costs 6 to 8 microseconds a row to read (243 ms
  a write at 32,000 rows), linear.
- On today's path a body that runs before the store's frame arrives reads a
  record in the writer's key order; `member-copies.test.ts` compares three
  outputs without member order for that reason (P685).
- Which members a body reads is derived by the crate (P664) and differs from
  today's compiler, whose rule depends on the form of the code. For the
  owner: keep the crate's rule with the differences listed, or reproduce
  today's.

### The derivation design's round 2

- A run with no scope key writes no scope instance: `unkeyed-into-scope` is
  0 (199 before), with the same 278 scenarios running.
- **Keyed runs now write derived values of the space**: 263 writes at 247
  positions in 17 scenarios (the Topics board 132). Which principal's run
  writes is not the same between two runs of one commit. Where that run
  read `User`-labeled data the clause is stored on the shared document, and
  the other principal reads the position as hidden (`board.crossrefs`,
  `crossrefIndex`, `namesTable`). `keyed-into-space` is 1,884 with every
  part counted. This is what the design's round 4 removes, with the
  addition that a scoped run names the shared entry it needs and does not
  evaluate it.
- A built-in is registered with a stated decision on whether its answer
  depends on the acting principal (P615). `spaceMembers` was registered as
  independent, which let one principal read another's answer; it and an
  argument that names a document of a scope now make the evaluation scoped.
- A result that reads a per-user value directly is an error state at the
  place of the reading result (P611, P616); a pattern compiled into another
  keeps its other members. `examples/suggestable/event-list.tsx` and
  `people-list.tsx` return such a pattern as their whole result and are in
  that state. For the owner: this, or a result built member by member.
- The change to when the `wish` action is registered (P612) has no test
  that fails without it and no measured effect.

### The merge

`claude/compiled-pattern-rounds-38-39-merge` is the build head with rounds
38 and 2 merged, by `git merge`. The author's gates and the coordinator's
both exit 0 at `3d0fa913a1`; `640de36de0` adds a change to `SPEC-NOTES.md`
alone, the renumbering below, checked by the format check, lint, `deno task
check`, the compare and exec tests, and a search for a note number used
twice (none); the other gates were not run again on it. The build branch itself is not moved; it takes
this branch by a fast-forward once the owner agrees to round 2 landing
before round 4.

- The merged tree showed a defect of round 38, fixed on the merge branch: a
  required capture holding `null` was read as absent where its type names
  `null` (`apps/recommend-a-book` has that shape).
- The setup line and the derivation line both used note numbers 1200 to
  1208 and 1260 to 1267. On the merged branch the derivation line's notes
  1200 to 1211 are 1340 to 1351 and its notes 1260 to 1267 are 1352 to
  1359; the setup line's keep their numbers. The next free note number is
  1360.
- Not refused by either round's rule, and not held by a test: a transaction
  under the serving identity, not stamped as a derivation for no key, that
  creates a scope instance whose schema does not bind readers to the
  creator. The comparison counts none.
- One full comparison: 447 scenarios, of which 283 differ, 12 have the
  outcome that no piece started on either path, and 152 are skipped;
  `unkeyed-into-scope` 0, `keyed-into-space` 1,893, `error-state` 4, `value`
  611, `foreign-clause` 213, `crossed-clause` 305. No kind is above every
  branch alone.
- #10262 is not on the merged branch; it comes in after it lands on `main`.

### Waiting on the owner, added

- Whether the build branch takes round 2 before round 4 is built.
- The members a body reads, and the result that reads a per-user value, as
  above.
- How the setup class is closed.

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
