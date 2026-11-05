---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "CFC commit-preparation loop audit and paired performance measurements."
---

# CFC commit preparation: wildcard covers and carried-label population

The measured browser ladder passes its scaling and CFC-share targets while
preserving complete per-element label snapshots. The exact-R/P unit ladder
improves full preparation at 800/200/300 from 33.7 to 18.2 ms. A globally
additive preparation bound remains unestablished; the limitations and remaining
loops are explicit below.

This investigation starts from Labs `e19441a38e`, after the five preceding
preparation fixes. It uses isolated emulated runtimes and browser integration
servers, without a Loom instance. Measurements were taken on an Apple M3 Max
with Deno 2.9.4. Raw observations include system uptime and load; timings are
not CPU-isolated.

## What the labels carry

A carried view records the confidentiality and integrity of the reference's
source, at paths relative to that source. It contains observation-specific
labels, not just one confidentiality tag. A concrete example from the
50-instance unit reproduction has 56 entries: 52 `followRef`, one `enumerate`,
two `shape`, and one `value`. One hundred link-write inputs carry views in the
large instantiation transaction. The full examples are in
[carried-label-examples.json](carried-label-examples.json).

For the selected list, representative entries are:

```json
[
  {
    "path": [],
    "observes": "enumerate",
    "label": { "confidentiality": ["secret"] }
  },
  {
    "path": ["*"],
    "observes": "shape",
    "label": { "confidentiality": ["secret"] }
  },
  {
    "path": ["*"],
    "observes": "value",
    "label": { "confidentiality": ["secret"] }
  },
  {
    "path": ["*"],
    "observes": "followRef",
    "label": { "confidentiality": ["secret"] }
  }
]
```

A concrete slot's `followRef` entry also carries a `LinkReference` integrity
atom naming source and target addresses. That evidence is specific to the link;
caching a source view must not reuse another link's root evidence.

The unit reproduction uses the legacy trusted-builder callback shape, retaining
all map arguments. It therefore isolates preparation work even when typed
callback argument selection is corrected. Its largest commit has 2,220 reads and
654 write-policy inputs; these inputs are not operation counts. It reproduces
fifty map instances, not the original report's exact 452-read, 202-operation
journal.

## Why source templates become wildcard queries

The persist seam emits three child templates per labeled pure-link container:
`shape`, `value`, and `followRef` at `[...container, "*"]`, beside the
container's `enumerate` stamp. `cfcLabelViewFromMetadata` carries these payload
labels into a reference view. Only envelope-local `labelMetadata` entries are
excluded. During link persistence, every nonempty carried entry is checked
against the authoritative source view. Its relative path becomes the query
passed to `authoritativeCoverFor`.

In the reproduction's large commit, the baseline performs 5,600 cover checks and
300 wildcard overlap queries. The preparation cache reduces actual wildcard
queries to one while retaining all 5,600 logical checks. Across the whole run,
both arms mint 753 child templates for 251 container stamps;
`consumedLabelWalks` is zero. The source-array templates are shared across fifty
child arguments, so one cached source/path answer serves those repeated checks.
The designed query count is the number of distinct authoritative view/template
paths, not the number of newly written destination containers.

A trailing wildcard asks for the authoritative cover of any immediate child
under a prefix. With `includeDescendants: false`, deeper grandchildren do not
cover that child; ancestors and equal-depth wildcard/concrete entries do.
Recursive overlap queries also admit the subtree. The index now walks to the
prefix and chooses the required depth or subtree, retaining ordinal order and
bidirectional wildcard semantics. Interior wildcard queries retain the existing
predicate fallback. Dropping templates from the carried view would erase
observation labels and could let a weaker specific entry shadow source
confidentiality. Preserving the templates and indexing their query is the
smaller semantic change.

## Changes and invariants

- Per-read flow labels are memoized by document, observation class, recursive
  depth, template exclusion, and exact logical path. Every observation still
  participates in hereditary integrity intersection, including unlabeled reads.
  Payload fields named `value` stay distinct from their parents.
- Validated source envelopes, rebased views, and authoritative covers are reused
  within one preparation. Applied source writes invalidate envelope reuse.
  Backend inspection absence forces refresh; no cache survives the transaction.
  Equal deepest covers join once; link-specific root evidence is layered only
  when no deeper cover wins.
