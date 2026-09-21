# Agent requests — implementation plan

Sequences the build of
[Agent requests from a pattern, and the queue that runs them](agent-requests-and-work-queue.md).
Read that document for the reasoning; this one names the files, the tests,
and the order. Each stage is one pull request or a small stack, lands green
on its own, and is testable without a model provider. Checkboxes are ticked
as work lands; when the last stage of the first take (stage 6) lands, both
documents are archived to `docs/history/plans/`.

**Status:** stages 1 through 4 built; the checkboxes track the rest. Written
2026-09-18 against `37b1acd3dd`.

## Ground rules for every stage

- Read `docs/development/DEVELOPMENT.md` and
  `docs/development/code-comment-style.md` before the first edit; new tests
  follow `docs/development/unit-test-coding-style.md` and wait on events per
  `docs/development/waiting-in-tests.md`.
- Red before green: the stage's acceptance tests are written first and shown
  failing.
- Before pushing: `deno fmt --check`, `deno lint`, `deno task check`,
  `deno task test` in every touched package, and the repo-wide gates a stage
  names below. Merge `origin/main` before testing and pushing.
- Every stage updates the live documents it changes in the same change; the
  list at the end of the design document is the checklist.
- No new provider, no new sandbox technology, no Loom write path.

## Stage 1 — Loom retrieval tools in the harness

**Package:** `packages/cf-harness`. **Depends on:** nothing.

The retrieval tools mirror the three authoring tools end to end: a host-side
configuration the model cannot see, a command transport it cannot change,
structured stdin, typed outputs, and admission through the tool-descriptor
availability tables.

- [x] `src/loom-retrieval.ts` — sibling of `src/loom-authoring.ts`:
      `HarnessLoomRetrievalConfig { cliPath, transport, readCeilingFile?, facets? }`
      reusing `HarnessLoomAuthoringTransport`; `LoomRetrievalCommand` union
      (`search`, `page.discover`, `page.inspect`, `page.read`, `people`,
      `calendar.list`, `context`, `profile`); a `runLoomRetrievalCommand`
      that builds argv from a typed input, always passes `--json` where the
      command takes it and `--concise` where `page` takes it, runs through
      `createClearedHostProcessEnv`, and parses stdout as JSON with a
      `schemaVersion` check for `search`.
- [x] Confirm each of `people`, `calendar list`, `context`, `profile` against
      the pinned loom checkout (`~/looms/primary/src/bin/loom`): read-only,
      JSON output, argument list. Drop from the union any that is not; record
      the dropped ones and why in `packages/cf-harness/docs/LOOM_RETRIEVAL.md`.
- [x] `src/tools/loom-retrieval.ts` — one `HarnessToolDefinition` per tool
      (`loom_search`, `loom_page_discover`, `loom_page_inspect`,
      `loom_page_read`, `loom_people`, `loom_calendar_list`, `loom_context`,
      `loom_profile`), each `effectClass: "read"`, each returning a bounded
      output with the untrusted-content notice the prompt loop attaches to
      `web_fetch` results (`src/prompt-loop.ts`, the search notice), and each
      recording the rows' `ifc` labels as observations through the existing
      `HarnessCfcModelContext` accumulation.
- [x] Label measurement: before a row enters model context, its label is
      measured against the run's observation ceiling with the same predicate
      `run_pattern` uses (`describeSinkReleaseRefusal` where a transaction is
      available, `atomsOutsideCeiling` over the disclosed label otherwise); a
      row above the ceiling is replaced by a typed opaque entry; a row whose
      `ifc` is present and unreadable is refused as `cfc_label_read_failed`;
      a row with no `ifc` is given the query's label by
      `labelForUnlabeledLoomRow()`, a placeholder the implementation profile
      publishes as a deviation.
- [x] Ceiling forwarding: the pinned loom CLI takes no `--read-ceiling-file`
      on any retrieval command — loom's own scope is the broker's launch
      facets — so the configuration names the loom read-ceiling record
      (`readCeilingFile`) and the harness meets its clause list with the
      run's ceiling before measuring rows; `facets` must match the record's.
