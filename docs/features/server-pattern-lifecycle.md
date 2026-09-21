# Pattern lifecycle verbs on the serving runtime

Under server execution, the three verbs that give a space a pattern — upload a
program, instantiate a piece from it, and replace a piece's source — run on the
space's serving runtime. The client's part is to resolve the program from disk
and request; the serving side compiles, materializes or replaces, and commits.
This document is the contract for that: the route a client calls, the authority
it needs, where the verb runs, what comes back, and what still happens on the
client.

A source update carries module-update authority, which
[`module-loading.md`](../specs/module-loading.md) requires to be published from
an owned setup transaction that commits to storage itself. A serving wave's
acceptance is withdrawable until the wave commits, so the served `setsrc` verb
does not seal its setup transaction into the wave: the transaction commits
directly to the store, as one of the serving loop's own commits made outside the
wave ([Direct commits](#direct-commits) below), and the update's authority
registers from that verdict. `cf piece setsrc` requests the verb;
`cf piece
setsrc --check` stays in the client's process, since it issues no
storage writes. Its normal storage reads can still demand materialization by the
serving runtime, and a check does not freeze the space
([`module-loading.md`](../specs/module-loading.md)).

The verbs run only when `EXPERIMENTAL_SERVER_EXECUTION` selects the ON arm
([`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md#serverexecution)).
Off the flag a deployment has no serving loop, the route answers 503, and `cf`
performs each verb in its own process as it always has. `cf test` runs a whole
stack in memory and is untouched either way.

## The route

Three POST endpoints under `/api/pattern-lifecycle`, mounted by
`packages/toolshed/routes/pattern-lifecycle/`. Every body carries `space`, the
DID of the space acted in. A verb that takes a pattern takes it one of two ways,
and exactly one: `program` — the program as the client resolved it, every file
by name, with `main`, an optional `mainExport`, optional `sourceRoots`, and
optional `dataFiles` — or `pattern`, a `{ identity, symbol }` pointer to a
closure the space already holds. A body naming both or neither fails validation.

| verb          | body                                                                                                                     | receipt                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `upload`      | `program`                                                                                                                | `{ pattern }` — the pointer the space now holds the program under                                                                                |
| `instantiate` | `program` or `pattern`; optional `argument`, `repository`, `slug`, `force`, `register`, `start`, `requestKey`            | `{ pieceId, pattern, slug?, requestKey, registration: { status, error?, attempt?, terminal? } }`                                                 |
| `setsrc`      | `piece`; `program` or `pattern`; optional `repository`, `dangerouslyAllowIncompatibleSchema`, `expectedPattern`, `start` | `{ pieceId, pattern, revisionId, seq, detachedOrigin }` — the accepted setup transaction's receipt, `seq` its position in the space's commit log |

Once creation commits, a preparation or completion refusal returns the created
receipt with failed registration and its retained request key. It makes no new
authorized-write or terminal-delivery claim; the caller retries that same key
after authority recovers.

A refusal is a JSON body `{ error, code }`. `code` is stable and is what a
client branches on; `error` is prose for a person.

| status | code                                             | meaning                                                                                                                                                       |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `unauthorized`                                   | no valid first-party request proof                                                                                                                            |
| 403    | `forbidden`                                      | the caller is not a writer of the space, or there is no such space                                                                                            |
| 404    | `pattern-not-found`, `piece-not-found`           | the named pattern, or the named piece, is not in the space                                                                                                    |
| 409    | `slug-taken`, `source-moved`                     | the slug names something and `force` was not set; the piece is not on the pattern the update was proved against                                               |
| 413    | `payload-too-large`                              | the body exceeds the limit, checked before authentication                                                                                                     |
| 422    | `compile-failed`, `setup-failed`, `incompatible` | the program did not compile; setup refused the pattern or the argument; the candidate cannot run over the piece's retained state and the override was not set |
| 429    | `rate-limited`                                   | the caller's request budget is spent, checked before authentication                                                                                           |
| 500    | `internal`                                       | the serving side failed for a reason it does not name                                                                                                         |
| 503    | `server-execution-off`, `space-not-served`       | no serving loop on this deployment; the space's lease is held elsewhere                                                                                       |

Body validation runs after authentication and answers 422 with the validator's
own body — a body naming both `program` and `pattern`, or neither, fails there —
so a client that sends what the schema describes never sees it.

## Authority

Every call carries the CF1 first-party request proof
([`toolshed-access-control.md`](../specs/toolshed-access-control.md)), signed
with the caller's own identity key; `cf` signs with the identity it connects as.
The route then requires that DID to hold WRITE or OWNER on the space's ACL,
resolved the way the memory server resolves an authored commit — the wildcard
grant and the service principals count — so a caller the memory server would
admit writing directly is admitted here, and no other. A deployment with ACL
enforcement off admits every authenticated caller, as its memory server does.
One denial covers a malformed DID, a space the deployment does not host, an
absent ACL, and a caller without a grant, so the route is not an existence
oracle over the deployment's spaces.

The hosted authority check reads the ACL through the memory server's internal
document reader. It grants no graph READ or WRITE to the process identity: a
private space can admit its owner and writers without adding the toolshed
operator to its ACL. Every call reads current access; a removed writer cannot
reuse a cached authorization decision.

The verb's own writes are the serving loop's, under the space's lease. The
instantiation transaction carries the requester's CFC trust snapshot, so a label
setup mints attributes to the requester rather than to the serving identity.

## Where a verb runs

`ExecutorHost.runLifecycleVerb` hands a verb to the space's `SpaceServer`,
activating the space if it is parked. A verb request is an activation trigger of
its own: the requester holds no session on the space, so the criteria the
session-open and admission hooks consult do not apply. The `SpaceServer` queues
the verb and runs it as a step of its next wave cycle, after the root ensure and
ahead of the event drain, awaited in full, so every transaction the verb seals
joins that cycle's wave. The request settles once the wave has committed and the
verb's `confirm` step — a read of the durable state the verb was to leave — has
passed. A seal's acceptance is not durability, since the wave commit can
withdraw a contribution, and this is what keeps a receipt from naming a piece
that is not there. A space that parks before a queued verb runs rejects it, and
the host queues the verb once more on the successor tenure.

A verb that stages a piece names the piece's root as its demand
(`LifecycleVerb.demandRoots`), and the loop takes every document the verb's
transactions wrote — the root, its argument, and the documents its computed
values live in — as warm demand for the tenure: the identity-less root key the
explicit warm request uses, which is what gets a piece derived that no session
demands. The verb's commit is the loop's own and never its input, so once the
wave has committed the loop re-announces those documents to itself as a
warm-marked notice, the carrier provisioning uses for the setup it stages in
another space; the next cycle takes it as input, its demand pass loads the piece
from the now-committed store, and the piece's first runs seal into that cycle's
wave.

The receipt does not wait for that derivation. It returns once the verb's own
wave has committed and `confirm` has read the piece back, which is the point at
which the piece is durable and can be resumed; the loop owes its first run and
serves it in the cycle after. A reader that needs the derived value pulls it,
which is demand the loop serves, rather than expecting a creation to have run
the graph.

Served creation commits setup, the optional slug, and a caller-scoped creation
receipt together. A taken slug refuses creation unless `force` is set. A stable
`requestKey` identifies this act: retrying it returns the same piece.
Confirmation checks the retained creation record against the acting caller,
deterministic piece identity, original pattern, and slug. A legitimate later
source update can change the piece's current pattern while registration remains
retryable.

With `register: true`, the route prepares the default pattern's `addPiece`
delivery and retains its attempt in a serving wave. It then invokes the stream
through trusted ingress, retaining the authenticated caller's identity. The
caller must also have WRITE access to the stream's target space before any
trusted observation or delivery, including when a root exports a foreign
handler. An observer outside the serving wave watches the prepared stream's
durable event sidecar, including a read after subscription to recover already
completed replays. A separate serving wave reads the computed registry and
records `registration.status: "handled"`; its receipt is checked after the wave
commits. The process needs delegation authority, without a READ or WRITE grant
in the space: private reads and receipt writes use the serving runtime, and the
out-of-wave observer reads only the prepared event's sidecar through the trusted
memory service. Waiting outside the wave lets the event's consequences commit.
This permits a default pattern to derive its registry from panels; the route
never writes that export. The event and receipt make a lost response retryable
without another panel. `register: false` returns `skipped`. If registration
fails after setup, including a missing root or `addPiece` handler, the
successful instantiate response retains the created `pieceId`, `requestKey`, and
a `failed` status with its error. Retrying that key does not create another
piece. The receipt retains a registration attempt number. A proven terminal
stream failure, or a successful durable event whose readable registry omits the
piece, advances that number atomically on retry, allowing a repaired handler to
run again for the same piece. Concurrent retries select the same pending
attempt. An unknown transport outcome or failed registry read keeps its delivery
identity. A late uncertain result cannot erase a proven terminal result for the
same attempt, and a handled receipt cannot be downgraded.

Client-side registration also treats the registry as a read interface. It starts
the default pattern, demands its registry while invoking `addPiece`, and waits
for the handler commit, registry readback, and storage persistence. The readback
checks each complete target address. A handler that commits without registering
its target refuses completion. Starting the new member is a separate choice;
`--no-start` still completes registration. With server execution disabled, a
cold read activates a computed registry's producer. Server-executed registries
retain passive reads. Local stored writable registries are passive when computed
IDs distinguish derived exports; disabling computed IDs makes local readers
conservatively activate the root.

That seat rules out two things the client-side operations do. A transaction the
runtime seals into a wave cannot mint a durability receipt of its own, so the
runtime refuses `runSyncedWithCommit` while a seal destination is installed
unless the caller asks for a direct commit; and the storage manager's full
`synced()` waits on the wave commit the verb is inside of and would deadlock.
The served operations in `packages/piece/src/ops/served-lifecycle.ts` therefore
compose the lower runner calls — `compileAndSavePattern`, and `setup` with a
transaction the verb stamps — and mint their receipts from what they wrote; the
source update is the exception, below.

### Direct commits

A transaction the serving runtime stamps `directCommit` (a `bookkeeping` run's,
`ServerRunInfo` in `packages/runner/src/runtime.ts`) does not seal into the
wave. The `SpaceServer` commits it to the store on its own, as a derived-class
commit under the space's lease, serialized with the wave's seals; the
transaction's `commit()` then resolves with the store's verdict, and the receipt
and authority the runner mints from that verdict claim nothing a withdrawal can
undo. The store validates the transaction's own read set as it does a client
commit's: every read is held to the seq this replica had for the document, so a
commit the store took but the replica had not applied when the transaction read
is a conflict, and every document the transaction writes is held to the store
seq the transaction was stamped at. A transaction that read state sealed into
the open wave is refused, since the wave could still withdraw that state and a
commit made durable over it could not be withdrawn with it; a caller stages such
state in an earlier cycle. The replica takes the writes only once the store has
accepted them, so no run reads them as pending state a refusal could roll back.

A wave open when the direct commit lands learns of it once the replica has
applied it. Its commit step treats a document the direct commit wrote, sitting
at exactly that commit's seq, as observed rather than conflicting for a
contribution sealed after the commit that read the document with the commit
applied and read none of the commit's documents before it, and holds the store
to that exact head when it commits. A contribution sealed before, or one with no
such read to show it saw the commit, keeps the ordinary conflict, since its
write may rest on state the commit replaced; one that read a document as it
stood before the commit is refused at its own commit by the replica's claim
check and never seals, and the wave holds such a read to the same rule should
one reach it. This is what lets a piece the update moved re-derive in the same
cycle, whether the loop's pointer watcher swaps a piece it runs or the demand
pass loads one the verb staged.

The served `setsrc` verb builds its update on that. It takes a pattern the space
already holds: a program sent with the request is compiled as an `upload` verb
of its own, so the closure is durable at that verb's wave commit before the
update's setup transaction reads and extends it, and the update runs in the
cycle after. The transaction is the client-side update's — the pin against the
pattern the update was proved on, the compatibility assertions, the
retained-argument validators, the source revision, and the delegation the
successor inherits — carrying the requester's trust snapshot as a creation's
does, committed directly, with the piece not started here. A piece the loop runs
is swapped by its pointer watcher; a piece nothing runs waits for demand, and
unless `start` is `false` the verb names the piece's root as its demand so the
cycle after derives it.

The `servingLoop.lifecycleVerbs` block of `/api/health/stats` counts verbs whose
run completed (`runs`) and verbs whose run threw or whose durable confirmation
failed (`failures`).

## What the client still does

The seed this implements records the direction as "client speculative-local,
server-state wins", and for `cf` there is nothing to speculate: the CLI resolves
the program locally — reading the files, pinning fabric imports — and sends it.
What `cf piece new` still does in its own process after the receipt is what any
client does when it opens a piece: it starts the piece, which under the flag
runs the graph as speculation while the serving loop serves the derived values.
`--no-start` skips that and sends `start: false`, which leaves the piece set up
and undemanded on the serving side too: the loop derives it when something first
demands it, not in the cycle after the creation. Registration still runs under
`--no-start`. The serving loop ensures the default root on activation; if
registration cannot find that root, the response reports the created piece and
failed registration. The CLI exits unsuccessfully unless registration is
handled, printing the retry key and created piece when available.
`cf piece new --request-key <key>` resumes an uncertain creation or incomplete
registration. The request is awaited without a wall-clock bound, since a
creation the server is still committing lands whether or not the client waits;
the bound the client keeps is on its own start.

`cf piece setsrc` resolves the program the same way and sends it with the
piece's id; the receipt is the accepted setup transaction's. What the command
then does in its own process is what a client-side update does after its commit:
it starts the piece it holds, which under the flag runs the graph as speculation
while the serving loop serves the derived values, and reports that refresh's
outcome beside the receipt — a failed refresh is a non-zero exit over a durable
commit. A piece addressed at a scope keeps the client-side path, since the verb
takes the piece's id alone.

Other clients of the piece controller — the browser shell, the background piece
service — keep the client-side shape. Moving each is its own change; the served
operations and the route are what they move onto.

## Tests

- `packages/runner/test/executor-lifecycle-verbs.test.ts` — the queue: a verb
  activates a sessionless space and resolves once its write is durable, a failed
  run or a failed confirmation rejects and is counted, queued verbs run in
  order, and an inactive server refuses; and a direct commit is durable when its
  `commit()` resolves, refuses a document that moved past its stamp, and lets a
  piece it stages derive.
- `packages/runner/test/runner.test.ts` — `runSyncedWithCommit` issues a receipt
  while sealing when asked for a direct commit, and leaves the piece unstarted
  when told to.
- `packages/piece/test/served-lifecycle.test.ts` — the served operations against
  a real memory server and serving host, read back through a client runtime
  opened afterwards; for `setsrc`, the successor's authority over the
  predecessor registered on the serving runtime and stored in the closure a
  later runtime reads.
- `packages/toolshed/routes/pattern-lifecycle/` — the writer check against a
  real ACL document, the status each refusal maps to, and the middleware order
  in front of the handler.
- `packages/cli/test/pattern-lifecycle.test.ts` — the client's signing and
  refusal handling against a stubbed fetch;
  `packages/cli/test/piece-integration.test.ts` and
  `packages/cli/integration/integration.sh` drive the real verbs against a
  toolshed in both CI arms.
