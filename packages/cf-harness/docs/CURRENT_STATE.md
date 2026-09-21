# cf-harness Current State

Status: current implementation reference\
Last verified: 2026-09-21\
Revision: `3a315a91f6+pending-captures`

The [system map](system-map/README.md) moves in lockstep with this current-state
reference.

`cf-harness` is an experimental but product-integrated Common Fabric agent
runtime. Loom is its first product adapter and Pattern Factory is its first
multi-phase orchestration adapter.

## Architecture

The runtime has four main boundaries:

1. The caller supplies prompt-slot roles, model and gateway configuration,
   tools, child profiles, mounts, resource bounds, skills, policy mode, and
   optional structured-result schemas.
2. The prompt loop performs bounded turns through the selected model provider
   and invokes only the configured tool/profile surface.
3. Most tool execution uses Docker with a configurable runtime, normally
   `runsc-cfc`. The browser child is a constrained host-adjacent profile whose
   typed `browser` tool the harness binds to a leased local CDP endpoint itself.
   The optional `run_pattern` tool is a distinct trusted-host path whose Fabric
   identity stays outside Docker and whose authority is constrained to one
   configured space. The agent result writer is a second such path, invoked by a
   host caller rather than by the model, writing a run's structured result into
   that same space.
4. The artifact store records run state, the model-facing transcript, a sibling
   record of the omission rules and full-artifact locations applied to each tool
   result, reports, capability and policy snapshots, tool outputs, child
   references, skills provenance, and optional product run manifests. The
   omission record carries no withheld values and is read only for retrospective
   display and audit accounting. The store also records the per-cell CFC labels
   the run's space holds for the cells the run touched — the one artifact a run
   does not write out of its own knowledge, read back from the space so a reader
   working from the tree alone can see what a cell is labelled.

The Common Fabric runner or another trusted mediator owns authoritative CFC
meaning. The harness transports prompt-slot and invocation evidence, applies the
selected exposure/side-effect policy, and records its decisions. It does not ask
the model to make policy decisions.

## Supported surfaces

The current package provides:

- a console operator snapshot at `GET /api/health/detail`, retaining launch
  decisions for all connector grants and refusals alongside independently cached
  Docker and index observations, with deciding records, timestamps, causes, and
  remedies; unknown observations remain distinct from failures, and reading the
  route never waits for a live probe;
- durable Loom composition, exact inspection, and bounded receipt recovery over
  an explicitly configured host command transport; current-turn console results
  include verified authored Loom receipts and the submitted origin. See
  [Durable Loom authoring](LOOM_AUTHORING.md) for authority, custody, and retry
  contracts;
- read-only Loom retrieval — search, page discovery, inspection, and reads,
  person resolution, calendar events, ambient context, and the profile — over
  the same kind of host command transport, every row measured against the run's
  observation ceiling before it enters model context. A row loom returns without
  a label is given the query's label, an assumption the implementation profile
  publishes as a deviation. See [Read-only Loom retrieval](LOOM_RETRIEVAL.md);
- batch CLI execution with bounded model turns and optional streamed events;
- machine-readable capability discovery with `--describe-capabilities`;
- persistent provider configuration and structured config/auth control, with
  durable bounded Codex refresh health;
- workspace, Fabric, and explicit host mounts with path containment;
- sandboxed shell, file, image, web-fetch, skills, edit/write, and delegation
  tools;
- one child at a time through `default`, `browser`, `web_fetch`, `web_search`,
  and `pattern-author` profiles, beside a bounded private `research` loop that
  no delegation may name;