- [x] `src/contracts/tool-descriptor.ts` — the eight ids in `BuiltinToolId`;
      `LOOM_RETRIEVAL_TOOL_IDS`; an `loomRetrievalAvailable` availability flag
      beside `loomAuthoringAvailable` in both the withheld and the offered
      lists.
- [x] `src/engine.ts` — input and output map entries; `src/tools/registry.ts`
      — registration; `src/config.ts` and `src/session-assembly.ts` —
      `loomRetrieval?: HarnessLoomRetrievalConfig`, validated like
      `loomAuthoring`; `src/cli.ts` — `--loom-retrieval-config` and
      `CF_HARNESS_LOOM_RETRIEVAL_CONFIG`; `--describe-capabilities` lists the
      tools.
- [ ] Loom side (separate change in `~/looms/primary`): `schemaVersion: 1` on
      the `search --json` payload at `src/lib/connectors/search.py`, per the
      comment there.
- [x] Tests, `test/loom-retrieval.test.ts` and `test/tools/loom-retrieval.test.ts`,
      with a fake `ProcessRunner` returning fixture JSON: argv construction per
      command; `--json`/`--concise` always present; config validation failures
      (relative path, empty transport); a stated `schemaVersion` other than 1 refused
      and an absent one accepted; an unlabeled hit given the query's label and
      a malformed `ifc` refused; a hit above the ceiling sealed; the notice
      attached; availability gating in the descriptor tables; capability
      description lists the tools only when configured.
- [x] Documents, all under `packages/cf-harness/`: `docs/LOOM_RETRIEVAL.md`
      (new, the sibling of `LOOM_AUTHORING.md`), `docs/IMPLEMENTATION_PROFILE.md`
      tool list, `docs/CURRENT_STATE.md` supported surfaces, `README.md` where
      it lists
      Loom tools; `deno task check-skill-facts` if a skill cites a path.

*Exit:* a batch run with `--loom-retrieval-config` and a scripted model answers
a search and a people lookup from fixture output, the run report shows the
tool calls, and a run without the config offers none of the tools.

## Stage 2 — The result writer in the harness

**Packages:** `packages/cf-harness` (host side) and the `packages/runner`
observation-receipt seam. **Depends on:** nothing (stage 1 only supplies more
referent kinds).

The writer is the harness routine of design §1.3. It runs on the trusted host
over the fabric session's runtime and is called by the runner of stage 4 after
a run reaches its structured result. It is not a model tool.

- [x] `src/result-writer.ts` — `writeAgentResult({ session, handleTable,
      structuredResult, resultSchema, observedHandles, maxConfidentiality,
      cause?, opaqueHandleId? })` returning `{ link, joinLabel,
      mintedDocuments, sealedPaths }`. `observedHandles` holds every cell
      handle the run observed and, as `kind: "document"` entries carrying
      content and reported label, every non-cell referent; `maxConfidentiality`
      is the run's observation ceiling. Steps, on `session.pieces.runtime`:
      1. `validateStructuredResultValue` against `resultSchema` with `asCell`
         positions exempt (existing, `src/structured-result.ts`).
      2. Walk the value; at every position holding a handle token, the
         canonical link string the inbound swap produces, or a `{"@link"}`
         object, resolve through `resolveHandleToken`/`resolveHandleRef`
         against the run's table or the document referents — unheld fails the
         write before any transaction opens (AH-REF-2), a token in prose or a
         property name included; a cell outside the session's space is
         refused. A cell referent becomes its link. Where the position
         declares `ifc.maxConfidentiality` (met across `allOf`), a referent
         above it is sealed.
      3. First committed transaction: a document per non-cell referent the
         result names, written through a schema declaring the referent's label
         on every node; no reads. For every unnamed referent, stage the same
         write in an isolated transaction, require successful CFC preparation,
         traverse its complete value closure, retain the runtime's opaque
         content-observation receipt, and abort the transaction.
      4. Second committed transaction: read every observed cell and every
         minted document, and consume each runtime-issued observation receipt,
         so `collectConsumedLabel` sees every model input without making an
         unnamed referent durable;
         `tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: "agent" })`;
         write the result through the result schema with position ceilings
         stripped, link positions relaxed, `maxConfidentiality` declared as
         `ifc.confidentiality` on every node, and the `LlmDerived` stamp from
         `withLlmDerivedStamp` (`@commonfabric/runner/cfc`) on every node.
      5. Commit; return the result link and the label the runtime reports at
         its root.
