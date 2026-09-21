# Hosted pattern authoring implementation plan

Implement the product contract in
[`../specs/hosted-pattern-authoring.md`](../specs/hosted-pattern-authoring.md).
The smallest useful system has one hosted agent session, two authoring
operations, and three thin entry points. It does not require the Pattern
Factory phase machine or server-primary pattern execution.

## Status

Not started, and likely superseded: the
[agent requests plan](agent-requests-and-work-queue.md) covers hosting a
`cf-harness` run for a person's request as a general capability, with the
`pattern-author` profile doing the authoring. Read that plan before starting a
stage here; the stages below stay as the inventory of what an authoring
request additionally owes (target binding, verification, publication).

## Working rules

- Keep the browser and CLI outside the authoring implementation. They submit a
  request, render events, and present the result.
- Use one persistent `cf-harness` session per request.
- Keep target authority, verification, and publication outside the model.
- Land service work dark. Do not grant production publication until CFC
  enforcement and the end-to-end negative tests pass.
- Build the existing-piece path first because its target, expected revision,
  compatibility gate, and source history make the safety boundary observable.
- Reuse the piece source lifecycle. Do not introduce another source or revision
  store for authored results.

## Prerequisites

The service contract and non-publishing harness work can begin before these
land. Existing-piece or new-space publication cannot ship until:

- the piece source lifecycle retains the complete authored-program manifest,
  including unreachable files and the public-subpath map, for generated-create
  and direct-edit revisions;
- the source lifecycle can materialize that exact retained program for an edit;
- the space-root interface validator required by the source lifecycle is
  available to the ordinary creation path.

Add focused lifecycle tests for those capabilities instead of reproducing them
inside the authoring service. Repeatable `--test` packaging and FUSE preservation
of attached `sourceRoots` are already implemented. Reuse that foundation; it is
not a replacement for the complete manifest prerequisite.

## Stage 1: shared service contract

- [ ] Define the two target shapes, start request, session snapshot, append-only
  events, terminal results, and stable error codes in a package usable by the
  server, runtime client, and CLI.
- [ ] Resolve all caller-supplied addresses on the trusted server. Store
  canonical space and piece identifiers in the session record.
- [ ] Bind existing-piece requests to the current source revision before
  queueing the session.
- [ ] Add authenticated start, read, event-stream, and cancel endpoints.
- [ ] Restrict session reads, events, and cancellation to the creating
  principal. Add a separately audited operational support role if operators
  need access.
- [ ] Apply CFC read checks to session snapshots, events, and retained
  artifacts.
- [ ] Make request creation idempotent through a caller-supplied operation
  identifier. Do not implement automatic retries.
- [ ] Add a fake executor test that drives every state transition without an
  LLM provider.
- [ ] Prove browser and CLI clients can use the same protocol types without
  importing server implementation code.

Success means a fake session can be started, observed, reconnected, cancelled,
and recovered after a service restart. No stage can publish source yet.

## Stage 2: one autonomous harness session

- [ ] Add a hosted-authoring adapter for `cf-harness`.
- [ ] Use `cf-harness` capability discovery and configuration validation for
  the selected run profile. Establish provider availability through the
  session's selected provider request and record any failure on that session;
  do not probe unrelated configured models.
- [ ] Create a writable workspace containing the candidate and a read-only
  mount containing the selected Labs source and documentation.
- [ ] For an existing piece, materialize the exact retained authored source and
  record the expected source revision. Fail before model invocation when exact
  source is unavailable.
- [ ] Give the session the general pattern-development and testing guidance,
  the current `cf`, `pattern-dev`, `pattern-test`, and `pattern-deploy` skills,
  and only the development tools needed to inspect, edit, compile, test, and
  perform allowed runtime checks.
- [ ] Load current authoring and deployment skill resources at session start.
  Do not duplicate their `cf test` or test-attachment command syntax in the
  adapter prompt.
- [ ] Instruct the agent to add or update focused pattern tests for behavior it
  changes. Require an explicit evidence-based explanation when a behavior
  cannot usefully be covered by a pattern test.
- [ ] Include every authored test file in the complete authored-program
  manifest so source retrieval, history, and revert preserve it with the
  pattern even when it is outside the runtime import graph.
- [ ] Carry the complete test-entry set from the existing `sourceRoots`
  packaging path into complete-manifest construction on every candidate create
  or update. Never publish from `sourceRoots` or a reachable closure alone. Add
  an integration test equivalent to repeatable CLI `--test` flags and to FUSE
  root preservation.
- [ ] Build an edit candidate from the complete predecessor manifest. Preserve
  unchanged test files and require the final report to name deliberate test
  deletion or replacement.