- Label coalescing joins all parts for a component/path/class once. First-seen
  atom spelling, final path spelling, component boundaries, and entry order
  remain unchanged. Repeated kept object identities skip redundant equality work
  while structural duplicates and signed zero retain their prior rules.
- Prefix indexes replace measured/derived path-collapse scans and flow-clear
  scans. A maintained shape-path set replaces repeated frozen-existence scans.
  Authored-policy overlap and generated-output path dedup use indexes/sets;
  structure-container removal compacts once instead of repeated array splices.
  Equal-depth component labels join in one batch; relevance checks reuse each
  document/read-class result within the call; no-flow target admission uses the
  same prefix predicate through an index.
- Consumed-source deduplication includes structural atom keys alongside the
  address/path key, retaining collision checks and first-seen source order.
  Clause-ceiling meet streams normalized pairwise unions through the shared atom
  deduplicator; its distinct Cartesian result remains intact.
- Refusal attribution buckets sources by structural key and still verifies
  equality. Per-read rendered-string sets preserve clause/source order and exact
  refusal text without accumulated-string scans. It remains lazy for writer-fit.
  Successful gated sinks and host release can still invoke consumed-label
  collection; that work is not globally refusal-only.
- Digest sort tiebreak hashes are memoized for one sort. The digest still binds
  written values, paths, scopes, traces, and carried views. Substituting hashes
  for values would change the canonical representation and was not done.

## Remaining bounds

The loop audit below distinguishes candidate selection from actual matching
label output. It does not establish a globally additive bound for arbitrary
policies, wildcard paths, mutable journals, or materialized carried views.
`verifyInputRequirements` still inspects the live read journal per target:
backend extension getters and mutable read metadata can change between targets,
so caching solely by journal length would break fail-closed validation. A
versioned immutable journal contract or a sound incremental aggregate could
share that inspection safely. This rules out a length-only snapshot, not every
possible optimization.

Repeated carried views can create quadratic input bytes even when each cover
lookup is fast. Before callback argument selection is corrected, the aggregate
browser ladder performs exactly `10*N*(N+1) + 1` cover checks at each measured
size. This counts repeated carried-entry occurrences, not distinct stored labels
and not an unavoidable lower bound. The generated element-only callback declares
only `element`, but the previous inference used validation defaults, treating
missing `array`, `index`, and `params` properties as allowed. That includes the
whole list in every child's arguments. The projection-selection helper answers
the actual usage question, while preserving explicit and unrestricted schemas.
The generated callback now receives only its selected arguments. Base object
properties survive schema alternatives through the existing schema-combination
helper, including structural schemas with no explicit type.

## Unit ladder

The primary grid fixes the actual journal at R reads and writes P containers
into an existing destination. It uses all combinations of R = 50/200/800, P =
8/50/200, E = 100/300/1000. Source entries cycle through one concrete
`enumerate` and three trailing-wildcard observation templates. Each preparation
mints 3P templates for P containers. An earlier fixture allowed destination-root
materialization to duplicate container stamps; it is excluded from this grid.

Fixture/transaction creation is outside the measured interval. Digest inputs are
built before the separate digest timer. Each process runs two warmups and at
least five samples; the reported value is the median of three process-level Deno
p75 values. Arms alternate B/F, F/B, B/F. All raw p75 values, Deno sample
statistics, loads, and model coefficients are in [unit.json](unit.json).
Background machine load and short diagnostic tests were not isolated, so small
timing differences should not be treated as precise causal estimates.

At **R=800, P=200, E=300**:

| Phase   | Baseline ms | Patched ms |
| ------- | ----------: | ---------: |
| prepare |      33.652 |     18.192 |
| flow    |       2.024 |      1.808 |
| digest  |       4.794 |      5.236 |

The prepare improvement is about 1.85× at that point. Logical cover checks stay
800; wildcard index queries drop 600→75 and concrete index queries 1,000→425.
Template minting stays 600 for 200 containers. Repeated source views explain why
the wildcard count follows distinct source paths (75), rather than P.

