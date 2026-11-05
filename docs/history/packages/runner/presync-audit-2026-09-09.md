---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Audit snapshot of the runner's pre-sync sites for new starts and resumes, and of every use of the argument meta rail, at labs 924dce02af."
---

# Pre-sync audit of the runner: new starts and resumes

Point-in-time audit at labs `924dce02af`, 2026-09-09. Line numbers are of
that commit. Two questions drove it:

1. Which documents does the runner pull before a piece runs, on a fresh start
   and on a resume from storage, and under which schema? The transformer
   narrows each lift's and handler's argument schema to what the body reads,
   while the pattern's own argument schema describes the whole authored
   input. A pre-sync that follows the pattern schema pulls more than the
   runs will read.
2. Where is the `argument` meta rail used, and does a derived internal cell
   (a lift's output cell) record which argument produced it? If it did, a
   resume could pre-sync the internals and let every node's first run come
   out as a no-op.

## 1. What a sync loads

Every pre-sync in the runner ends in `Cell.sync()`, which is
`StorageManager.syncCell()` (`storage/v2.ts:2219`). The request carries the
cell's path and `schema ?? false`. Three consequences shape everything
below:

- **A schema-less sync delivers the root document only.** `false` normalizes
  to the rejecting selector. Nothing a value links to is followed.
- **A schema-bearing sync delivers what the selector reaches.** Links are
  crossed the way a read crosses them, through `combineSchemaForLink`
  (`traverse.ts`), so the schema on the link and the reader's schema together
  decide what is pulled behind a link.
- **A named root brings its whole metadata family; a crossing does not.**
  `docs/specs/memory-v2/05-queries.md` §"metadata family": a document the
  query names as a root is delivered with every `pattern`, `argument`,
  `result`, and `internal`-manifest target, each whole and recursively
  (`graph-query.ts:334`, `traverse.ts:2912`). A document reached mid-walk
  through a value link gets only its selector and its `cfc` schema document.

The third rule matters more than the first two for this audit. Syncing a
result document by name already delivers its argument document whole and
every derived internal cell in its manifest whole, and naming any one derived
internal cell delivers the result document it backlinks to, and that
document's family in turn. What a schema bounds is therefore never the
argument document's own bytes. It is the set of documents the argument's
values link to, and what lies behind those.

## 2. Inventory of pre-sync sites

### 2.1 Resume: `start()` on a piece stored in a fresh runtime

`Runner.start()` (`runner.ts:3412`) runs the `#doStart` cascade
(`runner.ts:4472`):

| Step | What is pulled | Schema | Site |
| --- | --- | --- | --- |
| 3 | The root document, if `getRaw()` is undefined | none: root only, plus its full family by the named-root rule | `runner.ts:4499` |
| 4 | The pattern by content identity (source docs, compile) | n/a | `runner.ts:4603` |
| 5 | The dependency pre-sync, below | mixed | `runner.ts:4670` |
| 6 | `#startCore` with `awaitSyncBeforeInitialRun: true` | n/a | `runner.ts:4691` |

Step 5 is `#syncCellsForRunningPattern(rootCell, pattern)` with no argument
value (`runner.ts:6393`). Its waves, in order:

1. **Mentioned inputs** (`runner.ts:6402`): a raw walk of the caller's
   `inputs` for links. Empty on a resume, since no inputs are passed.
2. **The result cell**, schema-less (`runner.ts:6427`). Already local after
   step 3.
3. **The node walk** (`runner.ts:6452-6512`), which needs the `argument` meta
   link. For each top-level node it binds `node.inputs` and `node.outputs`
   with `unwrapOneLevelAndBindToDoc` and collects every write-redirect link
   with `findAllWriteRedirectCells`. Each link's cell is synced **under the
   link's own schema**, and each input link is also pushed as an
   `ArgumentLinkRoot` carrying that schema. Finally the whole argument
   document is pushed as a root under `pattern.argumentSchema`
   (`runner.ts:6510`).
4. **Owned cells** (`#collectResumeOwnedCells`, `runner.ts:7088`): every
   derived internal cell of this pattern and, recursing through each
   sub-pattern node's resolved output spot, of every nested pattern to any
   depth. Each is synced under its descriptor schema. Only derived internal
   cells are collected; child result documents and child argument documents
   are not pushed. Child nodes are not walked either.
5. **The result under `pattern.resultSchema`**, plus `[UI]` under the
   renderer VDOM schema when the result schema does not already cover it
   (`runner.ts:6541-6555`).
6. **Second wave, in parallel** (`runner.ts:6580`):
   - `#syncArgumentLinkTargets(argumentRoots)` (`runner.ts:6625`): for each
     root, read the raw value and walk it in lockstep with the root's schema,
     crossing each link the way a read would (`combineSchemaForLink`),
     syncing each target once per document, walking each once per
     (document, path, schema), stopping at `asCell`/`unknown` handles, and
     capping the descent at two link hops. Where a declaration runs out (a
     `true` schema, an object schema without `properties`) it scans the raw
     value with the remaining hop budget.
   - `#syncResumeListChildren(instances)` (`runner.ts:6933`): for each list
     coordinator (`map`, `filter`, `flatMap`) in any visited instance, derive
     the children's result cells from the coordinator plan and sync them,
     iterating slot resolution to a fixpoint.

Step 6 then instantiates every node. Each JavaScript action is subscribed with
`awaitSyncBeforeInitialRun`, which holds its first run until the space's
`synced()` resolves or two seconds pass
(`scheduler/facade.ts:733`, `scheduler/constants.ts:67`). Actions always
re-run on resume; the hold is an anti-churn measure, not a gate on
correctness (the constant's comment says so).

Sub-pattern nodes instantiate their child through `#runWithStartOwnership`
(`runner.ts:10509`). That path calls `#patternToNameBeforeRun`
(`runner.ts:4966`) first: if the child result document carries an `argument`
meta link locally, it probes, on a read transaction of its own and within a
budget of 256 probes, whether the argument document, every document the
caller's and the stored argument link to (four hops, raw walk), and every
owned cell are present. Any absence holds the run and names the child's
family with `#syncCellsForRunningPattern(childResult, childPattern, inputs)`
(`runner.ts:5152`). If the child result document is not local at all, the
meta link reads absent, the child is treated as fresh, and its setup mints a
new argument document; that commit then loses to the durable state and
`recoverInstantiationOnce` re-instantiates from the caught-up view
(`runner.ts:3754`). Whether the child result document is local by then
depends on whether the parent's result schema, its `[UI]` sync, or a derived
internal cell's descriptor schema followed the link to it; a child pattern
with no derived internal cells that is not returned in the parent's result
reaches the retry path.

### 2.2 New starts

| Entry point | Pre-sync before setup | Notes |
| --- | --- | --- |
| `run()` (`runner.ts:5705`) via `#runWithStartOwnership` | none for a fresh piece | Setup and node wiring happen in the caller's transaction. The first action runs read cold targets and rely on the scheduler's conflict re-run. `#pullCellOnceAfterSuccessfulCommit` pulls the result once after commit, only when the pattern holds an eager-result builtin (`fetch*`, `generate*`, `llm`; `runner.ts:8759`). |
| `run()` on a piece reached by a link crossing | the named-family gate | `#patternToNameBeforeRun` probes and, on absence, `#runAfterNamedFamilyLands` names the family with the full `#syncCellsForRunningPattern` and runs later in its own transaction (`runner.ts:5129`). |
| `runSynced()` / `runSyncedWithCommit()` (`runner.ts:5884`, `5930`) | `resultCell.sync()` then `#syncCellsForRunningPattern(resultCell, pattern, inputs)` | Wave 1 walks the caller's `inputs` raw and syncs each link under the link's own schema. The node walk is skipped because no `argument` meta exists yet (the `resume-pre-sync` warning fires, expected on a first run). With no node roots and no argument root, the link-target wave has nothing to walk. Owned cells are collected but absent. |
| Commit-gated starts (`#startAfterSuccessfulCommit` `runner.ts:4836`, `#runPatternAfterSuccessfulCommit` `runner.ts:5564`) | none | Start in a fresh transaction inside the commit callback. |
| Pattern update over a stored argument (`syncStoredSetupArgument`, `runner.ts:6322`, called from `source-reconciler.ts:1008`) | argument document, then `#syncArgumentLinkTargets` over it with no schema | The undeclared form: a raw two-hop scan of the stored argument. |
| Handler dispatch (`presyncInputs`, `runner.ts:9171`; awaited in `scheduler/events.ts:1304`) | per event | Materializes the argument under the module's narrowed `argumentSchema`, then awaits `sync()` on every `Cell` handle found. Value-read links inside the argument are read through `get()`, which kicks a sync it does not await. Fails open. |
| Compile-cache write-back (`pattern-manager.ts:3041`) | source and compiled docs under `WRITE_TARGET_EDGE_SYNC_SCHEMA` | Out of scope for piece runs; listed because it is a pre-sync in the runner package and shows the shaped-selector idiom working (one hop, exactly the edge docs). |

### 2.3 What each wave is bounded by

| Wave | Bound |
| --- | --- |
| Resume node walk, direct syncs | the binding's schema on each write-redirect link |
| Resume node walk, link-target roots | the same binding schema per input link, plus the pattern's whole argument schema for the argument document |
| Resume owned cells | each descriptor's schema |
| Resume list children | the coordinator plan |
| Fresh `runSynced` wave 1 | the caller's value, raw, and each link's own schema |
| Fresh `run()` | nothing |
| Pattern update | raw, two hops |
| Handler event | the module's narrowed argument schema, `asCell` handles only |

## 3. Findings on schema breadth

**F1. The resume node walk syncs node inputs under the binding schema, not
the module's narrowed schema.** A node's input aliases are serialized by the
builder from the argument reactive's `export()` (`builder/pattern.ts:427`),
and that reactive is created with the pattern's authored `argumentSchema`
(`builder/pattern.ts:167`); a keyed path narrows it structurally through
`Cell.key()` (`cell.ts:2779`). The transformer's shrunk schema lands on the
lift module as `lift(fn, argumentSchema, resultSchema)`
(`ts-transformers/src/transformers/schema-injection.ts:2445`) and on the
handler module likewise. The runner applies that narrowed schema only at run
time, `inputsCell.asSchema(module.argumentSchema).get()`
(`runner.ts:8253`). The pre-sync at `runner.ts:6469-6512` never sees it: the
links it syncs and the roots it walks carry `link.schema`, a slice of the
authored schema. Syncing an input link therefore pulls, and the link-target
wave walks, whatever the authored type at that path reaches, whether or not
the body reads it.

**F2. The whole-argument root under `pattern.argumentSchema` makes any
narrowing of the node roots moot for the link-target wave.** `runner.ts:6510`
pushes the argument document as a root under the full pattern schema. The
walk dedupes syncs per document but walks per (document, path, schema), so
this root descends into every link the authored schema declares, two hops
deep, regardless of what the nodes' roots were narrowed to. The comment at
`runner.ts:6629-6637` records that the two-hop cap exists because deployed
schemas "declare reference graphs" and a deeper budget collected more than
the undeclared walk it replaced; that pressure comes from walking the
authored schema. The argument document itself arrives whole with the result
document in any case (§1), so this root's only effect is the link-target
descent.

**F3. Fresh starts pre-sync less than resumes, and with no schema.**
`runSynced` syncs the links in the caller's argument under each link's own
schema and stops; there is no per-node wave and no link-target wave, because
both are keyed off the `argument` meta link that does not exist yet.
`run()` pre-syncs nothing for a fresh piece. Both rely on the first runs
reading cold targets and the scheduler re-running after the conflict. The
one exception is the eager-builtin one-shot pull, which is about the result,
not the inputs.

**F4. Sub-pattern children are bound under the child's authored argument
schema and their nodes are not walked.** `#instantiatePatternNode` binds the
child's inputs with `targetSchema: patternImpl.argumentSchema`
(`runner.ts:10341`), the child's whole authored schema, and the resume walk
(§2.1 step 4) reaches into children only for their derived internal cells.
The child's own lifts and handlers get their narrowed-schema reads only at
run time. What fills the gap at child start is the named-family gate, whose
presence probes are document-granular and whose link scan is a raw
four-hop walk, or, when the child result document is cold, the recover-once
retry. Both are wider or later than a schema-bounded pre-sync would be.

**F5. The handler event pre-sync already uses the narrowed schema, but
awaits only `asCell` handles.** `presyncInputs` is the one site whose bound
is the module's shrunk schema. It syncs every `Cell` it finds and descends
through materialized records, but a value link the narrowed schema reads
through is crossed by `get()` synchronously and not awaited; a cold target
there still reaches the handler body as `undefined`.

**F6. The argument document's own bytes are not what a schema bounds.** By
the named-root rule (§1), `rootCell.sync()` at step 3 delivers the argument
document and every top-level derived internal cell whole, and naming any
derived internal cell of a child (step 4) delivers that child's result
document and its family. The savings a narrowed schema can buy are in the
link-target descent, in the selectors registered for watching, and in the
child-family reach, not in the argument document.

**F7. Four walks stop at a `FabricInstance`.** The mentioned-inputs walk
(`runner.ts:6411`), the undeclared link-target scan (`runner.ts:6744`),
`firstResolvedOutputRedirect` (`runner.ts:811`), and the two argument-link
collectors (`runner.ts:7836`, `7988`) either stop or refuse at an instance,
so a link inside one is never pre-synced. Each site carries a `TODO(danfuzz)`
and `docs/development/DEVELOPMENT.md` §"Stop the scan" records the policy.
Nothing in production carries an instance in an action argument yet.

## 4. Where `argument` is used

The rail is one of three `META_LINK_FIELDS` (`meta-seam.ts:3`). Writers and
readers at this commit:

**Written** in exactly one place, `#applySetupState` (`runner.ts:2856-2940`):
the result document's `argument` meta becomes a write-redirect sigil link to
`getMetaCell(resultCell, "argument")`, whose id is the hash of
`{type: "argument", parent: resultCell}` (`link-utils.ts:779`). The link
carries `pattern.argumentSchema` sanitized with `KeepAsCell.All`. A pattern
swap re-emits it with the incoming schema. The argument document gets a
`result` backlink to the result cell (`setResultCell`, `result-utils.ts:31`).

**Read** through `getMetaLink(resultCell, "argument")` (`link-utils.ts:886`)
or `Cell.getArgumentCell()` (`cell.ts:3248`):

| Reader | Purpose |
| --- | --- |
| `unwrapOneLevelAndBindToDoc`, `sendValueToBinding` (`pattern-binding.ts:267`, `695`) | resolve `$alias: {cell: "argument"}` to the argument document |
| `#bindNodeIO`, `#buildRawNodeInputs`, `#instantiatePassthroughNode`, `#instantiatePatternNode` (`runner.ts:7600`, `9925`, `10293`, `10328`) | bind node inputs and outputs at instantiation |
| action result writes (`runner.ts:8824`, `8956`, `9368`) | route a lift's or handler's output through its binding |
| resume node walk, owned-cell walk, list-child walks (`runner.ts:6452`, `7115`, `6812`, `6954`) | the pre-syncs of §2.1 |
| `#patternToNameBeforeRun` (`runner.ts:4975`) | the named-family gate |
| `syncStoredSetupArgument` (`runner.ts:6326`) | pattern update over a stored argument |
| `pieceOwnedStores` (`runner.ts:1023`) | name the stores a setup transaction fills |
| `builtins/llm-dialog.ts:2830` | a builtin reading its host piece's argument |
| `traverse.ts:2898` (`ALL_META_RAILS`) | the family chase of §1 |

**What a derived internal cell carries.** Its identity is
`{parent: resultCell, type: "internal", cause: partialCause}` under the
descriptor's kind (`link-utils.ts:797`). Its document holds `value`, a
`result` backlink (`runner.ts:2789`), and on the result document's `internal`
manifest an entry `{partialCause, kind?, link}` whose link carries the
descriptor schema (`runner.ts:2784`). A build-time default is seeded once.
There is no `argument` on an internal cell and no record of which node wrote
it or what that node read. The lift's argument exists only as `node.inputs`
in the pattern graph, re-bound at every instantiation.

The one place a lift's inputs enter an identity is `resultFor`
(`runner.ts:9326`): `{inputs: causalFormOfBinding(inputs), outputs, fn}` is
the cause of the frame under which an action runs, so cells the action body
creates, and a handler's receipt cell (`runner.ts:8354`), hash the bindings
into their ids. That is a cause, not a stored pointer, and it names the
binding shape rather than the values read.

**What the scheduler keeps.** Reads are discovered by running: each run's
transaction logs its read set and the scheduler subscribes the node to its
last run's reads (`docs/specs/server-side-execution/serving-loop.md` §3b).
That log lives in memory. The persisted form, `persistentSchedulerState`, was
removed on 2026-08-04 (`docs/development/EXPERIMENTAL_OPTIONS.md` §removed)
and replaced on the serving side by the `scheduler_basis` index, ids and
sequence numbers only, written by the serving loop (`executor/wave.ts:368`).
A client holds no durable record of what a node read.

## 5. Could internal cells point at their lift's argument, and would it help?

They do not today (§4). Two things the question assumes are worth separating.

**The no-op property already holds where the pre-sync lands.** A resumed
lift re-runs once (§2.1 step 6). Its output goes through `sendValueToBinding`
and the diff in `data-updating.ts:1868` elides a leaf whose value is
`Object.is`-equal to the replica's, so a re-run over inputs that were all
local and unchanged writes nothing. The exception is an authoritative
transaction (serving-side effect completions), which emits equal leaves on
purpose. What a resume pays for such a node is the run itself, its read set,
and the diff, not a write. Where the property fails is when an input was
cold: the run reads absent, computes something else, writes it, and the
write conflicts when the durable value arrives.

**What a stored argument pointer or input hash would buy.** The precedent is
the effect builtins: `fetch*` and `generate*` store an `inputHash` beside
their result and skip the effect when it matches
(`executor/effect-completion.ts`, `builtins/fetch-utils.ts`). A lift could
store `{inputHash}` on its internal cell, or in the manifest entry, and the
resume could compare before running. Computing the hash requires reading
the inputs, which is the read set the scheduler needs to subscribe anyway,
so the saving is the function body and the output diff. For most lifts the
body is cheap and the inputs are the cost; for a lift that does real work
over a large input the saving is real. It would also give a second reader,
one that does not evaluate the pattern (an inspector, a server loading a
piece's family), a way to learn which documents a node depends on without
binding the graph. Against it: `resultFor` shows the shape of what would be
stored, and it names bindings rather than the documents those bindings
resolved to at the last run, which is the part a pre-sync wants.

A cheaper route to the same end for the pre-sync exists in the graph already,
and is what §6 recommends: fold each node's narrowed schema back onto the
argument paths its bindings alias, once per compiled pattern.

## 6. Recommendations

Ordered by expected effect on what a resume pulls.

1. **Derive a per-pattern read surface and use it as the root schema.** For
   each node, take `module.argumentSchema` (the narrowed one) and re-root it
   at the argument paths its input bindings alias; union across nodes; for a
   raw builtin use its input schema (`MAP_INPUT_SCHEMA` and siblings, already
   in `LIST_OP_INPUT_SCHEMAS`); for a handler drop `$event`. This is a static
   derivation from the compiled pattern and can be cached on it. Replace the
   root at `runner.ts:6510` with `{cell: argumentDoc, schema: readSurface}`
   and drop the per-link roots, which the surface subsumes. Keep the direct
   sync of each write-redirect link, but under the surface's schema at that
   path rather than the binding's.
2. **Reuse the same surface on fresh starts.** `runSynced` can walk the
   caller's argument value as the root with `initialValues` (the parameter
   already exists for `syncStoredSetupArgument`) under the read surface,
   which gives a fresh start the link-target wave it lacks today (F3) at the
   bound the runs actually hold to. `run()` without a transaction of its own
   could do the same behind its commit-gated start.
3. **Recurse the node walk into bound children, after their result documents
   are local.** The owned-cell walk already computes `boundChildPattern` and
   `childResultCell` (`runner.ts:7153`, `7211`). Push each child result cell
   into the first wave, then walk child nodes in a second wave once their
   `argument` meta is readable, under the child's own read surface. This
   replaces the child's authored-schema bind (F4) with the same bound as the
   parent's, and turns the named-family gate's document-granular probes into
   a fallback rather than the usual path.
4. **Await value-read link targets in the handler event pre-sync.** Run
   `#syncArgumentLinkTargets` over `{inputsCell, module.argumentSchema}` with
   the event folded in, instead of collecting `asCell` handles only (F5).
5. **Revisit the two-hop cap once roots are narrowed.** The cap was tuned
   against the authored schema (F2). A narrowed surface reaches only what a
   body reads, so the measurement that set it no longer applies; re-measure
   on the topics board before changing it.
6. **Do not add an argument pointer to internal cells for the pre-sync's
   sake.** Recommendation 1 gets the pre-sync the same information from the
   graph without a new durable field. An `inputHash` memo on internal cells
   is a separate, optional optimization for expensive lifts, and should be
   weighed against the serving side's deliberate choice to persist ids and
   sequence numbers only (`serving-loop.md` §3b).

## 7. Tests that pin the current behavior

`packages/runner/test/resume-argument-link-target-presync.test.ts`,
`sync-argument-link-targets.test.ts`, `resume-owned-cells.test.ts`,
`resume-owned-cells-skip-log.test.ts`, `resume-presync-unwrap-failure.test.ts`,
`resume-list-children-presync.test.ts`,
`resume-list-children-slot-chain-presync.test.ts`, and
`piece-named-before-start.test.ts`. Recommendation 1 changes what
`resume-argument-link-target-presync` asserts about which targets arrive; a
test there should name a target the authored schema reaches and the read
surface does not, and assert it is left cold.
