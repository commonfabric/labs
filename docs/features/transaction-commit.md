# Transaction commit stages

A transaction stages writes until the caller starts its commit. Calling
`tx.commit()` starts preparation and storage work and returns a
`TransactionCommitReceipt` synchronously. The receipt has two promises:

| Stage | What it establishes |
| --- | --- |
| `verdict` | The commit's fate: accepted, rejected, or refused locally |
| `settled` | Completion after subscription coverage or rejection repair, commit callbacks, and inline post-commit effects |

The receipt requires explicit stage selection. Awaiting it rejects with a
stage-selection error, including in untyped code. Promise collections assimilate
it as a rejection and apply their own rejection rules. This misuse does not
cancel the commit attempt; its stages remain observable. Both stages return a
`Result`: expected refusal is carried in
`.error`; internal exceptions can reject the promises.
Internal exceptions are reported even when neither stage is observed. Backends
without a separate verdict signal resolve `verdict` with settlement.

For an ordinary valid single-space transaction, the local replica receives the
optimistic writes before `commit()` returns. Local computation and
rendering can use that state while confirmation remains pending. A local
refusal can prevent those writes from applying; a later server refusal can
withdraw them. An available value does not establish persistence.

Multi-space transactions start each space in sequence and can partially
succeed. Returning the receipt does not establish that every space has applied
locally. With server execution, a seal destination can accept a contribution
into a wave or speculation overlay. Its verdict follows that destination's
contract; the wave's later durable disposition is separate. A seal destination
that forwards an ordinary store commit preserves the store receipt's early
verdict and later coverage or repair. A one-stage contribution seal supplies
acceptance on both receipt stages.

## Choosing a completion stage

A read of reactive state usually needs producer and load readiness, not a
commit outcome. Runtime `Cell.pull()` and bridge `CellHandle.pull()` demand
those computations and required loads. Both return absent values and empty
objects under the same readiness contract while writes may remain pending.
An absent result can also precede a producer that a pending commit installs;
it does not prove that the cell will remain absent.

Pass `awaitDurability: true` to either pull to keep its demand active through
the runtime-wide commit-aware barrier. Keeping the demand active lets a commit
install a lazy producer that the pull then computes, and includes the writes
that computation produces. The barrier also covers pending pattern work.
`RuntimeClient.idle()` crosses the same barrier without adding a cell demand.
Hosts use pending-write notifications to guard teardown independently of reads.
Bridge `initialize()` first demands the cell's producers and required loads. It
can return an existing backing value while unrelated commits remain pending,
including commits from a running pattern in another space. Every document
consumed to build the returned value, including redirect and linked-value
targets, must be free of pending local writes. The returned value is the snapshot
selected by that transaction; later writes can still change it.
Later branches of a multi-space commit become pending local writes only when
they start in their replica. Before such a branch starts, initialization can
return this stored snapshot; the branch can subsequently change the cell.

For an absent or optimistic backing value, or an inconclusive read, initialization
keeps demand active through the full commit-aware barrier before atomically
selecting a value or storing the default. That lets a pending commit or conflict
repair install a producer without initialization replacing the value it supplies.
This fallback is runtime-wide: unrelated pending work can delay a first-use
default, including iframe bootstrap. Read failures defer to this barrier only
when recorded reads show a pending local write; other failures propagate.

None of these reads tells confirmed state from what the replica holds locally.
`readConfirmed(runtime, space, read)` runs `read` synchronously in one
read-only transaction that reads past any speculation overlay, so every
document it consumes is read at one instant, and reports whether each of those
documents is confirmed: no local write is pending, no refused write or
incomplete wave is folded into the value, and the replica has evidence of a
stored version. A server delivery or an accepted whole-document set or deletion
establishes that version. A blind patch alone does not establish the complete
result, since it may merge with content this replica has never loaded. Verified
content under a content-addressed id also establishes a stored version.

Confirmation alone does not establish freshness. An accepted mutable document
that has never been delivered can remain at that accepted version while other
sessions change it. Such a read returns `confirmed: true` without a `seq`:
loading the document with `sync()` establishes its watch and brings in current
state. Immutable content needs no continuing watch. Every read counts, a
`sample()` as much
as a `get()`. When they all are confirmed and the replica can say, it also
returns the commit sequence the read is complete through: the `toSeq` of the
last server push the replica applied whole, so that every commit at or below it
that touched a document the read consumed is reflected in what it read. A read
assembled from separate pulls has no such sequence, since one pull can see a
commit that an earlier one missed. The replica cannot say before its first
push, after a frame it failed to apply or applied with entries quarantined, and
while its server runs server execution or does not say whether it does, since
a co-hosted executor's wave commits can reach a push's stamped head before
their changes reach the push.