The fitted model uses normalized dimensions `r=R/800`, `p=P/200`, `e=E/1000`,
comparing `1+r+p+e` with `1+r+p+e+rp+re+pe` by ordinary least squares:

| Prepare fit               | Baseline | Patched |
| ------------------------- | -------: | ------: |
| Additive RMSE, ms         |    4.189 |   0.742 |
| Additive R²               |    0.934 |   0.987 |
| With-products RMSE, ms    |    1.416 |   0.645 |
| RP/160000 coefficient, ms |   -0.700 |  -0.521 |
| RE/800000 coefficient, ms |   -1.409 |   1.257 |
| PE/200000 coefficient, ms |   24.748 |   1.866 |

The fitted P×E coefficient falls by 92.5%; the additive model explains 98.7% of
patched preparation variance. The R×P coefficient is negative, while small
positive R×E and P×E coefficients remain. This does not meet a literal criterion
that every fitted interaction be absent, and the finite grid cannot establish a
globally additive bound. All phase coefficients are retained rather than
selecting a model that omits unwelcome terms. Separate digest latency is 9.2%
higher at this point despite the lower total prepare time; no standalone digest
speedup is claimed from this run.

A separate timer-instrumented pass measures the sum of all cover and index
calls. It includes timer overhead, discards the first two observations, and must
not be added to the natural total: overlap time is nested inside cover time. The
code instrumenter is included with the evidence.

| Instrumented phase at 800/200/300 | Baseline ms | Patched ms |
| --------------------------------- | ----------: | ---------: |
| cover                             |       1.158 |      0.384 |
| wildcard                          |       0.272 |      0.016 |
| concrete                          |       0.277 |      0.157 |

[phases.json](phases.json) includes raw observations and all six fitted models.
These short per-call timers include measurement overhead. The full prepare
timing is the appropriate overall comparison.

Construction plus realistic trailing-query counts is measured separately:

| Queries | Baseline μs | Patched μs |
| ------: | ----------: | ---------: |
|       1 |       0.549 |      0.415 |
|       2 |       1.160 |      0.722 |
|       5 |       4.862 |      1.894 |
|      50 |     327.916 |     79.834 |

These [raw results](construction.json) concern this trailing-wildcard fixture;
they do not establish a universal low-N non-regression claim.

## Browser ladder

The labeled SQLite row is selected by reference, parsed by a lift, and rendered
by natural JSX `bubbles.map(...)`; each bubble remains a sub-pattern. There is
no manual VNode rewrite. Each arm runs N=11/25/50/100 three times with rotated
size order and arm order B1/F1/F2/B2/B3/F3. Every observation uses a fresh piece
and worker. The profiler attaches to the current worker; prior runtimes are
disposed to avoid profiling an idle worker left by navigation.

The exact latency starts at the native button click event and ends at the
MutationObserver predicate that sees all N expected elements with visible CSS
and nonzero layout boxes. Pre-settling, target marking, post-click runtime
settling, and label inspection are outside this interval. `StepTimer` separately
records the host dispatch/wait duration. Label snapshots use a post-timing
settle fence. Logger action/commit totals and CFC counters are deltas; profile
samples have `prepareCfc` anywhere in their ancestor chain.

|   N | Baseline visible ms | Patched visible ms | Patched action ms | Patched commit ms | Prepared commits | Baseline CFC share | Patched CFC share |
| --: | ------------------: | -----------------: | ----------------: | ----------------: | ---------------: | -----------------: | ----------------: |
|  11 |               173.0 |              110.2 |              40.2 |              32.5 |               15 |              16.5% |              9.3% |
|  25 |               535.1 |              274.0 |              99.4 |              92.5 |               29 |              28.7% |             17.5% |
|  50 |              1197.2 |              460.8 |             156.2 |             181.0 |               54 |              44.2% |             24.7% |
| 100 |              3940.3 |              989.1 |             244.2 |             538.3 |              104 |              68.0% |             38.4% |