- [ ] Disable general outbound network access. Represent the model provider,
  local runtime, browser lease, and any approved fetch as separate mediated
  capabilities with fixed destinations.
- [ ] Enforce admission and per-session limits for model tokens, tool calls,
  CPU, memory, and disk. A limit failure must not publish.
- [ ] Use one prompt that states the requested outcome, available tools, target
  kind, and completion gates. Do not add phase prompts or separate repair
  sessions.
- [ ] Preserve the workspace, transcript, tool evidence, and observed CFC
  provenance in the durable session record.
- [ ] Attach the person's request provenance at trusted ingress and combine it
  with every other model observation in candidate files and model messages.
- [ ] Resume the same session after process interruption. Refuse resume when
  policy no longer permits its observations or outputs.
- [ ] Add provider-independent fixtures for compile failure, test failure,
  repair followed by success, cancellation, and process recovery.

The harness fabric session
(`packages/cf-harness/src/fabric-session.ts`) provides a host-side,
authorization-verified runtime target with no fabric credential inside the
sandbox; the adapter builds on it rather than constructing its own.

Success means a server-hosted session can produce a candidate and objective
verification evidence. The target remains unchanged.

## Stage 3: guarded existing-piece publication

- [ ] Verify the complete authored-program manifest prerequisite and retained
  program materialization path with an end-to-end lifecycle fixture.
- [ ] Add a target-bound publication capability that the harness can invoke
  without learning its token or changing its target.
- [ ] Recompile and verify the candidate outside the agent sandbox.
- [ ] In one serializable transaction, check current authority and
  compatibility against the actual retained input, compare the captured source
  revision, and publish the direct edit.
- [ ] Include authorization state, retained input, current pattern, active
  origin, and source revision in the transaction's read basis.
- [ ] Clear the active origin and append a detached revision with the authoring
  session as its cause in that same transaction.
- [ ] Keep the candidate and report a stable stale-target error after a
  concurrent edit. Do not merge or overwrite.
- [ ] Reject incompatible candidates in the first version.
- [ ] Apply CFC flow checks before source crosses a space boundary. Keep
  production publication disabled while any required check is observe-only.
- [ ] Test prompt injection that asks tools to publish to another piece or
  space. Prove the bound target cannot change.
- [ ] Test that identity keys, provider credentials, and publication secrets
  are absent from the model-visible filesystem, environment, prompts, and tool
  results.
- [ ] Test that unmediated network access fails and every resource limit ends
  the session without publication.
- [ ] Linearize cancellation against the transition to `publishing`. Test both
  race outcomes and report `too_late` when publication wins.

`cf-harness` cancels at the tool level through request abort; reuse that
mechanism when linearizing cancellation instead of adding a second
interruption path.

Success means an authorized compatible candidate changes the intended piece
once and every failure leaves it unchanged.

## Stage 4: existing-piece entry points

- [ ] Add **Request a change** to the shared piece context menu.
- [ ] Use the menu's existing nearest whole-piece resolution. Prove a request
  from a nested piece targets that inner piece, a field-level renderer is not a
  target, and a retargeted or disconnected renderer closes the unsubmitted
  form.
- [ ] Ask the service whether a complete retained authored program is available.
  Disable the menu item with an explanation when it is not.
- [ ] Add the request form, durable progress view, verification result, failure
  evidence, and cancel action.
- [ ] Render emitted progress summaries, changed files, incremental diffs, tool
  activity, and verification results from the durable event stream as they
  arrive. Tool-activity events expose only the tool name, state, and bounded
  outcome. Keep raw arguments and results out of progress events.
- [ ] Give every durable event a stable sequence identifier. Reconnect from one
  cursor with an atomic replay-to-follow handoff, with no gaps or duplicate
  entries.
- [ ] Test that source-diff events require session-source read authority and
  that tool-activity events contain no arguments, results, credentials, paths,
  or internal identifiers.
- [ ] Reopen the active or latest relevant session from the same piece menu.
- [ ] Add `cf piece change <piece>`, request text from `--request` or standard
  input, attached event output, `--detach`, and `--json`.
- [ ] Route both clients through the shared start and session APIs.
- [ ] Add one browser test and one CLI test that assert the same service request
  and final source revision.

The harness handle table and diagnostic scrubber
(`packages/cf-harness/src/handle-table.ts`) redact fabric identifiers at the
model boundary; the identifier-free progress events here are a separate
person-facing projection, but they reuse that scrubber rather than
reimplementing identifier detection.