- Common Fabric implementation research over the operator-provisioned docs and
  skills corpus, published pattern metadata and complete multi-file source,
  dependencies, and safe handle shapes. Fresh CLI root tasks and interactive
  sessions without retained research start with an `orient` pass before the
  first parent model turn, subject to the ordinary tool policy. Later chat turns
  reuse the findings and let the parent request targeted follow-ups. A durable
  checkpoint retains its host-supplied handoff immediately before the task and
  recovers it without another private call on resume. The handoff carries the
  research result identity, so the sibling omission record retains a proven
  `/researchRecord` join to the raw artifact while recording no location for a
  source-free error; no private record enters parent context. Delegated children
  consume the inherited findings and start no opening pass. `orient` establishes
  a useful approach from available data and composable pieces; `answer` resolves
  a follow-up question in the context of the current user goal. Both can inspect
  indexed source and return optional examples within eight model turns,
  twenty-four calls, and 96,000 read characters. Private tools return matching
  passages, paginated document outlines, and batch section reads with exact
  continuation. They cannot execute, write, browse, delegate, or mutate Fabric.
  The host verifies indexed source identities, admits citations and successfully
  described handle bindings, and returns a structured complete or incomplete kit
  with a full invocation or source recipe when one is required. Docs retain
  document titles and ancestor headings; search supports a path prefix to focus
  on the relevant guide. Section selectors and citation ids are distinct; a
  current-read catalog supports synthesis and at most one tool-free citation
  repair within the existing model-turn budget. Unread ids remain inadmissible.
  Invocation objects are host-serialized to JSON, match the shared `run_pattern`
  input contract, and select an inspected identity. Rule and example citations
  close over the kit's exact source catalog. Every metadata or source read
  respects the 32,000-character read limit; oversized metadata is refused before
  pattern admission. Complete pattern-source examples receive a host-side
  syntax-only parser check; exact parser diagnostics keep a claimed-complete kit
  incomplete while preserving its full source and citations for local
  correction. Parser success does not establish imports, types, compilation, or
  runtime behavior. Each result separately carries a CFC projection: its full
  known source label, a confidentiality-only output label for later model
  context, and explicit missing-label coverage for unclassified pattern-index
  metadata/source, unavailable handle-label metadata, or legacy research
  summaries. Documentation search accounts for unselected leads that influenced
  ranking. Publication never promotes private indexed source to public, and
  retained source integrity does not endorse a model rewrite. Opening handoff,
  resume, and delegated-child paths preserve the confidentiality influence and
  diagnostic projection. Exact handle-label acquisition returns availability
  independently of its fail-closed restriction. Model projection has one owner
  across tool, reconstructed opening, and child handoffs: free text is scrubbed,
  raw schemas stay in artifacts, and exact import identities and source/CFC
  records remain usable. The audit and omission writer share the same
  tool-or-host result provenance reader. Exact reads and the complete private
  transcript remain in the tool artifact; the caller receives the derived kit
  plus explicit incomplete-kit guidance. Partial evidence survives malformed
  output, provider failure, budget exhaustion, and cancellation, with private
  usage and failure counts included in the parent record. Context selection
  retains the latest orientation and two answers. Private follow-ups receive
  selected findings and source locations without copying prior examples or
  bindings. Interactive sessions persist that context, the original user goal,
  and full CFC influence with completed history. Follow-ups retain that goal
  alongside the current request; old bindings remain historical. Child handle
  transfer reads only selected current bindings; its inherited CFC context
  retains the full parent influence even when no kit is selected. Kits and
  confirmed records persist through delegation, while local authored-source
  artifacts record the research ids that shaped them. `query_docs` is accepted
  only as a legacy CLI or persisted-policy alias and is normalized without
  rewriting old transcript or run-state evidence;
- caller and profile return-schema definitions checked before child creation,
  with bounded argument errors for malformed contracts and unresolved
  references; valid child results remain schema-validated and sanitized, with
  raw evidence retained outside the ordinary parent return channel;
- image inputs and structured top-level batch results;
- a skills registry over `--skills-root`, defaulting for a run out of a labs
  checkout to that checkout's own `skills/` tree, with the resolved tree and its
  source recorded in run state and printed in operator output; skill preload by
  name, indexed reads of `SKILL.md` and supporting resources, and Deno/Bash
  skill scripts run in the sandbox where the operator allows them —
  `--allow-skill-scripts` for every skill the run holds, registry and acquired
  alike, or an exact entry for one. The same execution path takes an acquired
  skill's script, checked against the digest taken at acquisition; the tool
  output and the execution record carry that acquisition in place of the
  registry digest fields, and the invocation is labeled with confidentiality
  alone, because a non-empty `integrity` array in `cfcInputLabels` makes the
  sandbox fail to start (CT-2302);
- recoverable rejection of a malformed tool call: a name no tool answers to,
  arguments that are not a JSON object, or a `delegate_task` argument of the
  wrong shape comes back as a `cf-harness.invalid-tool-call` tool result naming
  the field and the shape expected of it — never the value it rejected — and the
  run carries on; the call is recorded as a policy decision with the outcome
  `invalid` rather than `denied` — nothing about policy refused it — plus a
  `not-run` tool activity and an `invalid_tool_call` failure record. Only what
  the model cannot correct — transport, engine invariants, artifact persistence,
  cancellation, the turn cap — ends the run. A run-owned cancellation is
  recorded as `canceled` in parent and active-child artifacts, with its reason
  and without adding a failure record;