The fitted log–log slope falls **1.390→0.973**, meeting the requested ≤1.1 on
this ladder. N=100 opens **74.9% faster** and CFC preparation takes **38.4%** of
the profiled open, a minority, down from **68.0%**. Patched wildcard queries are
zero and cover calls one at every rung. Baseline cover calls are `10*N*(N+1)+1`;
baseline wildcard queries are `6*N*(N+1)`. Container/template minting falls from
3N/9N to 2N/6N while prepared commits stay N+4. Eliminating unused whole-array
arguments removes the quadratic carried-entry population before preparation; the
smaller prepare optimizations remain exercised by the legacy-argument unit
reproduction.

All 24 observations pass. All 12 paired snapshots match rendered text/classes,
source labels, root reported label status, stored text-slot labels, and full
resolved carried text/class views including integrity. Reference IDs/spaces are
renamed consistently one-to-one for comparison, preserving reference topology;
label types, clauses, paths, schemas, and ordering are not dropped. The first
text slot lacks an integrity atom present on later slots in both arms, so
per-index comparison matters. Root VNode stored views and bare inline target
metadata are absent in both arms; positive labels are established in root
carried references, the worker's stored text slots, and resolved carried
text/class views, not inferred from absent metadata.

Every rung also refuses the same deliberately invalid strict commit. Only the
fresh target identifier is normalized in its reason:

```text
CFC enforcement rejected commit: relevant transaction was not prepared: writer-fit confidentiality misfit for <target> at / (canWrite, §8.12.4): "cfc-prepare-messages"
```

[browser.json](browser.json) contains all raw rows, per-observation load,
profile buckets, baseline action/commit totals, exact equivalence hashes, and
representative full label snapshots. Profiling adds overhead; its window also
includes dispatch and possibly an asynchronous tail outside the exact visible
interval. The CFC share describes the whole profiled open, not a separately
instrumented instantiation commit. No universal scaling guarantee follows from
four sizes. Earlier [prepacked-row measurements](packed-browser-v3.json) are
retained as a separate diagnostic rung; their 1.085 patched slope is not the
SQL-aggregate result reported above.

### SQL aggregate and input labels

The final fixture stores N independently labeled message rows and runs:

```sql
SELECT thread_id AS id,
       (json_group_array(json(payload) ORDER BY id) || '') AS packed
FROM messages
GROUP BY thread_id
```

The SQLite driver decodes JSON-subtyped results into JavaScript arrays. A plain
`json_group_array` therefore does not satisfy `packed: string`; casting to text
retains that subtype, while concatenating the empty string yields ordinary text.
A pattern assertion checks the resulting string before opening the thread.

The aggregate's inferred column label has `observes: value`. On both baseline
and patched code, an unannotated selector/parser chain carries that policy into
selection as `followRef`, then produces unlabeled parsed bubbles. The fixture
declares the same source confidentiality clause on the parser's
`ParseRow.packed` input. This is an explicit policy on the consuming lift; the
query and selector retain their plain row schemas. The declaration restores
positive content labels without annotating pending query aliases, which would
refuse before the query result exists. No runtime propagation fix or database
guard bypass is included. The unannotated propagation difference is a separate
correctness finding, preserved in
[aggregate-diagnosis.json](aggregate-diagnosis.json).

An earlier diagnostic materialization via `INSERT ... SELECT` hit the existing
labeled-database guard in both arms; it is not used by the final fixture. The
final benchmark exercises an actual SQL aggregate, a row-reference selector, a
packed-text parser, and natural JSX mapping with the explicit consumer policy
held identical in both arms.

## Loop audit

R counts recorded reads, P written paths or link inputs, E label entries in one
document, S attribution sources, O offending clauses, and T dereference sources
in one document. D is path depth and A label atoms. Q is the number of distinct
(document, read class, path, depth/exclusion) queries; M is matching candidates.
Document-local dimensions are not constant bounds. This table groups nested
loops implementing the same operation, including `.some`, `.filter`, and helper
calls inside loops. It does not count iteration over unrelated payload
properties as R, P, E, S, O, or T.

