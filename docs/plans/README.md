# Plans

Implementation plans that have not been fully executed. A pending plan is
live documentation: keep it accurate as the work proceeds (check off stages,
record scope changes).

When a plan has been executed or abandoned, it stops being a plan and becomes
a record: archive it to `docs/history/plans/` following the procedure in
[`../README.md`](../README.md).

## Current plans

- [Security and privacy roadmap](security-privacy-roadmap.md) gives an overview
  of current trust boundaries and the path from runtime security to operator
  exclusion, with remaining work and technical references in an appendix.
- [Discovering Loom resources with wish](loom-resource-discovery.md) proposes
  publishing existing database and companion-cell references once per Loom
  environment, with a staged person-inbox migration and compiled integration
  acceptance gates.
- [Revising a piece's source from an agent session](piece-revision-from-a-session.md)
  covers the two `pattern-author` tools that revise a piece someone already
  has — a handle-addressed read of its current source, and a direct edit
  through the runtime's own compatibility check and setup transaction — what
  they lean on rather than rebuild, and the two questions left open: whether
  revising is really `run_pattern` with a target, and what to do about an
  agent retyping a whole pattern for a one-character mistake.
- [View-scoped client replication](view-scoped-client-replication.md) tracks
  rollout, recovery, and adversarial verification of active-view delivery and
  guarded speculative computation. It separates execution demand from delivery
  and stages document selection before optional field projections.
- [cf-harness task research and composition](cf-harness-inbox-reliability.md)
  adds a `research` service that reads documentation and indexed source,
  prepares a usable implementation kit for every task, and supports tested email
  components that authors can compose.
- [Interaction cost in the unified inbox](person-inbox-interaction-cost.md)
  records the runtime work behind a thread open that cost 1482 ms paced and
  10.7-19.5 s against five people's data: the per-read prefix scan over a
  document's dereference-trace sources, the schemaless result pull a child
  instantiation registers, and the authoring rule that a display cap bounds the
  render and not the transaction. It carries what was disproved with what
  landed, and the one item still open — a session that settles at ~800 ms after
  roughly twenty clicks, which is waiting rather than compute.
- [Topics computation cost and live upgrade](topics-computation-cost.md)
  sequences shared backlink lookup, incremental mention maintenance, topic
  summaries, measurement gates, and rehearsed upgrades of populated boards.
- [Cast-free patterns](cast-free-patterns.md) sequences shared type and API
  repairs, migration of authored patterns and their tests, and enforcement
  through lint and new-source admission.
- [Acquiring skills from the open internet](external-skill-acquisition.md)
  splits discovery from acquisition against a public skill registry: the
  registry answers what exists, a digest-verified `.well-known` entry or a git
  commit SHA answers for the bytes, the text loads by handle into a child the
  chooser never reads, and a split-mint provenance mark records where it came
  from without declassifying anything.
- [Collection naming: the first customer](collection-naming-topics.md)
  builds [Naming in collections](../specs/collection-naming.md) on a parallel
  exemplar board — a naming library, a member namespace the CLI and the shell
  resolve as `top/42`, and `#42` in the editor — proven against the Topics
  shape by a test-only board, and grafted onto Topics once, at the end.
- [`cf view` language and syntax coverage](cf-view-language-coverage.md)
  orders the remaining language, data, build, and configuration formats needed
  for honest coverage of the active organization repositories.
- [cf-harness Codex subscription authentication](cf-harness-codex-subscription-auth.md)
  tracks the remaining shipping gates after the core implementation.
- [CFC exchange-rule authoring](cfc-exchange-rule-authoring.md) tracks the
  remaining owner decisions and blocked stages for exchange rules.
- [CFC llm-sink admission](cfc-llm-sink-admission.md) tracks the
  boundary-scoped admission mechanism the max-enforcement posture names as
  pending for its llm sinks: public-only ceilings paired with class-scoped
  exchange rules, the llm sink class those rules need, and the owner decisions
  on which authority and which caveat tiers admit content to a model.
- [CFC TypeScript authoring](cfc_typescript_authoring.md) sequences the
  TypeScript and JSX authoring surface for CFC metadata.
- [`cf-code-editor` co-presence](cf-code-editor-copresence.md) adds an
  ephemeral Cloudflare WebSocket plane for live participant names, carets, and
  selections while Memory remains the sole authority for document contents.
- [First-class serializable factories](first-class-serializable-factories.md)
  sequences the implementation of durable pattern, module, and handler
  factories.
- [Hosted pattern authoring](hosted-pattern-authoring.md) sequences the shared
  server operation and the piece menu, Home, and `cf` entry points for changing
  a piece or creating a space from a request.
- [Developer-tooling feedback for hosted authoring](hosted-pattern-authoring-tooling-feedback.md)
  adds a separate, non-blocking way for an authoring agent to report missing or
  defective development capabilities.
- [Ingest channels and the journal sink](ingest-channels-journal-sink.md)
  proposes a minted, bearer-authed inbound endpoint that accumulates what it
  receives as a provenance-marked, append-only log — the shared capability
  behind webhooks, beacons, and any source with no runtime of its own. It
  builds on the split-mint seam in
  [`../features/vouched-ingest-channel-mint.md`](../features/vouched-ingest-channel-mint.md).
- [Integration-test video demos](integration-test-video-demos.md) tracks
  optional CI adoption and further fixture hardening.
- [Lazy cell materialization](lazy-cell-materialization.md) sequences a
  schema-observing lazy view over a cell, a transaction mode that hands one back
  from every read, and the runner disposition for a reader that touches data the
  schema no longer describes.
- [Stream markers out of stored data](stream-markers-out-of-stored-data.md)
  moves stream-ness out of the stored `{ "$stream": true }` value and into the
  link schema and the module wrapper, and triggers the cold-start repairs on a
  structural mismatch instead of the missing marker. It names putting the
  owner into a stream's address as the follow-up it is written toward.
- [Pre-syncing from node plans](presync-from-node-plans.md) makes one
  derivation per pattern node serve both instantiation and the pre-sync, so a
  resume and a fresh start name exactly what each lift, handler, builtin, and
  nested pattern reads under their declared read schemas, then holds each
  node's first run on the loads it named instead of on a space-wide timer.
- [Making pattern computation cost declarable and visible](pattern-computation-cost.md)
  pairs two repairs to the same gap: the collection algebra has incremental
  `map`, `filter`, and `flatMap` but no `groupBy`, keyed lookup, join, or
  incremental `reduce`, so a group-by is written as nested scans over a
  reactive array; and a scheduler node records how often an action ran but not
  how much it read, so the cost is invisible until somebody profiles. Carries
  the access counter, the missing operators, the replication failures that
  currently push authors off the incremental path, and the authoring guidance
  that steers them into the expensive construct.
- [Choosing which tests a pull request runs](pull-request-test-selection.md)
  replaces the sixty-seven pull-request jobs with five, each running a subset
  chosen from what the record store knows about which tests have caught real
  regressions, and packed to finish inside five minutes. It carries the
  repository-side topology that lets a new test surface be registered once
  and picked up by both the full run and the selection, the scoring, flake
  and packing rules, and the two things a subset breaks and this replaces:
  coverage becomes a trend rather than a gate, and a regression that only
  `main` catches is reported back to the change that introduced it.
- [Memory `apply-op`](memory-apply-op.md) sequences the editor-neutral
  collaborative-field substrate, the first CodeMirror codec and editor
  integration, and the checkpoints and review gates required before a future
  WordGard codec.
- [Seed: codeless graph rebuild](codeless-graph-rebuild-seed.md) records,
  for a parked arc, the facts that make a running piece's graph durably
  reconstructible from scheduler state and module-addressed code — the
  recovery class the 2026-08-27 keyless close-out ruled out of contract.
- [Server-primary execution v2](server-execution-v2.md) sequences the
  greenfield rebuild that executes the server-side-execution v2 spec, with
  per-phase task and success-criteria checkboxes. Its
  [stage-C design](server-execution-v2/stage-c-design.md) is the
  reconciled design + build work order for the design build stage
  (demand as the memory server's tracked-ids closure with the demand
  walk deleted — the structural walk demoted to fallback — the client
  intent listener, the ruled double-dispatch implementation, the
  acceptance and the owner ruling set); it archives beside the stage-C
  closeout when that build lands.
- [Scheduled work in the server](scheduled-work-in-the-server.md) proposes the
  simpler form D12 said bgUpdater would come back as: a pattern declares the
  cadence it wants to wake on, and the space's own serving runtime honors it,
  so background work stops needing a separate process anyone has to run and
  keep online. Waking a piece on a timer with nobody watching is the one thing
  the background piece service does that the executor does not, and the ruling
  accepts that capability lapsing in the meantime — nothing depends on it, so
  nothing is broken while it is gone. Three separable parts: the replacement,
  the already-ruled deletion, which waits for nothing here and has a worked v1
  inventory to read, and compute accounting, which neither of the others
  depends on. The replacement rests on a further ruling, because a
  scheduled wake would be the second issuer of warm demand where the spec pins
  the count at one.
- [Revision-keyed schema memo](revision-keyed-schema-memo.md) designs a
  cross-evaluation, per-document memo of schema-walk computation on the
  memory server, keyed by each document's revision so validity needs no
  invalidation machinery, sitting under the query evaluation cache to make
  post-commit and cross-shape evaluations cost what changed instead of the
  whole corpus. Carries the measured baseline and the staged path to a
  per-revision snapshot cache.
- [Retention and CFC execution provenance](retention-and-provenance.md)
  sequences how long an invocation record is kept and what the runtime knows
  about who caused it — the `AgentActor` mint, trusted ingress, and metadata
  confidentiality. Gated on a CFC review that has not happened.
- [Random space identities](random-space-identities.md) gives every newly
  created space a fresh random identity whose authority ends after ACL genesis,
  while every space that already exists keeps its DID and the name that reaches
  it. It implements the
  [random space identity specification](../specs/random-space-identities.md),
  uses existing DID routes, and is complete without a public name registry.
- [CFC runner implementation](runner_cfc_implementation.md) defines the
  commit-boundary enforcement workstreams and rollout.
- [Finishing the piece source lifecycle](piece-source-lifecycle-completion.md)
  compares the lifecycle spec against the repository and orders the remainder
  as four pull requests in two tracks — what a revision records, and how a
  learned route persists.
- [Bulk piece operations](piece-bulk-operations.md) designs retargeting,
  repairing, and rolling back many pieces as one reviewable, resumable
  operation over a shared plan — with batching as an execution strategy
  underneath rather than the subject.
- [The Topics verb surface](topics-verb-surface.md) sequences how the Topics
  board and topic grow their verbs without breaking the pieces already holding
  data: the shape the board demands of a stored topic, the one rehearsed break
  that narrowing it needs, and the items waiting on platform work.
- [`cf space clone` rehearsal](space-clone-rehearsal.md) records the design for
  rehearsal-grade copies of populated spaces. The tooling has shipped (`cf
  space`, `cf inspect churn`); the operating procedure lives in
  [`../development/space-clone-rehearsal.md`](../development/space-clone-rehearsal.md).
  The plan stays live until the practice has been exercised on a real
  migration.
- [Reading Fabric data](fabric-read-model.md) is the umbrella for one model
  across three concerns: everything addressable is a cell, so a verb's result
  and a direct read are the same operation on different cells. It carries the
  vocabulary and points at
  [shaped reads and verb results](shaped-reads-and-verb-results.md) — the shared
  read layer, how a shape says "an address here, a value there", and what
  calling a verb adds — and at
  [CLI surface shape](cli-surface-shape.md) for the command surface and an
  additive path to it. Start here rather than at either part.
- [References as arguments](references-as-arguments.md) proposes lifting
  address resolution out of the LLM dialog builtin, which already does it, and
  into the boundary every external caller crosses. An LLM and the CLI can
  hand a pattern a reference — the CLI in both spellings, converting the
  emitted address against the declared contract at its dispatch gate — while
  the webhook and ingest paths still forward a payload unresolved. It carries
  the measurement, the size, and the gate-by-gate evidence that the remaining
  refusal is drift rather than policy. The ruling it was once gated on is
  executed and archived:
  [the verb input contract](../history/plans/verb-input-contract.md).
- [Designing verbs so they can change](verb-evolution.md) records how verbs are
  declared so that adding to and changing them later is possible: verbs are
  promises and their names are stable by default — an owner may break their
  own pattern deliberately, so what a caller holds is a commitment rather than
  a guarantee — a holder declares only what it uses, an optional member's
  maybe is resolved once at binding, and an output change gets a new verb
  name. It states what the update gate enforces today, what
  the transformer and authoring tools should carry so a one-off author never
  has to learn a rule, and the open stream — named versioned interfaces,
  per-piece upgrade policy, migrations that run code — that everything else
  stands as the interim for. Written to be followable by anyone on the team,
  not only by pattern authors.
- [Verb calls: working notes](verb-result-selection.md) holds the call-specific
  investigation those documents do not carry: what produces a receipt and what
  its existence proves, how a receipt's address is derived, and the error and
  exit-status conventions. Sketches to draw from, not a settled contract.
- [Verbs — implementation plan](verbs-implementation.md) sequences the remaining
  work on verbs across both arcs that produced it: what a verb declares, what a
  caller may ask for, and what comes back. Read it for order; read the designs
  it points at for reasoning.
- [Shuttle — a place-aware fabric shell](shuttle/README.md) is the working design
  state for an interactive terminal tool: a REPL whose prompt carries a
  mutable current place — the context that fills in the omitted levels of the
  fabric's right-anchored references — plus full-screen live views, for
  inspecting and editing space and piece state. Decisions so far and open
  questions; construction is under way, in the order its
  [build sequence](shuttle/build-sequence.md) sets out.
- [Shell completion coverage](cli-completion-coverage.md) sequences the work
  that makes `cf completion` answer correctly across the surface it claims and
  reach the verb surface it does not: the slots that offer a wrong candidate,
  the verb flags and result shapes that offer none, the source `--space` needs
  before any of it is reachable by name, and the gate that keeps completion
  from falling behind the command tree again.
- [Handler-callable egress](handler-callable-egress.md) records the capability
  a pattern does not have: a network request a handler can issue and await,
  which the runtime records and gates the way it records and gates a node
  factory's request. It carries the shape of program that has no home without
  one, the two routes a design could take and what each gives up, and the
  provider-side stack left standing in the meantime.

## Concepts not planned for deployment

These documents retain implementation detail for designs that may be evaluated
again. They are not scheduled work and are not dependencies of current plans.

- [Space name registry](space-name-registry.md) describes a possible
  implementation of the DNS namespaces, ASP redirects, registered targets, and
  displayed-name selection in the dormant
  [Common Fabric URL](../specs/fabric-urls.md) concept. It remains independent of
  space identity creation.