- a release a confidentiality boundary refused is recorded as a policy decision
  with the outcome `withheld` rather than `denied`: the call ran and answered
  with the reference to the result whose values were held back, so the trace
  counts it in its own bucket, and the console renders the step as the success
  its answer states with a withheld marker beside the CFC line. `denied` names a
  call that did not run;
- transcript-based resume and durable run artifacts, with retrospective omission
  joins kept outside the transcript and provider context;
- server-side Responses context compaction with a default threshold derived from
  the model's input budget, an explicit override/disable control, retained
  compaction evidence, and tool-call/result-safe transcript pruning;
- per-turn and aggregate token/cache usage in run reports, operator output,
  batch metadata, and interactive turn-completion events;
- stable interactive prompt-cache affinity, configurable reasoning effort, and
  opt-in GPT-5.6 gateway cache controls; the ChatGPT/Codex subscription backend
  uses implicit caching because it rejects the API `prompt_cache_options` field;
- interactive NDJSON stdio sessions with optional SQLite session, turn, event,
  replay, cancellation, and restore state; a session's durable transcript
  normally advances at a completed turn. On failure, the Loom host can retain
  the last resumable checkpoint (a validated complete batch or opening handoff),
  atomically with its matching research/CFC state and omission provenance.
  Unpaired work, cancellation, and interrupted activity stay on the audit trail;
  turn-local budget notices stay in audit artifacts and are excluded from
  resumable history; a completed turn's history is checked before it is
  promoted, and promotion commits with the completion or not at all; and a
  restored session whose recorded history does not pair its tool calls with tool
  results preserves that history and adds explicit unknown-outcome results for
  missing results, while orphan results and duplicate call IDs refuse the
  session locally rather than sending malformed history to a provider; and a
  listener that cannot take an event is reported to the host as a delivery
  failure and does not change the outcome of the turn that produced it;
- CFC modes `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`,
  plus prompt-slot, invocation-context, policy-event, and model-influence
  evidence;
- parent-only `finish_task` for a question or a give-up reason, admitted through
  ordinary policy and artifacts as the sole call in a model turn. It ends the
  loop without another provider request, retaining the completed lifecycle and
  reusable conversation. Reports carry the canonical task outcome; console
  polling and SSE carry the same outcome, session identity, and current
  continuation availability. The live pane renders the question or reason.
  Children report blockers to the parent. Missing-input discovery distinguishes
  released evidence, absence within an enumerated granted scope, and unknown
  reads; it stops for input rather than repeating author delegation. Shared
  target-selection guidance asks for an unnamed, unattached piece without a
  registry read and preserves established conversation targets. The parent
  resolves a user-supplied slug with `resolve_piece` before author delegation,
  using the input-cell path's exact-address resolver and space restriction. Only
  an opaque handle returns; source remains child-only. An unheld slug or a
  readable target that is not a usable piece returns recoverable `not-found`. A
  failed read returns `unavailable` and does not establish absence. A display
  name without a slug permits at most one registry lookup; only a unique
  released match allows work to proceed;
- a session-local address handle table: deterministic `cfh:a:` tokens minted per
  run for cell addresses, recorded in `run-state.json`, and carried across
  resume; the prompt loop swaps addresses to tokens in model-bound tool output
  and resolves tokens in model-authored tool arguments before policy evaluation
  and dispatch, `delegate_task` arguments excepted;
- cross-agent handles: a delegation seeds the child's own table with a verbatim
  copy of every parent entry whose token the `goal` or `context` names, and
  nothing else, so a child resolves exactly the references the delegation handed
  it while the tokens stay identical across the hierarchy; a reference the child
  produces is resolved through the child's table and minted through the parent's
  boundary, reaching the parent as a parent-resolvable token, and any
  token-shaped text still standing after that resolution is scrubbed to fixed
  inert text so it cannot resolve later in the parent's own table;