`readDurable(runtime, read)` runs `read` the same way, in any space, and
returns what it read past the speculation overlay: confirmed state with this
runtime's own pending writes over it, which under server execution is what the
server wrote rather than this runtime's preview of it. A subscription to a cell
delivers changes to what the cell shows, which a speculation layer masks, so a
write that arrives beneath a layer delivers nothing, and neither does the
layer's retirement over an equal value. `readDurable()` therefore also returns
`speculationSettled`, present when a layer stood over a document the read
consumed, which resolves once each such layer has retired or been withdrawn
(`ISpaceReplica.whenSpeculationSettled()`). A reader waiting for the durable
view to say something reads again on each change its subscription delivers and
whenever `speculationSettled` resolves.

Observe `receipt.verdict` when the next step requires knowing the commit's
fate. Use `receipt.settled` when a retry needs the repaired read basis, when a
read needs the covered subscription view, or when the caller needs inline
post-commit effects to finish. Runtime-owned retry and disposition handling
uses settlement. Durability-gated effects remain owned by the transaction's
verdict callbacks and post-commit outbox.

An ordinary valid single-space write can be read locally as soon as initiation
returns. Its outcome can be observed separately:

```ts
// Shown at module scope.
import type { Cell, IExtendedStorageTransaction } from "@commonfabric/runner";

declare const tx: IExtendedStorageTransaction;
declare const cell: Cell<number>;

cell.withTx(tx).set(7);
const receipt = tx.commit();
const localValue = cell.get();

const result = await receipt.verdict;
if (result.error) throw new Error(result.error.message);
```

Both raw storage transactions and extended runtime transactions expose the
same `commit()` receipt. TypeScript rejects awaiting the receipt itself; select
`.verdict` or `.settled` explicitly. Promise collections also need stage
selection, such as `Promise.all(receipts.map((receipt) => receipt.settled))`.

`commit({ holdSyncedUntilCovered: false })` lets controlled-staleness fixtures
observe accepted writes without holding replica `synced()` for coverage.
This option changes the synchronization hold independently of the observed
stage. The receipt's settlement and the runtime's pending-commit barrier still
wait for coverage or rejection repair. The default keeps the coverage hold.

Each receipt belongs to its own invocation. Starting a second commit on a
transaction that is already pending or complete returns that invocation's
completion error on both stages, even when the original commit succeeded.

## Naming the commit

A commit the store accepts lands at a position in its space's commit log, the
same sequence every document revision in that space carries as `since`.
`tx.committedSeq(space)` returns that position once the commit's `verdict` has
resolved. It is `undefined` before then, for a space that refused the commit,
for a space the transaction wrote nothing to, and for a contribution a wave or
the speculation overlay accepted without the store committing it: that
acceptance is the contribution's verdict, and what becomes of the wave is
decided later. A multi-space commit that fails partway keeps the positions of
the spaces whose stores accepted it.

The transaction a sender's commit callback receives bounds where the handling
of its event committed. `handlingCommittedBy(runtime, tx)` returns a position
at or past the handling's commit: exactly that commit when the callback's own
transaction committed the handling, and otherwise the current revision of the
handling's receipt, which the handling's commit created. That covers a
transaction refused as `receipt-exists`, whose receipt an earlier delivery
wrote, and server execution, where the callback receives the sender's local
echo. A later write to the receipt, which a handler with a reactive result
makes as its launched pattern runs, moves the position later, so a read at or
past it reflects the handling, but the position does not identify one commit.
It returns `undefined` when the handling wrote no receipt. A receipt is
written only with commit preconditions or server execution enabled.

```ts
// Shown at module scope.
import {
  type Cell,
  handlingCommittedBy,
  type IExtendedStorageTransaction,
  type Runtime,
  sendEvent,
} from "@commonfabric/runner";

declare const runtime: Runtime;
declare const stream: Cell<{ title: string }>;

const handled = Promise.withResolvers<IExtendedStorageTransaction>();
sendEvent(stream, { title: "next" }, (tx) => handled.resolve(tx));
const reflected = await handlingCommittedBy(runtime, await handled.promise);
```