- [x] Refusal handling: a commit the boundary refuses surfaces as a typed
      writer failure carrying the refusal code and no label detail, the way
      `run_pattern` reports `cfc_release_withheld`; the runner maps it to
      `refused`.
- [x] Tests, `test/result-writer.test.ts`, on an in-memory runtime with
      fixture cells of two labels and one observed Loom row: one result
      document, three links, targets keep their labels, inline text carries
      the join of both cell labels, a cited row document carries the row's
      label, an uncited row leaves no durable document while its label still
      joins the inline result, and the result carries `LlmDerived`; an unheld
      handle fails before any write; a handle at a non-`asCell` position still
      becomes a link; a value above a declared ceiling at an `asCell` position
      is sealed rather than written.
- [x] Documents: `packages/cf-harness/docs/IMPLEMENTATION_PROFILE.md` (the
      writer as a trusted host path, AH-TOOL-7),
      `packages/cf-harness/docs/CURRENT_STATE.md`.

*Exit:* the stage-2 test file passes and CFC inspection (`cf inspect`) of the
written space shows the labels the test asserts.

*As landed.* The writer takes `maxConfidentiality` — the run's observation
ceiling — in place of `modelContext`, and declares it on every node of the
schema it writes through as the result document's store policy; under the
strict rung a tainted write to a store declaring no policy is refused, and the
ceiling is the policy design §1.4 says the result fits by construction. The
runtime measures the derived join against it, so the join stays derived and
nothing asserts a label. When the result cites non-cell referents, their
documents are committed first in a transaction that reads nothing, so each
carries its declared label alone. Each uncited referent
passes the same runtime admission through an isolated prepared transaction that
is aborted; the result transaction reads the cited documents beside the
observed cells and consumes the runtime's opaque CONTENT-observation receipts,
so every observed label joins the inline text without an uncited document.
Validation uses the sanitizer's validation half only: its string-sealing
pass withholds every free string a schema does not enumerate, which is right
for a value leaving the fabric toward a model and wrong for text a model
authored on its way into the fabric. A position's declared `maxConfidentiality`
is applied by the writer to the referent placed there and stripped from the
schema the write goes through, because the runtime applies that declaration to
the whole transaction's join. The `LlmDerived` helper is exported as
`withLlmDerivedStamp` from `@commonfabric/runner/cfc`. Stage 1 supplies no
handle-table entry for a non-cell referent yet, so the writer takes those
referents, with their content and reported label, as `kind: "document"` entries
of `observedHandles`; `cf inspect` of the written space remains to be run
against a real deployment.

## Stage 3 — The `agent` builtin

**Packages:** `packages/api`, `packages/runner`, `packages/static`.
**Depends on:** nothing at compile time; stage 4 gives it a real executor.

- [x] `packages/api/index.ts` — `BuiltInAgentParams { task, inputs, resultSchema,
      maxConfidentiality?, tools? }` and `BuiltInAgentState<T> { pending,
      result?, error?, requestHash?, run? }` beside `BuiltInGenerateObjectParams`;
      `packages/static/assets/types/commonfabric.d.ts` regenerated or edited
      the way that file is maintained for the other builtins.
- [x] `packages/runner/src/builder/built-in.ts` — `export const agent =
      createNodeFactory({ type: "ref", implementation: "agent" })`;
      `builder/factory.ts` — export; `builder/builtin-replayability.ts` — row
      (non-replayable, effectful).
- [x] `packages/runner/src/builtins/agent-schemas.ts` — params schema
      (`inputs` entries `asCell`, never values; `task` a string; `tools` an
      enum over the tool names the deployment publishes), result schema, and
      a reference to the shared `LlmDerived` stamp schema.