- skill by handle: `delegate_task` takes an optional `skillHandle` naming a cell
  whose string value is skill text for the child, materialized trusted-side at
  child spawn under `resolveHandleValue`'s contract (table membership,
  string-only, same-space-only, structured refusal before any child exists) and
  injected as a `<skill_context source="handle:<token>">` block beside the
  profile preload; it bypasses the registry — no resource index, name-based
  selection retired for the delegated path — and the child's activation records
  `source: "skill-handle"` with the token and the digest of the injected text.
  Where the handle came from an acquisition, the context header carries its
  `pin="owner/repo/slug@<commit sha>"` for `run_skill_script`, and the child
  mounts that one skill's acquired scripts read-only at `/acquired-skill` and no
  other skill's, in a sandbox of its own built from the parent's configuration
  plus that mount rather than in the parent's shared one;
- pattern references by trusted record: `delegate_task` takes up to eight
  optional `{ patternId, note? }` entries and resolves each id only from the
  records that run already holds — successful `search_patterns` results retained
  by that parent run and restored from its persisted transcript on resume,
  together with the patterns the task itself attached. A known id contributes a
  neutral child-context block containing the trusted record's kind and quality
  where the record carries them, its description, match evidence, import hint,
  argument shape, result shape, and the parent note verbatim; an unknown id is
  omitted and named in `patternRefRefusals` as `not-searched-by-parent`.
  Delegation does not refetch the index;
- pattern references attached to a task: a run may be configured with up to
  eight published pattern ids, which it resolves through the index's
  `getPattern` before its first model turn and seeds as searched hits, so the
  run names them with no search. The id is the whole of the reference — the
  content-addressed identity of published source — and a value outside that
  grammar is refused by the surface it arrives at, while an id the index does
  not hold fails the run, naming the id, rather than running without what the
  caller attached. The seeded record carries what the index answers for the id
  and nothing else: a reference grants what a search hit grants, which is to
  compose that source by identifier;
- shape captured where it is free and read back by token: a handle entry may
  carry the schema of its referent — a `run_pattern` result reference records
  the compiled pattern's result schema, marked `schemaSource: "harness"` — while
  no mint takes a schema off the reference it is handed or reads a cell to fill
  one in, so an entry without one is one whose shape was never free to capture
  and is answered from the fabric instead;
- a `describe_handle` tool, available in any run that has handles: given a token
  it reports the shape of the referent and its path segments, never the value,
  and reports an unknown token as unknown rather than as an error. The shape is
  what the referent declares in the session's fabric when the run has one — a
  piece's document schema is the result schema of the pattern behind it, which
  is what an agent building over that piece needs — and otherwise the
  harness-derived schema the mint recorded. Whatever the source, the reported
  schema is rebuilt from an allowlist of structural keywords at every depth, so
  `const`, `enum`, `default`, `examples`, and free-text annotations never leave
  the tool. Property names do cross, since code cannot be written over data
  without them, so they are bounded in count and length and the model-facing
  reply is scrubbed of bare fabric identifiers at every depth, keys included. A
  referent that declares no schema and whose value is a SQLite database handle
  reports `database` instead: its tables, one property per table whose own
  properties are that table's columns with their types, reduced by the same
  allowlist, and one label entry per column that declares an `ifc`, addressed by
  table name and column name. Beside those it reports `fill`: per table the rows
  it holds, and per disclosed column how many of those rows are non-NULL there,
  so a column filled on no row is visible before a query filters on it and comes
  back empty. A table that could not be counted reports `unread` rather than
  zero, and a run whose storage provider offers no query reports no `fill` at
  all. That is the one place the tool reads a value, and it is conditional on
  nothing being declared — a database's tables are the contract it was created
  under, its rows are in the database file, and nothing here opens one; a count
  is taken of a whole table and of whole columns, never under a caller's own
  predicate. Disclosure is permissive and fixed rather than configurable — no
  setting narrows it — and is bounded to addresses in the session's own space;
  that bound is on the handle's own address rather than on everything the
  document reaches from it. Answering from the fabric establishes the run's
  fabric session despite the tool's `read` effect class;
- bounded request-attribution headers on OpenAI-compatible gateway traffic,
  using persisted operational provenance rather than request content or personal
  identifiers;
- content-addressed snapshots for in-run `view_image` observations, while
  run-start images remain source-integrity-locked;