| Operation / helper                                                                              | Cost and bound                                                                                                                          | Additive alternative / disposition                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labelForEntriesAtPath` equal-depth component accumulation                                      | E candidates plus atoms of the deepest matches per component                                                                            | Accumulates equally deep matches in encounter order and joins once per component. Deeper matches discard earlier shallower parts; singleton labels retain their original representation. The shape-template bucket remains independent.                                                                                            |
| `deriveFlowJoin` / `effectiveReadLabel`                                                         | Formerly R overlapping-entry joins; now E index construction + Q candidate joins + R accumulation                                       | Memoized by path, class, recursive depth and machinery/trace exclusion. Integrity still meets per observation; unlabeled observations still clear the meet. A recursive root read inherently consumes E entries.                                                                                                                   |
| `joinLabelValues`, `uniqueCfcAtoms`, hereditary meet                                            | Source atoms × distinct atoms on short scan; grouped structural comparisons above threshold; per-read hereditary intersections          | Repeated source-array identities and kept object references skip duplicate work. Structural equality and first spelling retained. Colliding structural keys and arbitrary entailment remain nonconstant work.                                                                                                                      |
| `collapseRedundantEntries`, `indexedEntriesAt`, `indexedEntryBelow`, `isRedundantWithDeclared`  | E × relevant declared/same-component entries; wildcard bucket can contain E                                                             | Existing concrete prefix maps reduce ordinary paths to D + M. Arbitrary wildcard overlap and clause entailment still require candidate checks; root wildcard bucket remains a worst case.                                                                                                                                          |
| `metadataAppliesToAnyPath`                                                                      | Formerly P × E on one document                                                                                                          | Two prefix indexes now test both directions in P+E construction and path-depth queries, preserving claim-only entries and excluding derived/structure origins. Wildcard fallback remains candidate-dependent.                                                                                                                      |
| `generatedOutputPathsByTarget` duplicate-path detection                                         | Formerly P² within a target                                                                                                             | A per-target exact logical-path set now retains the first occurrence in P×D; no repeated prefix copying.                                                                                                                                                                                                                           |
| `writeIsSeedMaterialization`, `writeIsPatternSetupInitialization`, structural provenance checks | Per target/schema path scans P policy inputs and their sources                                                                          | Grouping immutable policy inputs by target/path can reduce repeated scans. Writes and setup provenance have distinct authorization rules; remains open.                                                                                                                                                                            |
| `candidateSchemasByTarget`, identity/schema reconciliation                                      | P inputs × accumulated schema size; `identityForSchemaPath` scans target inputs                                                         | Repeated merges/equality checks can rescan an increasingly large schema even when the final schema is linear in P. Batched schema construction and indexed identity lookup remain possible; merge precedence and first-input semantics must be retained. Remains open.                                                             |
| `linkWritesCoverCfcAffectedPaths` / `linkWriteCoversAffectedPath`                               | P affected writes × E policy entries × link inputs for one target                                                                       | Returns a Boolean; this is candidate checking, not output materialization. Indexing candidates while preserving the three-way overlap relation remains open.                                                                                                                                                                       |
| `valueWriteTargets` forged-system-write check                                                   | P write details × recorded protected writes                                                                                             | Checks whether a recorded string starts with the document ID plus a slash. A set of all slash-terminated prefixes could share that check; splitting only at the first slash would not preserve IDs containing slashes. Remains open. Outer per-space iteration partitions writes rather than multiplying them.                     |
| `forEachFlowObservation` trace membership                                                       | R × (D + wildcard candidates on branch), plus T×D construction                                                                          | Existing PathPrefixIndex avoids R×T for concrete trace sources. Root-wildcard sources and wildcard queries retain a scan bound; this is not universally R×D.                                                                                                                                                                       |
| `ownRestampContainerPaths` / pure-link-container discovery                                      | P plus traversed written payload nodes; per-container prefix setup                                                                      | Traversal follows the written value's actual shape. Its size can exceed P; no read/write Cartesian scan.                                                                                                                                                                                                                           |
| `flowLabelWorkExists`                                                                           | Formerly R×E read-class checks on one document; write side only checks whether that document has any entries                            | Each read-class Boolean is now memoized lazily within the call. The fixed three-class population bounds entry checks by 3E per document, followed by R lookups. Self-minted documents and write-side any-entry sensitivity remain unchanged.                                                                                       |
| `storedSchemaClaimsForLinkWrites`                                                               | Schema entries × target link paths                                                                                                      | Prefix index can reduce candidate selection; remains open.                                                                                                                                                                                                                                                                         |
| `projectedSourceLabel`, exact-copy/projection requirements                                      | Each schema claim × source entries / writes used to reconstruct its value                                                               | Distinct projections may require distinct results. Shared source indexes and reconstructed-value caches can reduce scans; values and claim paths are semantically significant.                                                                                                                                                     |
| `writeDetailValueForTarget`, `changedValuesAtPatternPath`, `ifcEntryAppliesToAttemptedWrite`    | Per queried/schema path × recorded writes, plus wildcard matches and reconstructed payload bytes                                        | A write trie could cache covering/descendant writes. Overwrite order and prior-value semantics must remain; remains open.                                                                                                                                                                                                          |
| `buildWritePrefixBounds.boundFor`                                                               | Protected schema paths × write attempts in target                                                                                       | Concrete trie with subtree maximum journal positions would avoid repeated scans. Bounds must retain temporal order and wildcard conservative-prefix behavior; remains open.                                                                                                                                                        |
| `verifyInputRequirements` envelope validation                                                   | Targets × live read-journal inspection, with cached document validation                                                                 | The live journal can grow with internal reads during preparation; fallback backends filter those too. Mutable read objects and extension getters prevent length-only snapshot caching. Versioned immutable snapshots or sound incremental aggregates could remove repeated inspection; it is not proven inherently necessary.      |
| `verifyInputRequirements` gated labels and per-entry prefix gates                               | If required: R×E label resolution, then schema gates × R prefix/label checks                                                            | Gate labels are lazy and reused within one target. Distinct temporal bounds and policies can need distinct answers; indexed prefix aggregates are a broader gate redesign. No label joins are built merely for targets without a gate.                                                                                             |
| Trusted-event requirements                                                                      | UI contract entries × policy inputs                                                                                                     | Group by contract/target; remains open.                                                                                                                                                                                                                                                                                            |
| `derivePersistedLinkLabel` and source metadata/view derivation                                  | Previously P×E validation/rebasing; now document validation/index construction + distinct source paths + matching output                | Preparation-local source resolver and view cache invalidate on applied writes. Without backend inspection, refresh discards cached envelopes. A no-metadata source still probes write details for newly created source detection.                                                                                                  |
| Authoritative cover for carried views                                                           | Visits every carried entry; formerly each trailing wildcard scanned E and equal-depth merging repeatedly deduplicated accumulated atoms | Index trailing wildcard at its child depth; cache covers by validated source-view identity/path, independent of link-specific root evidence; join equally deep labels once. Root result.label is layered only when no deeper cover wins.                                                                                           |
| Carry authoritative and carried entries onto target link                                        | P × matching E intermediate entry visits when each input carries E entries                                                              | Distinct final target/path/class entries and atom bytes can require multiplicative output. Repeated entries that coalesce do not establish that lower bound. Shared cover lookup removes repeated resolution; selecting only used callback arguments removes redundant carried inputs in the browser fixture.                      |
| `collectConsumedLabel` / `noteSource`                                                           | R × matching E × contributed atoms, plus structural-key collision checks                                                                | Candidate indexes avoid unrelated label entries. Source buckets now include atom structural keys as well as address/path, preserving first-seen sources and checking equality within collisions. Used by successful gated sink checks and host release as well as writer-fit refusal attribution.                                  |
| `describeRefusalInputs`                                                                         | Key construction over S sources and O clauses, then matching buckets                                                                    | For distinct offending clauses, matched records total at most S, since each source carries one atom. Duplicate offenders can revisit matches; collisions still require equality checks. Per-read rendered-string sets remove accumulated display-dedup scans while preserving order.                                               |
| `verifySinkRequestCeilings`                                                                     | Sink policies × consumed clauses / contributing spaces                                                                                  | Consumed set computed once; distinct sink policies are different decisions. No unconditional sink work for the map reproduction.                                                                                                                                                                                                   |
| `verifyWriteFloor`                                                                              | Schema floors × link inputs / writes-under; descendant nonlink check nests written paths × matching links                               | Gate-specific, opt-in. Can index relations; arbitrary link projections and policy entailment remain. Remains open.                                                                                                                                                                                                                 |
| Flow target admission with no join                                                              | Formerly E existing entries × P writes                                                                                                  | A prefix index over the written paths now replaces the inner scan. It preserves derived/link/structure origin filtering and the independent all-label-metadata healing condition. Wildcard candidates retain the index fallback bound.                                                                                             |
| Declared re-mint / legacy confidentiality ratchet                                               | Schema entries × legacy E plus write applicability                                                                                      | Legacy migration and authored policy; no global additive claim. Shared prefix candidates possible; remains open.                                                                                                                                                                                                                   |
| Carry and clear existing flow entries                                                           | E×P covering-write test                                                                                                                 | Replaced by PathPrefixIndex over written paths. Wildcard compatibility remains the existing isPrefix predicate.                                                                                                                                                                                                                    |
| `recreatedAt` frozen existence                                                                  | Frozen E × P written paths and relative payload probes                                                                                  | Candidate ancestor index can avoid unrelated paths; presence-before/after still inspected. Remains open.                                                                                                                                                                                                                           |
| Measured / derived / structure path collapse                                                    | Formerly P²                                                                                                                             | Existing prefix trie replaces repeated `.some(isPrefix)` scans; strict-ancestor query uses parent path, structure checks ancestor-or-equal. Wildcard queries retain the trie fallback bound.                                                                                                                                       |
| Writer-fit declared ceiling and offending clauses                                               | P×declared E; P×join clauses×ceiling clauses                                                                                            | Distinct ceilings require distinct decisions; stable empty ceilings could share checks. Route-2 declarations mutate policy entries during the loop, so an immutable initial index would be wrong. Attribution O×S work only runs on rejection.                                                                                     |
| Frozen shape membership checks during stamping                                                  | Formerly P×growing E                                                                                                                    | Exact path set is built once and updated at each relevant mint, including wildcard-shape templates. The three-class mint itself is constant work per container.                                                                                                                                                                    |
| `frozenConfidentialityFor` / leftover legacy migration                                          | P×cleared E; leftover E×P to find shallowest written cover                                                                              | Candidate indexes can avoid unrelated paths; actual inherited atom output can be multiplicative. Remains open in migration/recreation paths.                                                                                                                                                                                       |
| Structure-container re-stamp removal                                                            | Formerly one scan of E per document with repeated array shifts                                                                          | Stable in-place compaction now performs one pass. One declared structure container is tracked per document.                                                                                                                                                                                                                        |
| `coalesceLabelEntries`                                                                          | Repeated label joins per equal path/origin/class caused quadratic accumulated-atom work                                                 | Collect label parts per key and join once, retain first-seen atom order and the same sorted entry order.                                                                                                                                                                                                                           |
| `canonicalizePreparedDigestInput` / `preparedDigestFor`                                         | Bytes of reads, writes, traces, policy inputs plus sorting each record family                                                           | Sort tiebreak hashes now memoized for that sort invocation. Written values remain bound, as do scope, path, temporal writes, and carried views. Replacing values with digests changes the canonical digest representation; it is not a transparent lookup optimization. Serialized policy inputs may themselves contain P×E bytes. |
| Canonical label/view sorting and normalization                                                  | E log E and clause normalization, plus payload bytes                                                                                    | Input-size work; identical immutable substructures could share normalization under an explicit identity contract. No cross-dimension scan introduced by sorting alone.                                                                                                                                                             |
| `cfcConfidentialityForObservationNode`                                                          | E view entries per queried node, plus matching atoms                                                                                    | Public helper used outside preparation too. Repeated node queries over one immutable view can share a path index; no index is added here.                                                                                                                                                                                          |
| `atomsOutsideCeiling` / `cfcObservationFitsCeiling`                                             | Observed clauses × ceiling clauses × subsumption work                                                                                   | Decision/offending-subset output, not Cartesian output. Exact normalized-clause indexing can accelerate equality cases; OR subsumption and commitment-aware matching require their semantics. Remains open.                                                                                                                        |
| `cfcIntegritySatisfiesFloor`                                                                    | Required integrity atoms × available integrity atoms                                                                                    | Exact atoms can use structural-key candidates; pattern/concept entailment needs semantic matching and trust resolution. Remains open.                                                                                                                                                                                              |
| `cfcIntegritySatisfiesFloorCoherently`                                                          | Required atoms × contributing reads × actual atoms, plus witness intersections                                                          | Every requirement needs one common concrete witness across reads. Independent per-read success cannot replace that requirement. Precomputed witness candidates may reduce repeated matching; remains open.                                                                                                                         |
| `meetCfcObservationCeilings`                                                                    | Pairwise clause unions and normalized-result deduplication                                                                              | The distinct result can contain the Cartesian product. Normalized unions now stream through the shared atom deduplicator, avoiding the additional accumulated-result scan except within structural-key collisions.                                                                                                                 |
| `deriveLabelMetadataTemplateEntries`, cross-space representation, manifest discovery            | Final/intermediate entries and nested atom bytes                                                                                        | Template generation copies source labels into generated templates. Shared immutable labels may avoid rescans; distinct serialized bytes remain bound. Manifest installation already deduplicates policy digests per target.                                                                                                        |

The audit does **not** establish an additive whole-pass complexity bound. It
identifies both remaining avoidable cold-path scans and bounds tied to mutable
journals, arbitrary policies, or materialized label bytes. The implementation
addresses the measured dominant preparation paths; a globally additive
whole-pass bound remains unestablished. The measured browser scaling and
CFC-share targets are reported above.

## Reproduction and validation

The fixtures and benchmark sources are checked in under `packages/runner/test/`
and `packages/patterns/integration/`. Run from a Labs checkout:

```sh
deno test -A packages/runner/test/cfc-prepare-reproduction.test.ts
deno bench -A --json packages/runner/test/cfc-prepare-exact-ladder.bench.ts
deno bench -A --json packages/runner/test/cfc-trailing-cover.bench.ts
CF_CFC_PREPARE_LADDER=1 CF_CFC_PREPARE_OUT=/tmp/cfc-measurement deno task integration patterns cfc-prepare
```

Use `CF_CFC_PREPARE_DIAGNOSTICS=1` for per-prepare reproduction counts. Browser
`CF_CFC_PREPARE_REPS`, `CF_CFC_PREPARE_START_REP`, and `CF_CFC_PREPARE_SIZES`
select the repetition/size schedule. Compare before/after with the same fixture
and the same compilation environment. The baseline is `e19441a38e` plus
[measurement-only hooks](baseline-instrumentation.patch), with the new benchmark
and integration fixture files copied in. Those hooks do not contain the
optimization.

[instrument-phases.py](instrument-phases.py) adds timers in a disposable copy of
either arm. Run its exact ladder there, never use instrumented totals as the
natural preparation latency, and do not sum nested buckets. [fit.py](fit.py)
recomputes the least-squares fits from the included raw evidence.
[compare-browser.py](compare-browser.py) compares rich per-element snapshots
while normalizing reference identities consistently. Large raw CPU profiles
remain in the local `/tmp/cfc-round2-browser-*-v4` directories; compact profile
buckets are retained in `browser.json`.

Focused tests pin generated wildcard/concrete prefix equivalence, literal
`value` fields, mutable metadata invalidation, deepest-cover precedence,
coalesced atom order, signed zero, refusal attribution/order, ceiling-meet
semantics, and digest value binding. List inference tests cover explicit,
legacy, unrestricted, referenced, and alternative schemas. Browser assertions
and paired full snapshots cover all four sizes and strict refusal wording.

The independent read-only review found no blocking correctness issue in the CFC
changes or callback selection. It corrected output-size overclaims in the audit
and identified the remaining refusal/source dedup scans, which were then removed
and tested. It also reviewed the final component-join, relevance-cache, and
target-admission changes. The aggregate browser recordings include all final
runtime changes.

Repository validation passed: the full runner suite (1,432 tests and 10,142
steps), the patterns package suite (65 tests and 251 steps plus its browser
case), root type-check (423 paths in 46 groups), repository formatting and lint,
all 602 documentation code blocks, history-index validation, package cycles,
conflict markers, and control characters. After the last three audit changes,
six focused CFC suites passed with 105 steps and type-checking. The full runner
run had already passed its CFC files before those final edits; the focused rerun
verifies their final state.
