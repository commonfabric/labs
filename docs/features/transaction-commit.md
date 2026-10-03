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
Bridge `initialize()` keeps the target demanded before atomically selecting an
existing backing value or storing the default. It first establishes current
scheduler reads, then waits for pending commits that intersect the backing-value
check or any installed action's scheduling reads. The backing-value check follows
read links and the final write redirect, including cross-space targets. Commit
footprints include every read, write, and document precondition in every space,
so delayed later-space writes and rejection repair remain covered.
Known normalized scope kinds are matched separately. An omitted scope matches
every scope; paths and principal/session instance identities are not narrowed.

Only ordinary extended storage commits with known document effects can be
excluded. Raw or unclassified work, callbacks, post-commit effects, SQLite
operations, genuine or unclassified seals, and pattern lifecycle work retain the
full wait. Overlay's ordinary store-forwarding path uses the same document
footprint as direct storage commits. Unknown
scheduler dependencies also select the full barrier. Read dependencies are
recomputed after each readiness wait; declared output surfaces do not justify
excluding a commit. This lets initialization proceed during disjoint plain writes
while retaining demand for producers a pending commit installs.

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

Commit callbacks, verdict callbacks, and post-commit effects must be registered
while the underlying transaction is ready, before storage starts. Once storage
starts, readiness can rely on the commit's recorded effect scope; later hook
registration throws.
Runtime-owned lineage can observe an already-started transaction's original
storage or seal completion without adding a public hook. This observation precedes
inline effects, so an effect can wait for the work it launches to be released.