- a host-side agent result writer (`writeAgentResult`, exported from the package
  root) over the same fabric session, for a caller that runs the harness on
  behalf of a pattern's agent request: it validates a run's structured result
  against its schema, writes it as one document in the session's space, and
  returns a link to it. Every handle the result names at a value position
  becomes a link, `asCell` position or not; a property name is held to the same
  ownership rule and stays text, since a name cannot hold a link — a cell handle
  to its cell, a non-cell referent the run observed (a Loom row, a SQLite row)
  to a document minted under the label the tool reported — and a handle the run
  does not hold fails the write before any document is written. Inline
  model-authored text carries the join the writing transaction derives from
  reading every observed cell; the write is attributed to the `agent` builtin,
  so the result carries `LlmDerived`; the run's observation ceiling is declared
  as the result's store policy, so a join that does not fit is refused by the
  runner's commit boundary and surfaces as a typed `cfc_commit_refused` failure
  whose message names no label. A handle at a position whose schema declares a
  `maxConfidentiality` the referent's label exceeds is sealed rather than
  linked;
- opt-in fabric-session tools — `run_pattern` and `assign_slug`
  (`--fabric-api-url`, `--fabric-identity`, and `--fabric-space` configured
  together, or their `CF_HARNESS_FABRIC_*` environment fallbacks).
  `run_pattern`: compiles and runs an inline `sourceText` pattern (capped at 256
  KiB) against a deployed Fabric space from the trusted host side over a lazy
  per-run session that caches only a healthy, authorized construction; passes
  whole-string LLM-friendly link inputs as live cells, refusing links into
  another space, inputs the compiled pattern declares no argument for, input
  values that carry a sealed opaque link anywhere within them, and values that
  mismatch the compiled argument schema whether a live cell or plain JSON
  supplies them, all before any piece exists; honors the run's abort signal by
  stopping the created piece and returning a structured `cancelled` error;
  scrubs bare fabric identifiers from model-facing diagnostics; reports a result
  that settles to empty or schema-failing as an error when the invocation's
  settle window observed a cause — an action error attributed to the piece, or a
  convergence-budget episode whose deferred actions name this pattern — and
  otherwise still reports ok, since an empty result with no observed cause is
  not evidence of failure; discloses beside a successful result, as
  `outputConcerns`, declared top-level outputs of the patterns the run
  materialized — composed ones included, so a reader whose failure the composing
  source passed on nowhere is still named — that report a failure, declare a
  pending read, or hold no rows on a settled result declaring a read. Pending
  zeros and empty lists are placeholders, not data; the root's returned snapshot
  is checked even if a later observation has settled. A minimal unnamed reader
  pattern takes the held result reference as an input to verify the same piece.
  Concerns name the output and the pattern under the identity a `cf:pattern:`
  import addresses while the failure's own text stays in the artifact. Reporting
  is best-effort wherever it cannot read: an output reached through a `$ref` or
  a combinator, a nested one, an instance the recorder's bounded buffer evicted,
  and an instance that will not read back are each passed over. `run_pattern`
  returns the result cell's canonical reference plus an optionally
  schema-sanitized value, and leaves the piece detached (no recorded origin) and
  out of the space's registered piece list, with run→piece provenance carried by
  the run's persisted artifacts. `assign_slug` names a piece afterwards, from
  any handle token referring to one: it validates the slug, fails closed on an
  availability question the space cannot answer, refuses a slug already naming
  another piece (one already naming the same piece answers ok), refuses a token
  that names a position inside a piece, another space, or a document with no
  pattern identity, and refuses a declared top-level pending read or an
  unestablished UI. Otherwise it registers the piece in the space's piece list
  and points the slug at it, returning the slug and, when composable without a
  bare fabric identifier, an openable URL. Successful naming records a host-only
  reference. Completed interactive turns retain those references atomically with
  history for bare follow-ups, including after restart, and remint them through
  the existing input-cell path. Explicit attachments take precedence; failed
  turns leave the retained references unchanged. Without the session
  configuration both tools are absent from the tool surface, for a `default`- or
  `pattern-author`-profile subagent as much as for the parent — a child shares
  the one session the parent built; `--fabric-cfc-enforcement-mode` (the
  enforcing rungs: `enforce-explicit` or `enforce-strict`) and
  `--fabric-cfc-flow-labels` (`off`/`observe`/`persist`) set the session
  runtime's CFC dials, so with labels persisted a confidentiality-tainted
  pattern write is refused at commit under strict, and
  `--fabric-cfc-posture max-enforcement` opts the session runtime into the
  runner's named posture bundle (every staged enforcement dial on, the standard
  prompt-caveat policy loaded, public-only ceilings on the network-fetch sinks),
  with the two per-dial flags applying over it — these are the fabric session's
  dials, independent of the harness's own `--cfc-enforcement-mode` up to one tie
  — under a session raised to `enforce-strict` a harness dial nobody set follows
  the session, and one stated weaker refuses startup naming both flags — and the
  resolved posture (each dial's value and whether the operator, the named
  bundle, or the default supplied it) is recorded as `fabricSessionCfc` in run
  state and the run report, and printed in the operator summary — the whole
  posture record with it, which a delegated child carries from its parent
  stamped `inherited` because it runs on that parent's session; the session
  runtime can further run under a read ceiling — the `--max-confidentiality`
  flag, or `cfc.maxConfidentiality` (with `cfc.onExceed`) in the run manifest,
  met when both are given — that bounds every `db.query` the run issues, a
  query's own declaration met with it rather than replacing it; the ceiling
  governs only query results declared per session (`PerSession<>`,
  `scope: "session"`, `.asScope("session")`, or a session-scoped db) and the
  runtime refuses any other query under it, so a pattern authored for a bounded
  run declares its results per session; it bounds the session on either
  server-execution arm (under server execution the session declares it to the
  space server, whose runtime reads under it); it is refused without a fabric
  session, recorded with its source as `readMaxConfidentiality` in
  `fabricSessionCfc`, printed in the operator summary, and inherited unchanged
  by a delegated child;
