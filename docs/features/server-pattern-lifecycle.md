# Pattern lifecycle verbs on the serving runtime

Under server execution, the three verbs that give a space a pattern — upload a
program, instantiate a piece from it, and replace a piece's source — run on the
space's serving runtime. The client's part is to resolve the program from disk
and request; the serving side compiles, materializes or replaces, and commits.
This document is the contract for that: how a client sends a verb, the
authority it needs, where the verb runs, what comes back, and what still happens
on the client.

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
Off the flag a deployment has no serving loop, its memory server does not
advertise `patternLifecycle`, and `cf` performs each verb in its own process.
`cf test` runs a whole stack in memory and is untouched either way.

## Sending a verb

A client sends a verb as a `pattern.lifecycle` request on its memory session on
the space
([`04-protocol.md` §4.3.10](../specs/memory-v2/04-protocol.md#4310-patternlifecycle--run-a-pattern-lifecycle-verb)),
which a memory server takes while it advertises the `patternLifecycle` hello
flag. The session reaches the process that serves the space: a deployment that
runs several toolshed processes routes each space's memory WebSocket, by its
`space=<did>` query parameter, to one process, and the serving loop serves the
space on that process. A request takes at most 8 MiB in UTF-8
(`PATTERN_LIFECYCLE_MAX_BYTES`). On a connection through the memory router a
request takes at most 4 MiB, the router's request bound, and the client refuses
a larger one before sending it.

The request is `{ type: "pattern.lifecycle", requestId, space, sessionId, verb,
body }`, where `verb` is `upload`, `instantiate`, or `setsrc`, and `body` holds
the verb's arguments, [below](#arguments-and-receipts); the session supplies the
space. The response's `ok` is the verb's receipt.

The toolshed installs its handler on the memory server with
`Server.setPatternLifecycleHandler()` once the serving loop starts, and removes
it at shutdown; the server advertises `patternLifecycle` exactly while a handler
is installed. The handler (`lifecycleRequestHandler` in
`runtime/toolshed/lib/pattern-lifecycle-handler.ts`) runs each request in a
trace span of its own, validates `body` against the verb's schema, and runs the
verb through `processLifecycleCall()` in
`runtime/toolshed/lib/pattern-lifecycle.ts`.

The memory server finishes handling the request's frame once the verb has
started, and sends the response when the verb settles. Frames sent after it for
the same space on that connection are handled without waiting for the verb, and
on a routed connection the request's credit returns to the router at once.
`SpaceSession.runPatternLifecycle(verb, body)` in
`runtime/memory/v2/client.ts` sends the request, and
`IStorageManager.runPatternLifecycle(space, verb, body)` sends it on a storage
manager's session for `space`.

### Arguments and receipts

A verb that takes a pattern takes it one of two ways, and exactly one: `program`
— the program as the client resolved it, every file by name, with `main`, an
optional `mainExport`, optional `sourceRoots`, and optional `dataFiles` — or
`pattern`, a `{ identity, symbol }` pointer to a closure the space already
holds. A body naming both or neither fails validation.

| verb          | arguments                                                                                                                | receipt                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `upload`      | `program`                                                                                                                | `{ pattern }` — the pointer the space now holds the program under                                                                                |
| `instantiate` | `program` or `pattern`; optional `argument`, `repository`, `slug`, `force`, `register`, `start`, `requestKey`            | `{ pieceId, pattern, slug?, requestKey, registration: { status, error?, attempt?, terminal? }, timings? }`                                       |
| `setsrc`      | `piece`; `program` or `pattern`; optional `repository`, `dangerouslyAllowIncompatibleSchema`, `expectedPattern`, `start` | `{ pieceId, pattern, revisionId, seq, detachedOrigin }` — the accepted setup transaction's receipt, `seq` its position in the space's commit log |

Once creation commits, a preparation or completion refusal returns the created
receipt with failed registration and its retained request key. It makes no new
authorized-write or terminal-delivery claim; the caller retries that same key
after authority recovers.

The `instantiate` receipt's `timings` lists, in the order they happened, the
steps the serving side timed, each as `{ phase, ms }` in whole milliseconds. For
every served verb the creation ran — `instantiate`, then `registration-prepare`
and `registration-finish` when it registers — it records the writer check
(`<verb>.authorize`), the serving side's session (`<verb>.session`), the wait
for a cycle of the serving loop to take the verb (`<verb>.queue`), the verb's
own run (`<verb>.run`), the wave commit after it (`<verb>.commit`), and the
durability read (`<verb>.confirm`). `registration.delivery` is the wait for the
registration event to take effect. The request's trace span carries the same
durations as `cf.lifecycle.<phase>_ms` attributes, together with the request
key as `cf.request_key` — the receipt's, which the server generates when the
caller sends none, or for a refusal the caller's own — so a creation a caller
reports by its key can be found among the traces. If a verb fails, its completed
phases still reach the request span; phases never reached are absent. The
failure keeps its refusal code across the worker port.

### Refusals

A refusal is an error response named `PatternLifecycleRefusal`. Its `code` is
stable and is what a client branches on; its `message` is prose for a person.

| code                                             | meaning                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle-unsupported`                          | raised by the client before sending: the memory server does not advertise `patternLifecycle`                                                                  |
| `payload-too-large`                              | the message takes more than 8 MiB in UTF-8; the client refuses before sending past that, or past 4 MiB on a routed connection                                 |
| `invalid-request`                                | `body` does not match the verb's schema, including a body naming both `program` and `pattern`, or neither                                                     |
| `forbidden`                                      | the caller is not a writer of the space, or there is no such space                                                                                            |
| `pattern-not-found`, `piece-not-found`           | the named pattern, or the named piece, is not in the space                                                                                                    |
| `slug-taken`, `source-moved`                     | the slug names something and `force` was not set; the piece is not on the pattern the update was proved against                                               |
| `compile-failed`, `setup-failed`, `incompatible` | the program did not compile; setup refused the pattern or the argument; the candidate cannot run over the piece's retained state and the override was not set |
| `server-execution-off`                           | the memory server has no handler installed: no serving loop runs on this deployment                                                                           |
| `space-not-served`                               | the serving loop on this process cannot serve the space                                                                                                       |
| `internal`                                       | the handler threw, or the serving side failed for a reason it does not name                                                                                   |

`cf` takes every refusal but `internal` and `space-not-served` as a decision
that the verb did not run. It takes those two, and a connection lost before the
response, as an unknown outcome, for which `cf piece new` prints the request key
to retry with.

## Authority

A `pattern.lifecycle` request runs as the DID its memory session was opened as
(the session's principal). Before the verb starts, the memory server requires
that DID itself to hold WRITE on the space, resolved as it resolves an authored
commit. A grant the session holds only through a proof chain's root issuer does
not count, since the verb commits with the requester's own trust. An anonymous
session, or a principal without WRITE, is refused `forbidden`. `cf` opens its
sessions as the identity it connects as.

The handler then checks that DID against the space's ACL itself: it must hold
WRITE or OWNER there, resolved the way the memory server resolves an authored
commit — the wildcard grant and the service principals count — so a caller the
memory server would admit writing directly is admitted, and no other. A
deployment with ACL enforcement off admits every authenticated caller, as its
memory server does. One denial covers a malformed DID, a space the deployment does not host,
an absent ACL, and a caller without a grant, so the check is not an existence
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
its own, apart from the criteria the session-open and admission hooks consult.
The
`SpaceServer` queues the verb and runs it as a step of its next wave cycle,
after the root ensure and ahead of the event drain, awaited in full, so every
transaction the verb seals joins that cycle's wave. The request settles once the
wave has committed and the verb's `confirm` step — a read of the durable state
the verb was to leave — has passed. A seal's acceptance is not durability, since the wave commit can
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

With `register: true`, the handler prepares the default pattern's `addPiece`
delivery and retains its attempt in a serving wave. It then invokes the stream
through trusted ingress, retaining the authenticated caller's identity. The
caller must also have WRITE access to the stream's target space before any
trusted observation or delivery, including when a root exports a foreign
handler. An observer outside the serving wave watches the prepared stream's
durable event sidecar, including a read after subscription to recover already
completed replays. The event goes to the process's own memory server, except
that a stream in a space other than the verb's, on a toolshed routing its
crossings (`SERVER_EXECUTION_OWNER_ROUTING`), is appended to through that
space's owner on a routed session, and the observer watches the stream's
document on that session for its changes; the readback of the outcome, on the
subscription and on each wake, stays on the process's own trusted memory
service, as does the recovery read. A separate serving wave reads the computed
registry and records `registration.status: "handled"`; its receipt is checked
after the wave commits. The process needs delegation authority, without a READ
or WRITE grant in the space: private reads and receipt writes use the serving
runtime, and the out-of-wave observer reads only the prepared event's sidecar
through the trusted memory service. Waiting outside the wave lets the event's
consequences commit.
This permits a default pattern to derive its registry from panels; the handler
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
The served operations in `runtime/piece/src/ops/served-lifecycle.ts` therefore
compose the lower runner calls — `compileAndSavePattern`, and `setup` with a
transaction the verb stamps — and mint their receipts from what they wrote; the
source update is the exception, below.

### Direct commits

A transaction the serving runtime stamps `directCommit` (a `bookkeeping` run's,
`ServerRunInfo` in `runtime/runner/src/runtime.ts`) does not seal into the
wave. The `SpaceServer` commits it to the store on its own, as a derived-class
commit under the space's lease, serialized with the wave's seals; the
transaction's `commit().verdict` then resolves with the store's verdict, and the receipt
and authority the runner mints from that verdict claim nothing a withdrawal can
undo. The store validates the transaction's own read set as it does a client
commit's: every read is held to the seq this replica had for the document, so a
commit the store took but the replica had not applied when the transaction read
is a conflict, and every document the transaction writes is held to the store
seq the transaction was stamped at. A transaction that read state sealed into
the open wave is refused, since the wave could still withdraw that state and a
commit made durable over it could not be withdrawn with it; a caller stages such
state in an earlier cycle. A caller that runs beside the loop's cycles rather
than inside one waits for that cycle instead: the source reconciler's follow of
a piece's origin, which the loop runs before the tenure's first start of the
piece, compiles the candidate's closure into the open wave where the origin
offers source the piece does not run, and where that transition is a source
update — a `system:` origin, and a running program the piece retains — awaits
`Runtime.sealsCommitted`, resolved once every wave open at the call has
committed, before the adopting write, a direct commit in that case, reads the
closure. The replica takes the writes only once the store has accepted them, so
no run reads them as pending state a refusal could roll back.

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
the program locally — reading the files, pinning fabric imports — and sends it
on the space's memory session.
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
the bound the client keeps is on its own start. With `CF_CLI_TRACE_TIMINGS=1`,
the command reports each step of the creation as a `newPiece.create.<step>`
phase line, and each of the receipt's `timings` as
`newPiece.create.server.<phase>`.

`cf piece setsrc` resolves the program the same way and sends it with the
piece's id; the receipt is the accepted setup transaction's. What the command
then does in its own process is what a client-side update does after its commit:
it starts the piece it holds, which under the flag runs the graph as speculation
while the serving loop serves the derived values, and reports that refresh's
outcome beside the receipt — a failed refresh is a non-zero exit over a durable
commit. The start waits for the commit of the started graph's setup writes,
since a refused one retires the graph in the command's process, whatever the
serving loop goes on serving; that refusal is a failed refresh too. A piece addressed at a scope keeps the
client-side path, since the verb takes the piece's id alone.

Another client of the piece controller, the browser shell, keeps the client-side
shape. Moving it is its own change; the served operations and the
`pattern.lifecycle` request are what it moves onto.

## Tests

- `runtime/runner/test/executor-lifecycle-verbs.test.ts` — the queue: a verb
  activates a sessionless space and resolves once its write is durable, a failed
  run or a failed confirmation rejects and is counted, queued verbs run in
  order, and an inactive server refuses; and a direct commit is durable when its
  `commit().settled` resolves, refuses a document that moved past its stamp, and lets a
  piece it stages derive.
- `runtime/runner/test/runner.test.ts` — `runSyncedWithCommit` issues a receipt
  while sealing when asked for a direct commit, and leaves the piece unstarted
  when told to.
- `runtime/piece/test/served-lifecycle.test.ts` — the served operations against
  a real memory server and serving host, read back through a client runtime
  opened afterwards; for `setsrc`, the successor's authority over the
  predecessor registered on the serving runtime and stored in the closure a
  later runtime reads.
- `runtime/piece/test/ops/pieces-controller.test.ts` — `startPiece()` given
  `awaitSetupCommit` rejects when storage refuses the start's setup commit,
  and a plain `startPiece()` resolves over the same refusal;
  `runtime/cli/test/piece.test.ts` checks that a served `setsrc` refreshes
  the piece through that option.
- `runtime/memory/test/v2-pattern-lifecycle.test.ts` — the
  `pattern.lifecycle` request: the `patternLifecycle` flag, the session and
  WRITE checks, each refusal code, the size bound on both sides, and a frame
  handled while the verb still runs.
- `runtime/toolshed/lib/pattern-lifecycle.test.ts` — the writer check against
  a real ACL document, the code each refusal carries, and a session request's
  validation and outcome; `runtime/toolshed/lib/pattern-lifecycle-handler.test.ts`
  — the handler reading a hosted space's ACL through the memory server.
- `runtime/cli/test/pattern-lifecycle.test.ts` — the client's arguments on the
  session and its refusal handling against a stubbed session;
  `runtime/cli/test/piece-integration.test.ts` and
  `runtime/cli/integration/integration.sh` drive the real verbs against a
  toolshed in both CI arms.