- [x] `packages/runner/src/builtins/agent.ts` — the raw builtin, modeled on
      `generateObject` in `llm.ts`:
      - resolve inputs to links, snapshot the request with
        `createFrozenRequestSnapshot`, hash it;
      - memo: an existing `AgentRun` record for this `requestHash` in this
        instance means no new record and `pending`/`result` derive from it;
        a stored `requestHash` with no record and no result — the request
        committed and its effect did not run — is a new request and is staged
        again, the way `generateObject` treats a stored hash with neither
        result nor error;
      - stage the sink request under sink `agent` through
        `enqueueSinkRequestPostCommitEffect`, whose post-commit effect
        *creates the `AgentRun` record* (stage 4's schema) in the requesting
        space, `PerUser`, with the request fields — keyed by `requestHash`, so
        an effect that runs twice creates one record — and appends a `{link, host}`
        entry to the requester's home index through the `.inSpace` crossing;
      - derive `pending`, `result`, `error` from the record's `state`,
        `result`, `outcome`, and `errorCode` by reading the record reactively;
      - `onRejected`: settle `pending: false` with an opaque error, the way
        the llm builtins do.
- [x] Tool check: a request whose `tools` names a tool absent from the
      requester's `agentRunner.tools` entry (stage 4) fails before staging
      with `INVALID_INPUT`; when no `agentRunner` entry exists the request
      stages and stays `queued`.
- [x] `packages/runner/src/cfc/sink-inventory.ts` — `"agent"` in
      `InitialSinkName` and `KNOWN_SINKS`; a sink-class field beside the
      inventory so the gate mints `sinkClass: "agent"` for this sink and
      keeps `"network"` for the rest (`prepare.ts`, `verifySinkRequestCeilings`,
      replacing the hardcoded literal with a lookup).
- [x] `packages/runner/src/runtime-presets.ts` — the `agent` row in
      `MAX_ENFORCEMENT_SINK_GOVERNANCE`: a ceiling equal to the request's
      observation ceiling, which means the row is computed per request. If
      the registry's type only admits a static clause list, the row declares
      `[]` and the builtin meets its request against `maxConfidentiality`
      itself before staging, with a comment saying which of the two arms
      holds; record the choice in the design document's D5.
- [x] `packages/runner/src/builtins/index.ts` — registration with the result
      cell type.
- [x] Tests in `packages/runner/test/`: `agent-builtin.test.ts` (inputs
      serialized as links, task text as value, memo hit creates no record,
      abandonment settles, `pending`/`result` derive from a record a fake
      runner mutates); `agent-sink-governance.test.ts` (the `agent` row is
      total, the class is `agent`, a request whose task carries `User(other)`
      is refused under max enforcement, a request passing cells fits); the
      audit posture profile and posture tests that list sinks
      (`packages/cf-harness/audit/profiles/max-enforcement.json` and the
      tests beside it) updated by hand — the committed fixture tree lists no
      sinks, so `deno task cfc-audit-fixtures` has nothing to regenerate; the
      existing pinned ungated-llm tests unchanged.
- [x] Documents: `docs/specs/server-side-execution/builtins.md` §2 row;
      `sink-inventory.ts` JSDoc; `docs/development/EXPERIMENTAL_OPTIONS.md`
      if the builtin ships behind a flag (recommended: `agentBuiltin`, default
      off until stage 6); `docs/common/` a pattern-author page for `agent()`
      linked from `docs/common/README.md`; `docs/plans/cfc-llm-sink-admission.md`
      — note that the sink-class field now exists.

*Exit:* a pattern test in `packages/runner/test` builds a graph with `agent()`,
sees a `queued` record appear on commit, has a fake runner write `completed`
and a result link, and observes `pending: false` and `result` on the node.

## Stage 4 — Records, index, runner

**Packages:** `packages/patterns/system` (record and index patterns),
`packages/runner` (the canonical schemas, the error taxonomy, the
`#agent_queue` wish target), `packages/cli` (the runner), and
`packages/cf-harness` (two subpath exports). **Depends on:** stages 2 and 3.

- [x] Record schema — `packages/patterns/system/agent-run.tsx` exporting the
      `AgentRun` type of design §2.3 as a pattern-facing type, `PerUser` as
      `AgentRunRecord`, with the writer split documented in the type's
      comments and a view pattern whose `cancel` stream sets
      `cancelRequestedAt`. The canonical JSON schema stays in
      `packages/runner/src/builtins/agent-schemas.ts`, because the runner sits
      below the patterns package and cannot import from it;
      `packages/runner/test/agent-schemas-parity.test.ts` holds the two
      statements together.
- [x] Split-writer check (assumption 9):
      `packages/runner/test/agent-split-writer.test.ts` writes the runner's
      fields from a second client session into a record the effect created.
      The writes are admitted and the sibling-document fallback is not needed.
      The check runs with client runtimes; the same check under a serving
      runtime is not built.
- [x] Home index — `packages/patterns/system/agent-queue.tsx`: a piece holding
      `entries: { run: link, host: string }[]` and the `agentRunner` entry
      `{ host, tools, registrationId, registeredAt, lastClaimAt }`
      owner-protected the way
      `ProfileInboxPointer` is on `profile-home.tsx`, written through the
      piece's `setAgentRunner` stream; held by `home.tsx` in an `agentQueue`
      field of the home default pattern, beside `favorites` and `journal`, and
      discovered with `wish({ query: "#agent_queue", headless: true })`. The
      builtin's index write and tool check read this field; a home space
      holding no queue ends the record `refused`.
- [x] `packages/runner/src/builtins/wish.ts` — `#agent_queue` as a well-known
      home-space target resolving to `defaultPattern.agentQueue` of the home
      space, beside `#journal` and `#learned`. A hashtag search under
      `scope: ["~"]` reads favorites only, so it would not find the piece.
      Tests beside the existing well-known-target tests; the target added to
      the well-known list in `docs/common/conventions/wish.md`.
- [x] Runner — `packages/cli/commands/agent.ts` with subcommand `runner`,
      registered in `commands/main.ts`; the queue mechanics in
      `packages/cli/lib/agent-runner.ts` and the harness executor in
      `packages/cli/lib/agent-run-harness.ts`. Configuration: identity, cloud
      and local API URLs, `--loom-retrieval-config`, `--max-concurrent`
      (default 1), `--tools` (defaults to what the Loom config makes
      available), `--lease-seconds`, `--work-root`, `--model`, harness
      provider settings from `CF_HARNESS_HOME`. Behavior:
      1. open client sessions to both toolsheds as the identity — a full
         connection to the home toolshed, where the home pattern runs, and a
         storage-only runtime per other host an entry names;
      2. write or refresh the `agentRunner` entry;
      3. subscribe to the index and to each record it names; on change, claim
         the oldest `queued` record under the concurrency cap by committing
         `state: claimed`, `claim`, and `attempts` incremented;
      4. run the request through `runCfHarnessCli`, the harness's batch entry
         point, whose arguments resolve to a `HarnessSessionConfig` — input
         cells from the record's request links, `--max-confidentiality` from
         the request, `--allow-tool` from `tools`, `--loom-retrieval-config`
         from the config, prompt-slot role `context` for the task — and whose
         loop runs through `harnessSessionEngineOptions`. The runner wraps the
         `createPromptLoop` seam to pass its abort signal, renew the lease, and
         take the loop's result;
      5. renew `claim.leaseUntil` on every transcript event the harness
         persists, never on a timer;
      6. on the structured result, call stage 2's writer; write terminal
         fields (`result`, `outcome`, `usage` from the run report's
         `totalUsage`, `usageCoverage`, `modelTurns`, `toolCalls`, `runRef`);
      7. on a typed harness failure write `failed` with the taxonomy code; on
         a writer refusal write `refused`; on `cancelRequestedAt` abort through
         the harness's `signal` and write `cancelled`;
      8. on start, and on each index change, take any `claimed` or `running`
         record whose `leaseUntil` has passed: re-queue it when its `attempts`
         is one, and fail it as `RUNNER_LOST` when its `attempts` is two.
         A durable cancellation request instead ends the expired record as
         `cancelled`; another runner's live lease remains untouched.
- [x] Error taxonomy — `packages/runner/src/agent-error-codes.ts` exporting
      the codes `INVALID_INPUT`, `LIMIT_REACHED`, `PROVIDER_FAILURE`,
      `RUNNER_LOST`, `CANCELLED`, `REFUSED`, shared with the verb-refusal
      taxonomy the retention plan owes; the design document's §2.3 names it.
- [x] Tests: `packages/cli/test/agent-runner.test.ts` with a scripted
      executor, and with the harness executor over an injected
      `createPromptLoop` returning a scripted loop (the seam
      `packages/cf-harness/src/cli.ts` exposes as `deps.createPromptLoop`),
      over two in-process test toolsheds, one memory server per toolshed:
      every state transition; the memo hit creates no record; two runners
      racing claim once; a killed runner's record, left `claimed` or left
      `running`, re-queues once then fails; `cancel` mid-run ends `cancelled`;
      the `agentRunner` entry appears and refreshes on claim; a record on the
      other toolshed is found through a `{link, host}` entry. Pattern tests
      for `agent-queue.tsx` and `agent-run.tsx` under
      `packages/patterns/system`.
- [x] Documents: `packages/cli/README.md` — `cf agent runner`;
      `docs/common/conventions/HOME_SPACE.md` — the `#agent_queue` piece and
      `agentRunner` entry beside favorites; `docs/development/LOCAL_DEV_SERVERS.md`
      — how to start a runner against `dev-local`.
- [x] A structured result under an enforcing harness tool policy:
      `submit_result` (`packages/cf-harness/src/tools/submit-result.ts`), a
      host-side tool offered only when a structured-result schema is
      configured. It validates the value with the structured-result
      validation and the host writes the file the file-based path leaves; an
      invalid value returns `invalid_result` and the model submits again; a
      later valid submission replaces an earlier one; handle tokens stay
      tokens. Admitted at every mode and role as the run's return
      (`structured_result_return`). The runner's executor allows it beside a
      request's tools and validates with `asCell` positions relaxed. The
      manual `dev-local` run completes at the default `enforce-strict`.
- [x] Index entries keyed by record id. `entries.elementById(recordId)`
      added with `addUnique` gives concurrent index writes distinct entries
      without deriving their identities from the shared list length.
- [x] The runner keeps the harness default, `enforce-strict`. A
      `context`-role run is refused every tool but `submit_result`, reads
      included. A run that searches Loom or describes a handle requires an
      explicit `CF_HARNESS_CFC_ENFORCEMENT_MODE=enforce-explicit` override;
      the demonstration must document that limitation when deciding whether
      to enable `agentBuiltin` by default.
- [x] Observed Loom rows reach the result writer. Each admitted row is
      registered in the run's handle table as a held referent
      (`HarnessHandleTable.referents`, token `cfh:v:<suffix>`, with its
      content, label, and `labelSource`), its entry names the token as
      `handle`, `describe_handle` discloses kind, source, label source, and
      atom types, and `agentObservedHandlesOfTable` hands cells and referents
      to the writer. The writer mints only an observed row the result names.
      An unnamed row passes the same runtime admission in an isolated aborted
      transaction and contributes to the inline result through an opaque,
      transaction-bound CONTENT-observation receipt.

*Exit:* the stage-4 runner test suite passes across two test toolsheds, and a
manual run against `dev-local` with a real harness and a scripted model moves
a record from `queued` to `completed` with a result link that resolves. Both
hold, the second at the harness's default `enforce-strict` mode.

## Stage 5 — Inspection

**Packages:** `packages/cli`, `packages/patterns/system`. **Depends on:**
stage 4.

- [ ] `cf agent ls [--state <s>] [--json]`, `cf agent show <run> [--json]`,
      `cf agent cancel <run>` in `commands/agent.ts`, reading the index through
      the same wish the Home tab uses; `show` renders the usage block with
      `costUsd` and `estimatedCostUsd` kept apart and names the withheld
      reason when there is one.
- [ ] Completion candidates for `--state` and for `<run>` in the tables
      `tasks/check-completion-slots.ts` reads, or a recorded reason.
- [ ] Home tab "Agent runs" in `packages/patterns/system/home.tsx`: a fourth
      `cf-tab` rendering `agent-queue.tsx` — state, age, usage per record,
      a cancel action, and a "no runner registered" notice when `agentRunner`
      is absent.
- [ ] Tests: `packages/cli/test/agent-command.test.ts` (list, show, cancel
      against a seeded index); `home.test.tsx` gains the tab; a pattern test
      renders three records, one finished with usage, and the no-runner
      notice.
- [ ] Gates: `deno task check-command-docs`, `deno task check-completion-slots`,
      `deno task check-test-aliases` if any test is renamed.
- [ ] Documents: `packages/cli/README.md` — the three commands;
      `docs/common/conventions/HOME_SPACE.md` — the tab.

*Exit:* both gates pass and the tab shows a live record moving through states
against `dev-local`.

## Stage 6 — The demonstration

**Package:** `packages/patterns`. **Depends on:** stages 1–5.

- [ ] `packages/patterns/book-recommendations/` — a pattern holding a
      reader's finished books (`PerUser`, each book its own cell) and favorite
      authors, calling `agent()` with `tools: ["loom_search", "loom_page_read"]`
      and a result schema of five `{ book: asCell link, why: string }`
      entries, rendering pending state, the result, and the run's usage.
- [ ] A Loom fixture: a `ProcessRunner` fake or a fixture Loom instance
      returning two search hits and one page read with `ifc` labels.
- [ ] `cf test` for the pattern with a scripted model; an integration test
      under `packages/patterns/integration/` running the real harness with
      the scripted model against `dev-local`, asserting through `cf inspect`
      that the result document carries the join and `LlmDerived`, the five
      links resolve to the book cells with their own labels, and the minted
      Loom-row document carries the row's label.
- [ ] Flip the `agentBuiltin` flag default on, or record why it stays off.
- [ ] Archive `agent-requests-and-work-queue.md` and this document to
      `docs/history/plans/` per `docs/README.md`, add the `INDEX.md` lines,
      and run `deno task check-docs-history-index` and
      `deno task docs-links --orphan`.

*Exit:* the owner's example runs end to end and its CFC inspection reads as
the design says.

## Stage 7 — Ceilings that hold

**Packages:** `packages/runner`, `packages/cf-harness`. **Depends on:**
stage 6 for the demonstration to re-run against; otherwise independent and
may start earlier.

- [ ] Deviation 9: carry `cfcReadMaxConfidentiality` into the cell read path
      so a labeled cell outside the ceiling reads as withheld
      (`packages/runner/src/cfc/read-ceiling.ts` and the transaction read
      path); retire the session-scope requirement `run_pattern`'s description
      states; update `packages/cf-harness/docs/IMPLEMENTATION_PROFILE.md`
      deviation 9 and `packages/cf-harness/README.md` §ceiling.
- [ ] Deviation 8 / CT-2217: `delegate_task` carries the parent's observation
      ceiling into the child profile and rejects an inherited handle whose
      resolved value exceeds it (AH-CFC-12a); retire the AUD-23 known-defect
      row in `packages/cf-harness/audit/checks/known-defects.ts` and
      `packages/cf-harness/audit/conformance-manifest.ts`.
- [ ] Group ceilings: a runner test with `maxConfidentiality:
      [{anyOf:[User(A),User(B)]}]` over cells labeled `User(A)`, `User(B)`,
      and `[User(A),User(B)]`, asserting which enter model context.
- [ ] Documents: the deviation list, `docs/specs/agent-harness/03-conformance.md`
      conformance statement if a class flips.

*Exit:* the stage-6 integration test passes with the ceiling enforced by the
runtime read path rather than by the tools alone, and the two deviations are
retired from the profile.

## Stacking and parallelism

Stages 1, 2, and 3 have no dependency on each other and can be built in
parallel by three agents in three worktrees. Stage 4 needs all three. Stages 5
and 6 follow 4 in order. Stage 7 can start any time after stage 2 and lands
after 6.

Each stage is its own pull request, catch-up merged from `origin/main` before
each push, shepherded to green with the repository's gates and Cubic's review
read through `gh api --paginate repos/commonfabric/labs/pulls/<n>/comments`.

## What is deliberately not in this plan

The per-request `agent` sink ceiling and any further `maxConfidentiality`
work: the first take ships the static empty row under max enforcement with
the builtin-side check, under which a request passing a labeled cell by
reference is refused (design D5). Ranking (`priority` stays reserved). A
durable per-user ledger and quota enforcement. Loom tools returning real
per-row labels, which retires the query-label assumption the stage-1 tools
make for a row without `ifc`. Page and calendar mutation tools. A shared
runner with delegated identity. Folding hosted pattern authoring into an agent
request. Each is named in the design document under "Later, not sequenced" and
gets its own plan when it is picked up.