Success means the menu and CLI complete the same existing-piece steel thread
without either client running an agent or performing publication.

## Stage 5: new-space publication

- [ ] Verify the space-root interface validator prerequisite with a focused
  ordinary-creation fixture.
- [ ] Extend the adapter with a clean top-level pattern workspace and an
  isolated test space.
- [ ] Reuse the same compile, pattern-test, runtime, evidence, and CFC gates as
  the existing-piece path.
- [ ] Reject a candidate that does not expose the operations and state required
  of a space root.
- [ ] Add a trusted publication operation that creates the space and root piece
  through the ordinary creation path.
- [ ] Initialize the root, `defaultPattern`, and detached generated-create
  revision with the authoring session as its cause in one transaction.
- [ ] Create no final space until the root candidate is verified. Clean up or
  retain internal staging data according to the service retention policy.
- [ ] Return the canonical space and root piece addresses in the terminal
  result.
- [ ] Prove failed and cancelled sessions create no visible Home entry.
- [ ] Replay the same operation identifier before and after an interrupted
  response and prove only one session and final space exist.

Success means a natural-language request produces one usable new space and no
partial product state is visible on failure.

## Stage 6: Home and command-line entry points

- [ ] Add the **Create from a request** section to the default Home pattern's
  Spaces tab, with optional space name, request, progress, result, and cancel
  controls.
- [ ] Reuse the same live, replayable session-progress component as the piece
  menu instead of implementing a Home-specific event view.
- [ ] On success, add the canonical space to Home's spaces list and navigate to
  it.
- [ ] Keep the existing add-or-open-by-name field and default pattern URL
  setting unchanged.
- [ ] Add `cf space create`, request text from `--request` or standard input,
  optional `--name`, attached event output, `--detach`, and `--json`.
- [ ] Route Home and the CLI through the same start and session APIs.
- [ ] Add one browser test and one CLI test that assert the same service request
  and final created-space result.

Success means Home and the CLI complete the same new-space steel thread.

## Stage 7: end-to-end gate and rollout

- [ ] Run existing-piece and new-space tests against a real `cf-harness`
  provider adapter in a non-production environment.
- [ ] Cover fresh deployment with browser smoke testing for a pattern whose
  behavior depends on browser events or navigation.
- [ ] Restart the authoring service during a working session and prove the same
  session resumes with its event and CFC history.
- [ ] Revoke caller authority before publication and prove the target remains
  unchanged.
- [ ] Change the target piece concurrently and prove the candidate is retained
  but not published.
- [ ] Inspect retained source, active origin, source revision cause, and revert
  behavior after an authored piece change.
- [ ] Retrieve and revert authored pieces whose test files are outside the
  runtime import graph. Prove those tests remain attached to every relevant
  source revision.
- [ ] Edit a pattern without changing one of its existing tests. Prove the next
  revision retains that unchanged test, and that a deliberate deletion is
  named in the final report.
- [ ] Confirm operator-visible metrics cover queue depth, active sessions,
  terminal outcomes, gate failures, stale targets, policy denials, and
  publication latency without exposing source or request text.
- [ ] Implement deletion of terminal workspaces, requests, transcripts, tool
  payloads, and model responses after a configured finite retention window.
  Keep only a minimal result record without those payloads.
- [ ] Resolve the default window and storage collection mechanism with
  [`retention-and-provenance.md`](retention-and-provenance.md). Keep production
  start disabled until both are configured.
- [ ] Enable production publication only after the security and lifecycle
  owners approve the enforcement evidence.
- [ ] Update the hosted authoring specification's status and archive this plan
  when every stage is complete.

## Explicitly outside this plan

Do not add multiple-agent orchestration, mandatory Pattern Factory phases,
automatic repository following, scheduled source updates, automatic stale
candidate merging, or an agent-controlled compatibility override. This plan
can grow only when a concrete product requirement or measured failure of the
single-session design requires one of those mechanisms.

Developer-tooling feedback is tracked independently in
[`hosted-pattern-authoring-tooling-feedback.md`](hosted-pattern-authoring-tooling-feedback.md).
It does not block this plan.

## Required documentation updates while implementing

- Update
  [`../specs/piece-source-lifecycle.md`](../specs/piece-source-lifecycle.md)
  when the LLM-backed create and edit status changes.
- Update the `cf-harness` implementation profile when the hosted adapter changes
  its claimed execution or CFC behavior.
- Add operator documentation for provider configuration, session retention,
  cancellation, and production enablement before rollout.
- Add a feature guide after the first complete entry point ships. The guide
  belongs under `docs/features/`; this plan is not a substitute for user-facing
  instructions.