- an opt-in pattern index (`--pattern-index-url`, or its
  `CF_HARNESS_PATTERN_INDEX_URL` environment fallback), which needs the fabric
  session configuration: index requests are signed with the session identity
  under the CF1 first-party scheme, and an indexed pattern runs in the session's
  space. It adds the `search_patterns` tool, which finds published patterns by
  hashtag or free text and reports each hit's kind, evidence quality,
  description, hashtags, usage signals, declared argument and result shapes, and
  the `cf:pattern:<patternId>` import specifier that composes it. The shared
  client resolves same-owner `priorPatternId` chains from the discoverable
  catalog and places the final generation once at the earliest matching rank,
  including replacements outside the original result limit. Penalized final
  generations are withheld; branches or cycles fail the affected search.
  Exact-ID reads and existing imports keep their requested generation. Every
  nonempty search refreshes catalog membership; immutable metadata is cached per
  client. Index-supplied inherited signals retain their predecessor, publication
  cutoff, counts, and score, so a proven tier need not mean that the current
  generation has run. See
  [Pattern generations in search](../README.md#pattern-generations-in-search).
  Free-text search removes stopwords, matches whole words plus light suffix
  variants, and is disjunctive: one content term may return a hit, so extra
  terms can admit generic matches. `matchedTerms` and `queryTerms` count the
  stopword-free terms. It also extends `run_pattern`, which takes exactly one of
  `sourceText` and `patternId`: with a `patternId` the published program is
  fetched host-side and compiled down the same path, and neither its source nor
  a compile diagnostic quoting it reaches model context — the diagnostic is
  retained in the run artifact instead. The run reports `instantiated` and then
  `run_succeeded` or `run_failed` back to the index through the session's
  pattern-index ledger: each write is sent behind the one before it, no tool
  call waits for it, and the session flushes the whole chain before the process
  exits, so a reporting failure never bears on the tool result and a write is
  never cut off in flight. It adds the `record_feedback` tool, which votes a
  pattern up or down with an optional note, so the index learns which of the
  patterns it holds were worth offering. And it closes the loop the other way:
  source the model authored and ran successfully with a non-empty `description`
  and a durable content-addressed identity is queued under that identity,
  carrying the `description` and `hashtags` the call named, the run's own task
  as the request the pattern answers, the compiled argument and result schemas,
  and the published patterns the source imports. The tool's
  `patternPublication.status` is `queued`: the index has not confirmed
  publication at tool return. Saved tool results remain snapshots of what was
  known at return. The session's final ledger flush sends retained
  contributions; index refusals and other publication failures are logged
  without failing the pattern run. Automatic publication requests a record
  without search visibility; discoverability is earned from later evidence.
  Curated seeding may request immediate search visibility for a passing run by
  setting `CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE=1`, while a render-gate
  failure requests a non-discoverable record with the gate's reason. Neither
  request confirms that the index accepted the entry. A run with an empty
  description or no durable identity queues nothing.
  `--no-pattern-index-publish`, or `CF_HARNESS_PATTERN_INDEX_PUBLISH=0`, makes
  the run a reader and voter only. Without the index configuration
  `search_patterns` and `record_feedback` are absent from the tool surface, for
  a `pattern-author`-profile subagent as much as for the parent — a child
  searches through the one client the parent built — and `run_pattern` refuses a
  `patternId`;
- composition over that index: source the model authors may import a published
  pattern by the specifier a search reported,
  `import Sub from "cf:pattern:<patternId>"`, and `run_pattern` makes it
  compile. Before it compiles the source it was given, it reads the imported ids
  off it, fetches each one's program from the index host-side, and compiles it
  into the session's space, so the closure a `cf:pattern:` import resolves from
  is durable by the time the importer asks for it. Materialization recurses
  through what each fetched pattern imports and through the dependencies the
  index recorded for it, deepest first, and a pattern the space already holds is
  left alone. The same happens for a `patternId` the run names directly, so an
  indexed pattern that composes others runs. A composition is refused, with
  nothing of any fetched source in the message, if the run has no index, if the
  runtime has CFC enforcement disabled (an imported pattern resolves from the
  content-addressed source cache, which only an enforcing runtime writes and
  trusts), if the index holds no program for an imported id, if the recorded
  dependencies form a cycle, or if the graph draws in more than sixteen
  patterns. A composed pattern publishes like any other, carrying the ids it
  imports as its dependencies and stored under the identity its compile recorded
  — which is the identity the imported patterns are folded into, and not one the
  source alone determines;
- a `pattern-author` child profile that authors and runs Common Fabric pattern
  source: `run_pattern` under the same fabric-session gate, plus `read_file`,
  `bash`, and `read_skill_resource`, and no workspace writes, so its deliverable
  is a result reference rather than a file. It preloads whichever of
  `pattern-dev`, `pattern-schema`, and `pattern-ui` the run's skill registry
  carries — a run without them still gets the same child, without the guidance —
  and it is told that the references its delegation hands it are addresses to
  wire in as pattern inputs, that it owns the write/compile-error/fix loop, and
  that it returns the result reference plus an inert description rather than
  data. It is told to build in atoms — the smallest thing that does one job,
  run, then the next piece built against the reference that run produced — and
  to treat a `search_patterns` hit as a `cf:pattern:` import to wire rather than
  a specification to rebuild. It is also told to refuse source: a task asking
  for pattern source in any encoding is answered with the `unsupported-request`
  failure code, because reuse travels through the index rather than through the
  parent. This is the division of labour a data question wants: the root
  orchestrates and never pays for pattern syntax or reads the data, and the
  child computes over references it cannot read out. It runs on its own turn
  budget of 24 rather than the default subagent cap of 8, since each
  compile-error iteration costs a turn, and it carries a return contract — a
  discriminated union of
  `{ ok: true, resultRef, describes, hashtags?, verificationRef?, verification?: "not-checked" }`
  and `{ ok: false, code, detail?, verificationRef? }` — which is the profile's
  own rather than a default: a `pattern-author` delegation that declares a
  `returnSchema` of its own is refused, naming the field, because a channel this
  narrow cannot be left caller-writable. A failure and a success are different
  shapes, and only the success branch carries a piece result reference; there is
  no field on it for source under any name. The failure `code` comes from a
  fixed inert vocabulary, so a parent learns why without declassifying anything,
  and any child return saying `ok: false` reaches the parent as a coded failure
  rather than as a schema complaint.
- revision verification guidance uses `read_piece_source.inputRef` for the
  piece's bound arguments and ordinary `run_pattern` for an old/new rule check
  over one bounded sample. The child's separate `verificationRef` carries no
  values into the parent; a minimal reader preserves readiness, comparison
  counts, and pending/error fields through the existing release path. Pending
  evidence is reread once through the same reference, never interpreted as
  settled-empty data. Query failures remain failures; policy refusals are not
  retried. A released, ready comparison with zero effect or an empty sample
  calls for a question. Unavailable inspection allows a requested create or
  revision to be applied: a successful receipt returns the piece with the fixed
  `verification: "not-checked"` marker. The piece's visible summary and the
  final text state the inspection limitation, describe only the build or change,
  and point to the piece without claiming unseen results or asking for a
  nonexistent release permission. Styling without a computed-surface observation
  is explicitly reported as not checked. This is guidance, not a host proof of
  arbitrary rule semantics.

Run the capability probe instead of copying this list into adapters:

```bash
deno task run -- --describe-capabilities
```

## Product integrations

### Loom

Loom's batch adapter dynamically probes capabilities, constructs a run manifest,
creates a narrow temporary workspace, supplies explicit mounts and skills,
requests structured capture results, and retains reviewable run artifacts.
Autonomous wish dispatch currently routes through `cf-harness` when Loom's Page
authority prerequisites are considered available.

Local batch and interactive entrypoints use a dedicated single-user host
binding. It resolves the persisted provider from a canonical `CF_HARNESS_HOME`,
binds Codex credentials to the fixed local owner, records the provider, model,
authentication source, owner, and home identity, and requires that exact
snapshot on resume before any provider traffic. Hosted multi-user integrations
must supply an owner-bound credential resolver rather than reuse this local
host.

Loom also has an opt-in adapter for the interactive NDJSON protocol. It is not
the default interactive harness, and browser automation is not yet wired into
that interactive product path.

Loom currently forces autonomous `cf-harness` runs to `observe` mode while
trusted `runsc-cfc` observation metadata is not wired through every local tool
path. This is a product-integration deviation, not the package default.

### Pattern Factory

Pattern Factory runs each supported phase as a separate batch invocation. The
launcher owns phase ordering, validation, bounded critic/manual-test repair
passes, and finalization; `cf-harness` owns the phase-local model/tool loop and
evidence. All default Pattern Factory phase profiles currently use CFC `observe`
mode.

## Known limitations

- End-to-end runner-owned CFC mediation is incomplete in the current product
  integrations; enforcing modes therefore cannot yet replace their `observe`
  bridges.
- The pattern index exposes no CFC labels for either result metadata or private
  indexed source. Research records each observation as missing label coverage;
  downstream enforcement can carry known confidentiality, while the coverage gap
  remains diagnostic rather than becoming a clean classification.
- Capability discovery does not prove that Docker, `runsc-cfc`, a browser lease,
  or another external dependency is healthy. Callers must perform dependency
  preflight for workflows that require them.
- Package-default sandbox networking is a provisional bridge-oriented posture,
  not the final destination policy model. Product adapters may narrow it.
- Delegation is serial: only one child runs at a time.
- Every `run_pattern` invocation persists a piece in the configured space, and
  never registers it: the piece joins the space's registered piece list only
  when `assign_slug` names it. An aborted run stops its piece, but no piece is
  ever deleted, and each piece's source-history revision is a storage-retention
  root the piece list does not reveal. Tooling that enumerates a space's
  contents from the piece list must not assume the list is exhaustive; there is
  no garbage collection for these pieces yet.
- Model-driven dynamic skill activation is not implemented. Skills are
  explicitly preloaded by the caller; child skills are profile-controlled.
- Resume is transcript-oriented and does not recover an arbitrary partially
  executed tool or orchestration state machine. An interrupted turn is never
  replayed automatically: new turns retain their last provider-safe durable
  checkpoint, while restore and the next-turn boundary normalize legacy
  incomplete tool-call batches by adding an explicit unknown-outcome result for
  each missing result. This preserves legacy calls and later history without
  claiming or replaying an interrupted side effect. A tool result with no
  pending call or a duplicate call ID anywhere in the transcript fails closed
  before provider traffic because the harness cannot honestly invent or delete
  the missing history.
- Raw operator artifacts use filesystem paths. Parent-visible child returns are
  sanitized, and the prompt loop swaps model-bound tool output and
  model-authored tool arguments through the address handle table; denial-path
  tool messages are not swapped, and interactive restore does not persist the
  handle table.
- The session-local handle table covers cell addresses only. Value handles
  (`cfh:v:`) are reserved in the token grammar but not implemented, and there is
  no explicit dereference/release mechanism.
- `estimatedCostUsd` is available only for known GPT-5.6 gateway models when the
  response includes cache reads and writes. It uses public OpenAI pricing;
  gateway markup, subscription quota accounting, and provider invoices remain
  outside the harness. `estimateWithheldReason` distinguishes missing provider
  detail, unknown models, invalid counters, subscription pricing, and incomplete
  aggregate estimates. Aggregate dollar costs are omitted unless every included
  usage record reports one, so a partial cost is never presented as the whole
  run's.

## Verification

Package behavior is covered by the unit suite:

```bash
deno task test
```

Product adapters maintain their own contract and cancellation tests; package
tests alone are not evidence that Docker, Browser Access, or a live product
instance is healthy.
