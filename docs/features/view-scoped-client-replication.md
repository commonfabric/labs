# View-scoped client replication

This experimental web-client mode uses the server's observed execution reads to
choose the documents needed for rendering and local interaction previews. It
requires server execution, an opted-in web client, and a Memory server that
advertises `viewScopedReplicationV1`. The
[experimental flags registry](../development/EXPERIMENTAL_OPTIONS.md#viewscopedreplication--webviewscopedreplication)
defines the global default and independent web override. Both client modes can
use one space concurrently.

## View ownership and delivery

Each renderer mount registers a view ID, revision, root query, mode, and
component-contract version on its authenticated session. Several mounts form a
union within that session. Each browser tab owns its own worker. Unmounting
removes exactly that mount's interest. Runtime disposal immediately retires its
graphs and queues removal of its interests, including when storage remains open.
A held code load cannot delay local retirement. A replica grants exclusive view
ownership to its current runtime. Replacement retires the previous runtime's
graphs; its later cancellations and disposal cannot clear the replacement's
interests. Revisions remain monotonic across runtimes using that replica. Watch
responses integrate in mutation order, including responses to a retired view
owner. Ordinary document and operation deliveries remain shared; retired view
plans are withheld. A replacement computes its holdings after those earlier
deliveries have integrated. Desired mounts update before a watch request enters
the send queue, so reconnect cannot restore a view canceled behind an older
pending request. A failed or expired mount request cancels its original mount
ID; registration that completes after cancellation cannot start rendering and
releases its view interest.

View interests and ordinary watches have separate ownership. Replacing ordinary
watches preserves views unless the request explicitly replaces them. Replacing
views preserves ordinary watches. Editor reference reads, iframe bridge reads,
operation fields, and pending-intent subscriptions retain their ordinary
lifetimes.

The server distinguishes execution demand from delivery. Visible roots demand
authoritative execution. Supporting documents selected for local previews are
delivery-only roots and do not create additional execution demand. A selection
is accepted only for the current session lifetime, view lifetime, revision,
generation, and READ authority. The protocol supports the default branch; a
nondefault branch is rejected. A downgrade retires local preview registrations
and, after session authentication and watch restoration, starts ordinary graphs
for the remaining mounted roots. This fallback lasts for the runtime's lifetime;
a later capable connection requires a new runtime to enter view mode again. Each
root reports its own fallback failure while the remaining roots continue.
Session restoration remains pending across transient reconnect failures and
rejects on session closure.

Delivery selects complete documents. Selecting a field limits traversal into
other documents; it does not hide unrelated fields within a delivered document.
Path projection and navigation prefetch are separate work.

## Observed reads and component contracts

After a successful serving settlement, including a quiet settlement or a partial
wave that reaches its flush deadline, the planner checks whether the view
selection needs updating. Unsettled producers carry no currency basis. It
traverses a new or changed visible view using renderer semantics and shared
component schemas. After a wave the flush deadline cut, a view that already
holds a published selection keeps it, and only a view with none is planned;
the next settlement that reaches quiescence plans every view whose snapshot
or walk changed, so a burst of cut waves plans each view once, as it ends,
over the snapshot it left. The cap bounds each cut settle and not the
deferral: a space under continuous input keeps its plans for as long as the
input lasts. When a settlement that reached quiescence plans after its wave
committed, the serving loop first has the memory server send the sessions
the documents the wave committed: planning walks every viewing session's UI,
and on a co-hosted server that is time the frames those documents owe would
otherwise wait behind. With the overlapped commit
(`SERVER_EXECUTION_OVERLAP_COMMIT`), the plan publishes while the commit is
still in flight, and its frames keep the refresh's own turn. Within one settlement, views whose snapshots carry the same
observations and whose walks read the same addresses select their cone once.
Ordinary rendered attributes and object props contribute
their reads. Declared bindings contribute their effective component projection;
stream targets identify visible handlers, and writable bindings identify direct
edits.

The planner uses actual scheduler read logs, including shallow reads and
identity-specific execution instances. It selects JavaScript computations
reachable from visible edits that can affect rendering. Their observed side
inputs are included. Non-JavaScript nodes end local propagation, so inputs used
only to prepare fetches or LLM calls are not selected for previews. Cross-space
reads require their own authorized subscription and do not make a local
computation eligible through this planner.

`packages/runner/src/component-read-contract.ts` contains data-only schemas
shared with components. Fixed contracts include message lists, autocomplete,
maps, locations, transcription, tools, editor mention lists/reference maps,
profile fields, Markdown content, FAB preview text, and theme values. Components
continue to own dynamic reads:

- `cf-picker` reads bound item lists as opaque cell handles and mounts the
  selected item's rendering; its list subscription does not follow off-screen
  items' UI.
- `cf-render` follows its current target and mounts nested rendering.
- `cf-code-editor` follows mention destinations and their current names/titles.
- `cf-piece-menu` reads the selected piece's arguments and result when opened.
- `cf-iframe` serves the resources requested by its guest through the bridge.
- `cf-cfc-label` and `cf-cfc-authorship` read runtime-attested metadata.

Past read sets describe observed branches. An unseen handler or newly taken
branch may need a server response before it can preview locally. Handler
observations are scoped to live viewing sessions and are pruned when those
sessions stop contributing view demand. The first successful observation is
retained even when its view is registered in the same serving cycle. Guarded
handler registrations select the implementation for the viewing identity before
looking up its observations.

The publisher caches the visible tree walk under its session and view lifetime.
Storage notifications invalidate it using the scheduler's scoped, path-sensitive
read matching, including shallow reads and missing values. Within the walk,
what was found at each visible cell is kept the same way: a change forgets
only the cells whose recorded reads it touches, a walk reads those again and
takes the rest from the last walk, and a cell the walk no longer reaches is
forgotten with it. Visible stream links
are retained independently of handler observations, so new handler read sets can
change eligibility without walking the UI again. Replica resets and replacement
view lifetimes discard the cached walk.

Selection and producer certificates have separate dependencies on registration
metadata and the values they fingerprint. A changed execution snapshot also
refreshes selection, including producer currency and errors. Quiet cycles reuse
both results. Invalidation remains active while a view is disconnected and while
its plan publication is awaiting completion.

Each plan builds an entity index over its identity-specific execution snapshot.
Producer traversal checks exact path and shallow-read overlap within matching
entities and expands each reached node once. Preview selection stops at
server-only boundaries; error propagation may cross them. Producer certification
indexes both declared and observed writes. These indexes live for one plan, so
branch changes and new execution outcomes are included in the next snapshot. The
serving logger records performed UI walks under `view-replication/render` and
complete per-view planning under `view-replication/plan`; cache hits do not
increment either count. `view-replication/snapshot` separately records execution
snapshot comparison, which precedes those timers. The comparison checks
observation-log and write-surface identities plus current outcome fields, so its
cost follows node count rather than the total number of logged paths.

Disconnected sessions retain their view subscriptions and handler observations
for reconnection, but plan construction is deferred while no connection owns the
session. Reopening a session wakes the serving loop and resumes planning from
the current execution snapshot.

Memory retains demand and supporting delivery as separate tracked graphs. Dirty
documents refresh those graphs incrementally; support updates do not become
execution demand. Ordinary watch additions extend the demand graph and deliver
differences against the session's current delivery state. A selection that
adds delivery roots to a view and takes none away extends the view's support
graph by the added roots within the next incremental refresh, over the demand
graph that refresh keeps current. A selection that drops a delivered root
rebuilds the view's support graphs from the current selections over the demand
graphs, which the same pass first refreshes by its dirty documents, and diffs
the session's delivery against the result, so the departed documents are
removed without the demand being walked again. A full view replacement or
recovery rebuilds every graph. A selection that changes only what
the view may run or adopt leaves the graphs standing: its plans ride the
session's next frame, a frame of plans alone when nothing dirtied it. A frame carries the plans when they are owed, by
such a selection or by a rebuilt graph; an incremental frame that owes none
carries documents alone, and the client keeps the plans it holds. Unrelated commits without catch-up
markers or operation changes produce no view frame. View replacements declare
the replica's current holdings when the server supports that protocol, allowing
unchanged documents to be omitted while still delivering missing documents and
removals. A frame carries complete manifests whenever it carries plans.

## Guarded local execution

An enabled piece open, including a redirect to an output cell, synchronizes its
name and opaque UI tip. A mounted view receives a manifest containing eligible
action IDs, source identities, admitted input documents, observed JavaScript
write surfaces, and settled producer bases. The replica applies the manifest
after its document frame, including frames with no document changes. A
quarantined delivery suspends preview eligibility.

Whole-value producer fingerprints compact descendant paths already covered by an
ancestor fingerprint. This does not change the observed reads used to select
eligible actions or their admitted input documents.

Settled computation failures upstream of the rendered view accompany its plan.
They are selected using the viewing identity and observed path dependencies;
unrelated outputs do not contribute errors. The mounted client reports a new
failure once, preserving its piece context and mapped stack. Retired view
revisions cannot report errors into a replacement mount. Error delivery does not
authorize the failed computation to run locally. An exception in a mount's error
callback is reported without interrupting plan acceptance or error delivery to
other mounts.

The client installs resident JavaScript bindings from the exact stored pattern
identity. It does not run setup or raw factories to reconstruct missing output.
Missing registration inputs leave only those nodes pending. Successful bindings
retain their scheduler state across coverage updates and plan generations for
the same piece and source identity. Coverage and plan changes retry pending
nodes, including when an input link changes before its former target arrives. A
source change or removal from the view retires the registration. Installation is
serialized so an older asynchronous load cannot displace a newer registration.

An eligible computation can start clean when its settled server read and output
basis matches the replica. Its own observed values require complete local
coverage and its reads must belong to the admitted input union. The bound source
must match both the manifest and stored identity. Registration installs the
observed writer surface and wake dependencies before establishing currency.
Those dependencies include the source identity, the computation's reads and
outputs, and the complete transitive producer basis.

This initial state retains server provenance: it does not count as a successful
local attempt. Plan and coverage changes revalidate clean adopted nodes,
including evidence for ancestors omitted from the replica. One revalidation
proves each producer, matches each basis value, and checks each source once,
for every adopted node that reaches it, and a node whose proof observes what
its previous proof did keeps the dependencies and write surface that proof
installed. Value changes or a failed proof retire adoption and use ordinary
guarded execution. Later plans
cannot adopt a node that has already been invalidated or run. Missing or cyclic
proof uses the same fallback, without requesting more documents solely to enable
adoption. The existing view-replication flags govern this behavior.

A speculative transaction must satisfy all of these conditions through commit
preparation:

- Its view generation, action eligibility, and stored source identity agree.
- Every consumed document belongs to the admitted input union and has complete
  local coverage, or the transaction already wrote the exact consumed path.
- Known JavaScript producers of consumed values have either completed a
  successful local attempt or retain their authoritative input and output basis.
  The latter check includes transitive producers. Observed server write surfaces
  cover redirect targets as well as structural bindings.

An authoritative producer basis is published only after the authored body
succeeds and its contribution survives durable wave settlement. It fingerprints
observed paths with the canonical data-model hash and includes path
reachability. A matching input alone cannot certify an output hidden by a stale
local overlay; the output must match too. Basis dependencies wake parked
consumers when a side input changes, even if its producer cannot run locally.
The client indexes admitted inputs and producer write surfaces by document and
scope for each accepted plan. A synchronous currency proof checks each reached
producer once and records its basis as wake dependencies. The reads of one
transaction share a proof, and each validation pass makes its own, so a commit
validates current replica and local scheduler state again and fails a read an
earlier proof let through before that state changed. Fingerprints may be
reused for an unchanged primitive or a value proven deeply frozen. Every check
still observes the current value and path reachability. Mutable values are
rehashed.

Shallow observations use conservative deep fingerprints for this currency check,
so an unrelated nested change can postpone a preview.

Unknown data differs from confirmed absence. A known absent value may use a
default or produce an intentional `undefined`; an unknown value cannot do so. An
unavailable read poisons the whole attempt even if authored code catches the
signal. Writes and staged work are discarded. Reactive attempts retain wake
dependencies and park without retries or missing-data pulls. A rejected transaction
rechecks its input basis before releasing it, retaining an expired basis until
scheduler finalization. A rejected handler preview whose eligibility has expired
finishes without retrying. Handler intent continues through the ordinary
authoritative event path.

The client keeps confirmed UI while a computation is unavailable. It also defers
local dynamic child-pattern materialization to server-provided roots. Cycles and
inputs from unproven producers can therefore wait for the server. Eligibility
generations are not a claim that every value is current at a particular
sequence; durable reconciliation remains governed by the
[speculation protocol](../specs/server-side-execution/speculation.md).
