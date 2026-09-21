# cf-harness Implementation Profile

Status: draft conformance statement\
Profile date: 2026-09-03\
Implementation revision: Labs `889e34c55a`

The [system map](system-map/README.md) moves in lockstep with this
implementation profile.

This document describes `@commonfabric/cf-harness` against the draft Common
Fabric
[Agent Harness specifications](../../../docs/specs/agent-harness/README.md). It
is deliberately more conservative than the feature list: protocol presence does
not imply full conformance or external dependency health.

The classes below are the labs `AH-*` conformance classes defined in
[03-conformance.md](../../../docs/specs/agent-harness/03-conformance.md). They
are not CFC implementation profiles, and claiming one is not claiming the other.
What this package claims against the CFC specification's own profiles is stated
separately, under
[Relationship to the CFC implementation profiles](#relationship-to-the-cfc-implementation-profiles).

## Claimed classes

| Class         | Status                                                     | Evidence boundary                                                                                                                                                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core batch    | implemented; provisional conformance                       | Package unit tests cover configuration, lifecycle, context management, tools, handles, attachment integrity, artifacts, resume, and diagnostics. Real Docker, Fabric, and other external-runtime behavior requires integration tests.                                                                                     |
| Delegation    | implemented; experimental                                  | Unit tests cover profiles, fresh child context, retained child artifacts, and sanitized/structured return handling. Only serial single-child orchestration is supported.                                                                                                                                                  |
| Interactive   | implemented; experimental                                  | NDJSON v1 and SQLite-backed sessions/turns/events/replay are covered by package and Loom adapter tests, including crash-restart regressions that reconstruct a service from the same SQLite store at each mid-tool fault point and assert the transcript the next turn is given. The protocol is not yet declared stable. |
| CFC transport | partial; reduced assurance in current product integrations | Prompt-slot, invocation-context, model-influence, mediation, and deny/recovery behavior are tested. Loom and Pattern Factory still select `observe` because trusted mediation is not wired end to end.                                                                                                                    |

## Relationship to the CFC implementation profiles

The CFC specification defines three implementation profiles in
`cfc/18-runtime-implementation-profiles.md`. This package's position on each:

| Profile                   | Position                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CfcAgentHarnessProfile`  | **Not claimed.** Which of §18.3.3's obligations are answered is held in [`audit/conformance-manifest.ts`](../audit/conformance-manifest.ts) and printed by `deno task cfc-audit`, so it is not restated here.                                                                                                                                                                       |
| `CfcGVisorSandboxProfile` | **Not claimed, and not this package's to claim.** cf-harness runs tools under the sibling gVisor runtime `runsc-cfc`, so the profile is in scope for a deployment; the mediation it requires belongs to that runtime, the Common Fabric FUSE daemon, and the runner's label store. Four of §18.2.7's nineteen documentation obligations are this package's, and are answered below. |
| `CfcTrustedRenderProfile` | **Not applicable.** cf-harness has no user-visible render surface. Its outputs are model context, operator terminal lines, and artifact files, none of which is a certified authorship boundary.                                                                                                                                                                                    |

Which §18.3.3 obligations are answered, and which are not, is
[`audit/conformance-manifest.ts`](../audit/conformance-manifest.ts) and not this
document. That file holds, per obligation, the obligation in the specification's
words, the status, the code the answer rests on, the audit checks covering it,
and where the work is tracked; `deno task cfc-audit` prints the position on
every run, and the manifest's status is reconciled against those checks'
verdicts so a status nothing tests cannot be asserted.

Stating the statuses here as well would be a second encoding of one truth, and a
consistency check across two copies cannot detect a consistent wrong answer: the
copy nobody runs is the one that goes stale, and a reader has no way to tell
which of two disagreeing documents is right. So this document says where the
position lives and does not restate it. The reading of it is:

```bash
cd packages/cf-harness
deno task cfc-audit .cf-harness-console/runs
```

The obligation-by-obligation working, with the code each answer rests on, is in
[`docs/history/packages/cf-harness/cfc-profile-conformance-gap-2026-09-03.md`](../../../docs/history/packages/cf-harness/cfc-profile-conformance-gap-2026-09-03.md),
which is a point-in-time record and is not maintained.

The four §18.2.7 obligations that are this package's:

- **Which mounts are CFC-mediated, rootfs, scratch, or out of scope.** Mounts
  are classified as `workspace`, `fabric-fuse`, or `host-bind` and recorded per
  run with host path, sandbox path, read-only flag, and mode. That inventory is
  published and does not carry §18.2.7's classification; no mount carries a
  measured image or rootfs digest.
- **Where the opaque-handle store and label store live.** The handle table is
  session-local, persisted with the run's artifacts, reconstructed across batch
  resume, and never visible to the sandbox, which sees only tokens. The label
  store is the runner's; sandbox labels arrive through the `runsc-cfc` CFC
  result sidecar.
- **Which handle scopes, TTLs, revocation behavior, and metadata labels are
  implemented.** Scopes are `invocation`, `run`, and `session` — the spec's
  third scope is named `plan` and is the same idea — and a handle carries an
  optional expiry. No revocation or tombstoning exists and handle metadata is
  unlabeled.
- **How stdout/stderr are prevented from bypassing the trusted runtime.** Raw
  streams return through the `runsc-cfc` result sidecar and are withheld from
  model context when the sidecar reports tainted output. An enforcing run whose
  invocation-context or result transport is unwired fails at startup rather than
  degrading silently, and the registered Docker runtime is separately checked
  for an absolute directory on each flag. The two directory spellings are
  deliberately not compared, because comparing two path strings cannot establish
  that they name one directory, so two absolute paths that disagree pass both
  checks.

The obligation-by-obligation working, with the code each answer rests on, is in
[`docs/history/packages/cf-harness/cfc-profile-conformance-gap-2026-09-03.md`](../../../docs/history/packages/cf-harness/cfc-profile-conformance-gap-2026-09-03.md).
How the `AH-CFC-*` clauses relate to the CFC sections above, and which CFC
obligations no clause carries, is in
[`docs/specs/agent-harness/04-cfc-spec-correspondence.md`](../../../docs/specs/agent-harness/04-cfc-spec-correspondence.md).

## Capability discovery

The machine-readable probe is:

```bash
deno task run -- --describe-capabilities
```

It reports CLI fields, repeatable fields, parent and built-in tools, child
profiles, native model tools, and optional features. Adapters should use this
probe to handle vendor skew.

The probe does not health-check Docker, the selected Docker runtime, Browser
Access, a model gateway, configured mount sources, or the Fabric session used by
`run_pattern`. Callers must not treat advertised capability as dependency
readiness.

## Trust and execution profile

- Model gateway: either an OpenAI-compatible gateway or the authenticated OpenAI
  Codex subscription transport. Gateway `gpt-*` turns use the Responses API,
  which accepts function tools together with reasoning; provider-native tools
  and non-OpenAI models use chat completions, which cannot serve that
  combination. Codex's `web_search` child instead inherits its parent's model
  and subscription owner and requests hosted Responses web search. Native model
  tools are declared separately in either case, with provider-specific profile
  resolution captured in policy and provenance.
- Provider and credentials: versioned private provider configuration and Codex
  credentials live beneath `CF_HARNESS_HOME`. Provider resolution is explicit; a
  broken Codex binding does not fall back to gateway billing or retention. The
  dedicated local Loom host uses the fixed credential owner `local`, a canonical
  home identity, and the persisted provider/authentication source.
- Execution substrate: Docker; normally the sibling gVisor `runsc-cfc` runtime,
  with configurable image and runtime.
- CFC authority: Common Fabric runner/runtime evidence and trusted sandbox
  sidecars. Harness-local policy logic is conservative transport/enforcement,
  not the source of label meaning.
- Host execution: no parent-run shell reaches the host. Bounded host-side
  surfaces exist beside the sandbox: the browser child profile's typed `browser`
  tool and allowlisted skill scripts, bound to an explicit local CDP lease the
  harness attaches itself, and the `run_pattern` tool, which compiles
  model-authored pattern source and runs it against the configured Fabric space
  over a lazy authorized session. The Fabric identity remains outside Docker,
  the session is constrained to one configured space, and the separate
  `assign_slug` tool registers a piece the run holds a handle to in that space's
  piece list under a caller-chosen slug. Neither surface admits arbitrary host
  commands, and both fabric-session tools are present only when a fabric session
  is configured. Dedicated Loom tools additionally invoke three fixed command
  ids through an operator-configured host CLI, using argv and stdin with pinned
  routing and attribution. This is an authority-only host boundary, not a new
  flow-aware store commit gate; see [LOOM_AUTHORING.md](LOOM_AUTHORING.md). The
  agent result writer (`src/result-writer.ts`) is a third trusted host path and
  not a model tool: a host caller invokes it after a run reaches its structured
  result, and it writes that result into the same configured space over the same
  session. Its bounded authority is the session's (AH-TOOL-7): every handle the
  result names must be one the run's table holds, a cell handle becomes a link
  and never a copy, a non-cell referent becomes a document under the label its
  tool reported when the result cites it, and an uncited referent passes the
  same write admission in an isolated aborted transaction and contributes
  through an opaque runtime CONTENT-observation receipt. The cells the run
  observed and the cited referents are read through the writing transaction so
  the runner derives the inline text's label without making uncited content
  durable. The write is attributed to the `agent` builtin so the result carries
  the runtime-minted `LlmDerived` family, and the run's observation ceiling is
  declared as the result document's store policy so the runner's commit boundary
  — not the writer — decides whether the derived join fits. A refusal reaches
  the caller as a typed failure carrying the refusal code and the boundary's
  structured detail, with no label atom in its message.
- Network: explicit in configuration but still provisional. Sandboxed `bash`
  applies a direct-`curl` destination guard; `web_fetch` and web child profiles
  have their own bounded request policies.
- Gateway attribution: OpenAI-compatible requests carry bounded `x-cf-harness-*`
  and `User-Agent` provenance fields. These contain operational origin labels,
  not prompts, tool content, secrets, or personal identifiers. The Codex
  subscription transport does not use these gateway headers.
- Artifacts and observations: artifacts are retained under an explicit root and
  reserved from normal workspace discovery when the roots overlap. Run-start
  image inputs are integrity-locked. In-run `view_image` observations use
  content-addressed snapshots when an artifact store is present, so regenerating
  the source file does not change an earlier observation. Each persisted tool
  result has a sibling transcript-omission entry naming the omission rule and
  the full artifact's JSON pointer without copying the withheld value. The
  console may join those records for retrospective display; resume and replay
  continue to read only the model-facing transcript.

## Parent and child surfaces

Current selectable parent tools are `bash`, `read_file`, `view_image`,
`web_fetch`, `read_skill_resource`, `run_skill_script`, `edit_file`,
`write_file`, `delegate_task`, `describe_handle`, `run_pattern`, `assign_slug`,
`search_patterns`, `record_feedback`, `search_skills`, `acquire_skill`,
`research`, `loom_compose`, `loom_inspect`, `loom_authoring_context`, and the
eight read-only Loom tools `loom_search`, `loom_page_discover`,
`loom_page_inspect`, `loom_page_read`, `loom_people`, `loom_calendar_list`,
`loom_context`, and `loom_profile`, plus `submit_result`. Individual runs
receive only their configured subset; `web_fetch` and `run_skill_script` are not
in the ordinary default surface. Optional tools are gated on the backing a run
can supply — a fabric session for `run_pattern`, `assign_slug`, and
`acquire_skill`, the pattern index for `search_patterns` and `record_feedback`,
configured skills.sh discovery for `search_skills`, and a resolved documentation
corpus or pattern index for `research`, explicit host Loom authoring
configuration for the three authoring tools, explicit host Loom retrieval
configuration for the eight retrieval tools, and a configured structured-result
schema for `submit_result` — and a tool the run cannot back is absent from the
surface rather than present and failing, so an explicit allowlist naming it does
not conjure it. `run_pattern` additionally requires the three `--fabric-*`
session flags. `browser` exists only as a built-in used by the authorized
browser child profile and cannot be selected as a parent CLI tool; it drives the
host `agent-browser` CLI through a typed action vocabulary, with the Browser
Access CDP endpoint attached by the harness rather than written by the model.

`submit_result` is how a run returns its structured result without a sandbox
write. It takes the value as its input, validates it with the structured-result
validation the file-based path uses, and the host writes it to the configured
structured-result file, so the post-run validation, the batch metadata, and the
agent result writer read one place. A refused value returns a typed
`invalid_result` error and the model submits again; a later valid submission
replaces an earlier one. A handle token in the value stays a token, because the
token is what the result writer resolves. The tool is admitted at every
enforcement mode and under every prompt-slot role, with the policy reason
`structured_result_return`: its authority is the host's configuration of a
schema (AH-TOOL-4's explicit grant), it is absent from a run configured with
none, and it reaches nothing but that run's own result file. A subagent run is
not offered it. The model writing the file itself remains available to a run
that holds a tool able to.

`describe_handle` reports the referent's structural schema and path segments,
never its data. It prefers the session Fabric's declared shape when available
and otherwise uses a harness-captured schema, recursively removes value-bearing
and descriptive schema fields, bounds disclosed property names, and scrubs bare
Fabric identifiers. A referent that declares no schema and holds a SQLite
database handle reports that database's tables and its columns' labels through
the same reduction, which is the one value the tool reads. An unknown or
shapeless token remains an ordinary bounded tool result rather than a
dereference path.

`run_pattern` accepts at most 256 KiB of inline source. It resolves whole-string
LLM-friendly link inputs to live cells only within the configured space and
checks declared inputs, opaque-link containment, and argument schemas before
piece creation. Success returns the result reference and an optional
schema-sanitized value while raw evidence stays in artifacts; the created piece
stays out of the space's piece list. Naming is the separate `assign_slug` tool:
it takes a handle token referring to a piece plus a slug, registers the piece in
the list, points the slug at it, and returns the slug and, when possible, an
openable URL. Cancellation of `run_pattern` stops the created piece. The session
separately records its Fabric CFC enforcement and flow-label posture.

Current child profiles are `default`, `browser`, `web_fetch`, `web_search`, and
`pattern-author`. Each profile supplies an exact tool/network/skill policy.
Parent skills and authority do not transfer implicitly. `research` instead runs
a bounded private model loop with a fixed read-only tool vocabulary over the
operator-provisioned corpus, published pattern index, and safe handle
descriptions. It is not a child profile and cannot be selected through
`delegate_task`. Its exact reads and private transcript remain in artifacts;
only a host-admitted complete or incomplete implementation kit reaches the
caller.

The `pattern-author` profile combines `run_pattern`, `read_file`, `bash`,
`read_skill_resource`, and `research` without workspace writes. It preloads the
available `pattern-dev` and `pattern-schema` skills, receives a 24-turn budget
for compile-and-repair loops, and defaults to a discriminated success/failure
return contract whose success arm carries the result reference. An inherited
research kit is starting context; only unresolved items trigger another focused
research call. Sandboxed children inherit the parent's working directory within
their host-backed mounts; host-command children begin at the engine workspace
rather than inheriting a parent directory they cannot resolve.

## Lifecycle and evidence

Runs have stable identifiers and persist run-state, transcript, report,
capability, policy, tool, skill, and child evidence. Signal handling
terminalizes the active run. Product wrappers that create additional process
groups are responsible for forwarding cancellation and reaping the complete
owned group; Loom's batch wrapper implements and tests that integration
boundary.

Gateway Responses turns support server-side context compaction. The default
threshold is 75% of the input budget derived from the model's context window and
maximum output; `--compact-threshold` overrides it and `0` disables compaction.
Lazy budget discovery is bounded by a text-bearing input-size guard. Compaction
items remain transcript evidence, replay starts at the newest compatible
boundary, and function-call/output pairs remain intact. Transient discovery,
compaction, and abort failures are not permanently cached. A child that
overrides its model does not inherit parent provider controls; explicit run-wide
compaction disablement is the exception.

The session-local address handle table maps positively identified cell addresses
to deterministic per-run `cfh:a:` tokens. Model-bound tool output and
model-authored tool arguments pass through the table before policy evaluation
and dispatch. Bare Fabric IDs are not converted. A delegation explicitly seeds
the child table with only the parent handles named in its goal or context; child
references are resolved at the child boundary and re-minted into the parent
table, while any unheld token-shaped text is scrubbed. Raw artifacts retain
canonical references, and the table is persisted across batch resume.

Resume preserves recorded transcript/run configuration and rejects unsupported
new inputs such as image or skill changes. The local Loom host additionally
requires an exact recorded provider, model, authentication source,
credential-owner, and canonical-home binding before provider traffic; legacy,
incomplete, inconsistent, or switched bindings fail closed. This fixed-owner
host is for local single-user Loom. A hosted multi-user adapter must inject an
owner-bound credential resolver. Resume is not a general recovery system for an
in-flight external side effect.

## Known deviations and retirement conditions

1. **Dependency readiness.** The capability probe does not establish health for
   Docker, `runsc-cfc`, Browser Access, mounts, gateways, or Fabric sessions.
   Owner: `cf-harness` and each product adapter. Retirement: the selected run
   profile has a caller-visible preflight that checks every required dependency
   before the first model turn.
2. **Product `observe` bridges.** Loom and Pattern Factory select `observe` for
   workflows whose sandbox output does not yet carry trusted mediation metadata
   end to end. Which mode each adapter selects is a fact about adapters that
   live outside this repository, so it is stated here on their behalf and is not
   established by anything in this tree; each adapter's own conformance
   statement is the authority for it. Owners: the respective product adapters
   plus the cf-harness/CFC integration. Retirement: real sidecar evidence is
   present for every exposed observation and enforcing-mode adapter suites pass
   without opaque-output regressions.
3. **Provisional network policy.** Package-default bridge networking and the
   shell `curl` guard are integration mechanisms, not a complete destination
   capability system. Owner: `cf-harness`. Retirement: network authority is
   represented and enforced as an explicit profile across sandbox and dedicated
   web tools.
4. **Incomplete opaque-reference boundary.** Address handles cover cell
   addresses but not the reserved value-handle form. Denial-path messages are
   not swapped, interactive restore does not persist the table, and cross-agent
   transfer exists only across an explicit delegation boundary. Shape inspection
   does not expose values, and there is no value dereference, release, or
   garbage-collection contract. Raw operator reports may expose artifact paths
   and canonical references. Owner: `cf-harness`. Retirement: every model-facing
   path uses held opaque handles with explicit lifetime and release/readback
   semantics while operator tooling retains resolvable provenance.
5. **Durable trusted-host pattern execution.** Each `run_pattern` call creates a
   detached Fabric piece whose source revision remains a retention root. The
   piece stays out of the piece list until `assign_slug` names it; abort stops
   the created piece. There is no deadline, resource ceiling, deletion, or
   garbage collection. Fabric session CFC posture can refuse tainted strict
   writes, but resource lifecycle and registration settlement remain incomplete.
   Owner: `cf-harness` and Fabric runtime tooling. Retirement: callers can
   bound, enumerate, retain, and delete tool-created resources, and cancellation
   fully settles both registry membership and assigned names.
6. **Side effects gated on authority rather than on flow.** Every side-effecting
   tool except `run_pattern` — and `submit_result`, which has no effect outside
   the run's own record and is admitted by its configuration — is admitted by a
   check on the descriptor's static effect class and on whether the run carries
   a direct-command binding. The decision is recorded before the tool runs, so
   it is not a commit point, and it consults no sink and no label. `run_pattern`
   is the exception and shows the shape the rest want: a named sink, an explicit
   ceiling, and the runner's commit boundary deciding. Owner: `cf-harness` and
   the CFC runtime. Retirement: each side-effecting tool's effect is declared as
   a named sink whose ceiling the runner's boundary commit evaluates, so that a
   refusal comes back as structured evidence rather than as an allow recorded in
   advance.
7. **Direct-command bindings not bound to a subject or a submitted value.** Both
   minting surfaces produce a binding from constants: the console's is a
   module-level value reused for every turn of every session, and the CLI's
   carries a resume-run id or a workspace path in the `subject` field. Neither
   populates a `valueDigest`, and neither supplies the trusted input-capture
   record a non-render surface needs. The transport contract already types
   `subject`, `eventId`, `valueDigest`, `slotDigest`, `snapshotDigest`, and
   `targetPath`. Owner: `cf-harness`. Retirement: each surface mints per
   submission, over the submitted value's digest and an authenticated subject.
8. **No confidentiality ceiling on a delegation.** A child profile attenuates
   capabilities and not observation, so a child can read anything the
   capabilities it was given can reach. Owner: `cf-harness` and the CFC runtime.
   Retirement: a delegation carries an observation ceiling the runner's access
   check consumes, and handle resolution into a child input is rejected when it
   exceeds that ceiling.

9. **The run's read ceiling gates session-scoped query results only.** The
   ceiling a run carries — `--max-confidentiality`, or `cfc.maxConfidentiality`
   in the run manifest, met into the fabric session's runtime as
   `cfcReadMaxConfidentiality` — is applied by the runner's `db.query` builtin
   at the query, not at the cell: a query whose result is session-scoped
   (`PerSession<>`, `scope: "session"`, `.asScope("session")`, or a
   session-scoped db) reads under the meet of its own ceiling and the run's; a
   query with a space- or user-scoped result is refused before it is staged,
   because that result is one cell every runtime on the space resolves and the
   run's runtime cannot narrow it for itself. The refusal reaches the runtime's
   error handlers, so an authored pattern that declares no scope fails on its
   first query rather than reading under a wider view. What the option does not
   reach is a shared cell another runtime already filled: that is protected by
   the cell's own label under the commit-boundary gates, not by the run's
   ceiling. Owner: `cf-harness` and the CFC runtime. Retirement: the ceiling is
   carried into the runtime's cell read path (a labeled cell that does not fit
   reads as withheld), and the served-execution arm carries a per-session
   ceiling to the serving runtime, at which point the scope requirement and the
   OFF-arm-only limit both retire.

10. **Loom row labels assumed, not read.** A row a Loom retrieval tool returns
    with no `ifc` field is given the label of the query that produced it — the
    tool call's input label, the prompt slot's influence joined with the run's
    accumulated model-context label — and that assumed label is what is measured
    against the run's ceiling, recorded as the observation, and available to
    stamp on a document when the result cites the row. The pinned loom emits no
    `ifc` on any retrieval payload, so this is the path every real row takes.
    The assumption can under-label a row: what it holds is decided by its store,
    not by who asked. A row whose `ifc` is present and unreadable is still
    refused, and loom's own facet filtering still runs first on the host. The
    rule is `labelForUnlabeledLoomRow()` in `src/tools/loom-retrieval.ts`; see
    [Read-only Loom retrieval](LOOM_RETRIEVAL.md). Owner: `cf-harness` and loom.
    Retirement: loom returns a label per row and the function reads it.

## Test evidence

- `deno task test` — package contract suite.
- Handle-table, prompt-loop-handle, cross-agent-handle, `describe_handle`,
  schema-shape, image-attachment, compaction, provenance, provider/auth,
  `run_pattern`, agent-result-writer, Fabric-session-CFC, and local-Loom-host
  suites — model boundary, observation integrity, context continuity, request
  attribution, external side effects, and exact resume binding. The
  result-writer suite runs over an in-memory runtime at the fabric session's
  enforcement rung and reads every label it asserts back through the runtime's
  own label view.
- Loom `tests/harness/` and dispatch tests — capability skew, commands,
  cancellation, mounts, structured results, interactive translation, and run
  review.
- Pattern Factory launcher tests and phase smokes — phase ownership, validation,
  repair routing, skills, browser leases, and finalization.
