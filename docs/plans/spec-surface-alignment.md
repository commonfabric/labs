# What patterns and agents are made of, in the spec's terms

## Why

We want any Agent Skill or MCP server to work in the fabric with little effort,
the way early browsers handled `gopher://`: a translator at the edge, and no
Gopher concepts in HTML. When Gopher faded, nothing in the web had to change. A
bridge can stay at the edge only if the core's own concepts are clear enough to
express it, and today they are not clear in the runtime:

- Patterns and the agent harness have separate vocabularies for the same
  operations.
- The harness has "skill" built in as four tools and a handle capability.
- The lowest runtime layer names one product's tools.

The CFC specification already defines the abstract surface, in §14.2.2 "System
Semantics" (Berni's, marked proposed; specs commit `e7b1bf37`), together with
the §13.11 rulings D1–D7. This document follows that section as it changes. This
document introduces nothing. It lines the runtime up with that surface: for each
spec concept, where the runtime implements it, where the runtime has two
versions of it, and where the runtime has drifted from it. Skills and MCP then
turn out to need no concept of their own.

**Rule:** every term in this document names a spec section, a ruling, or an
identifier that exists in the code. Anything that would need a new concept or
rule is in the appendix of questions for Berni, not in the body.

## 1. The spec's surface, mapped onto the runtime

§14.2.2 lists five things: labeled values, references, node contexts, trusted
transitions and untrusted transitions. It names five judgments (`canObserve`,
`canOperateAt`, `canWrite`, `canResolve`, `canUseEvidence`) and the operations
covered below. Each entry gives the spec concept, where the runtime implements
it, and where the runtime diverges.

### 1.1 Labeled values (`v@label`)

**Runtime.** Cells, with labels from `base/api/cfc.ts`.

**Diverges.**

- Blobs (`nameBlob`, `/:space/blobs`) are stored with no label.
- Ruling D1-A says "Unlabeled is not a state a value can be in past the
  boundary", but the runner's `fetch*` builtins assign no `Origin` at entry.

### 1.2 References, and opaque handles (`canResolve`, `resolveOpaque`)

The spec requires that a reference's payload is "resolved only by a trusted
runtime boundary".

**Runtime.**

- Cell links, and the `opaque` cell kind.
- The cf-harness handle table, holding `cfh:v:` referents.
- In the harness, an address never reaches the model.

**Diverges.**

- `llmDialog` asks the model to write raw `{"@link": …}` values.
- Some harness referents (Loom rows, command results, a child's returned
  strings) live only in the harness session table, so patterns cannot reach
  them.

### 1.3 Node contexts

The spec's context holds a principal context, `pc`, an observation policy,
active authority evidence, and accepted profile and registry snapshots.

**Runtime.**

- Harness sessions carry a ceiling and an accumulated model-context label
  (`contracts/cfc-model-context.ts`).
- `agent()` takes a ceiling.

**Diverges.**

- **Tools come from name lists, not snapshots.** §14.2.2.1 says discovered tools
  are "labeled inputs, not ambient authority", pinned to an accepted registry
  snapshot (§18.3.2). The runtime instead uses fixed name lists:
  `AGENT_TOOL_NAMES` (which includes eight `loom_*` names in `runtime/runner`),
  the closed `BuiltinToolId` union, and the profile enums. No registry snapshot
  exists.
- **The runner holds the user's whole key.** §14.2.2.1 Delegation requires the
  callee's principals to be a subset of the caller's, "or otherwise justified by
  an explicit policy delegation". `cf agent runner` holds the user's full key
  instead of a delegation (§4.8.3).

### 1.4 Trusted transitions

The spec's trusted transitions "may update labels, mint integrity evidence, or
consume intent/authority capabilities". The ones that exist:

**Source entry (§5.6, D1-A).** The boundary assigns confidentiality and mints
only the provenance rung its evidence establishes. The rungs are
`ConnectorObserved`, `ExternalIngest`, `NetworkProvenance` and `AuthoredBy`, and
"are not synonyms".

- **Runtime:** `custodyIngest` (`runtime/toolshed/lib/custody-ingest.ts`, over
  the stamp helpers in `runtime/runner/src/cfc/external-ingest.ts`), which mints
  `ExternalIngest`, and `stampExternalFetchIngest` in `acquire_skill`.
- **Diverges:**
  - `fetch*` mints nothing.
  - Webhook deliveries enter as a service identity with no ingest mark.
  - The pinned-fetch atom's `pinnedSource` (`base/api/cfc.ts:294`) has a
    git-commit shape, and its only minter is skill acquisition. D1's rung for
    fetched bytes is `NetworkProvenance` (§5.6), which the runtime never mints.

**Model turn (D4-A, "ordinary node").** "Untrusted model output is the absence
of integrity, never a positive atom."

- **Diverges:** labs mints a positive `LlmDerived`. D4 names it as the rejected
  option B.

**Prompt-slot binding (§18.3.1, D4 (iv)).**

- **Runtime:** the harness's direct-command / context / quote slots
  (`evaluateToolPolicy`), and `PromptSlotBound` in `base/api/cfc-authoring.ts`.
- **Diverges:** `UiPromptSlot` exists in the API, but no pattern uses it. As a
  result, `llmDialog` and pattern-started `agent()` runs carry no
  `direct-command` evidence.

**Measured execution (§18.2.4.1, D3-A).**

- **Runtime:** the cf-harness runsc driver and `runsc --cfc` result sidecars.
- **Diverges:** the pattern-side `bash` sub-pattern reaches a sandbox through a
  signed same-origin `fetch` (`PROTECTED_TOOLSHED_FIRST_PARTY_ROUTES`).
  Measurement and output identity are not applied on that path.

**Commit (`commitEffect`, §7).**

- **Runtime:** sink requests staged and checked at commit
  (`enqueueSinkRequestPostCommitEffect`, `KNOWN_SINKS`).
- **Diverges:** `IntentOnce` is unbuilt. The commit-point machinery exists, but
  intents are not consumed there. (`compileAndRun` also stages through
  `enqueueSinkRequestPostCommitEffect`, using it only as the post-commit outbox.
  It is not a sink, and nothing leaves the runtime.)

**Minting monopoly.** Only trusted transitions mint certain atoms
(`RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`, `runtime/runner/src/cfc/prepare.ts`).
This matches the spec.

### 1.5 Untrusted transitions

The spec says these "compute over values they are allowed to observe but cannot
discard caveats, mint trusted evidence, resolve opaque handles…". The runtime's
untrusted transitions are pattern code (lift and handler bodies), model turns,
and sandboxed programs. That matches the spec.

### 1.6 Operations

| Spec operation                        | Pattern side                        | Agent side                                                                                           | State                                                                                                                                              |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe`                             | cell reads                          | `read_value`, `read_skill_resource`, `describe_handle`                                               | two vocabularies. `read_skill_resource` is `read_value` over a skill's files                                                                       |
| `readFile` / `writeFile`              | none                                | sandbox file tools, `write_file`                                                                     | the sandbox filesystem is a second namespace beside cells                                                                                          |
| `createName` / `listDirectory`        | `nameBlob`, `wish` tags, piece list | `resolve_piece`                                                                                      | name occupancy is not treated as an observation                                                                                                    |
| `invokeTool`                          | `llmDialog` `invoke`, handler sends | `call_verb`, `run_command`, `weaver_action`, `run_skill_script`                                      | four catalogs with no shared descriptor. Only the host-command catalog carries effect class and result schema, which §18.3.2's descriptor requires |
| `spawnSubagent(ctx, callee, ceiling)` | `agent()` (explicit `inputs`)       | `delegate_task` (`seedSubagentHandleTable` passes handles only when their tokens appear in the text) | the callee has no ceiling of its own, and AH-CFC-12a's SHOULD is unmet                                                                             |
| `resolveOpaque`                       | link resolution                     | handle table                                                                                         | `llmDialog` raw links (see 1.2)                                                                                                                    |
| `commitEffect`                        | sink requests                       | write and side-effect tools                                                                          | `IntentOnce` unbuilt (see 1.4)                                                                                                                     |

### 1.7 Replay classes (§14.2.2.1 "Retries and partial failure")

The spec classes every step as `pure`, `readOnly`, `idempotentCommit` or
`nonReplayable`. An `idempotentCommit` step reuses one sink-approved idempotency
key, and a `nonReplayable` step is never retried automatically.

**Runtime.** A reactive `fetch` is deduped by `inputHash`
(`runtime/runner/src/builtins/fetch.ts`). That treats every fetch as `pure` or
`readOnly`.

**Diverges.** No path declares `idempotentCommit` or `nonReplayable`. "Send this
message twice" cannot be expressed, and a click handler's gesture does not reach
the commit of the fetch that a reactive node issues later. The spec concept
exists; the runtime does not express it. How authority crosses that reactive hop
is question 1 in the appendix.

## 2. Skills and MCP in these terms

No new concept is needed for either one.

### A prompt-only skill

The spec's own worked example, §13.11.4 "Fetch external text and execute its
program over fabric data", already builds one from these pieces:

- **Arrival:** its text arrives through source entry (D1-A: `Origin`, the two
  prompt caveats, and the evidenced provenance rung).
- **Use:** it is bound into a prompt slot (§14.2.2.1). Third-party text gets
  `quote`, which "provides no action authority", and a person's own notes get
  `context`. §18.3.1 confirms that a README saying "ignore previous
  instructions" stays `quote`.

Today's harness `skill-context` handle capability is a slot role under another
name, and today it is the wrong one for third-party text (top/3606).

### A skill with scripts

- Each script is `invokeTool` over a measured bundle (§18.2.4.1, D3-A).
- The harness's `run_skill_script` is that operation under another name, and
  `acquire_skill` is source entry plus a reference.
- Credentials stay outside the sandbox and are released at the sink: an
  authority-only input (§5.3.1) with `AuthorizedRequest` (§5.2).

### A remote MCP server

- **Tools:** its tool list is "discovered tool capabilities", which are labeled
  inputs (§14.2.2.1). A descriptor is trusted only when it is pinned in an
  accepted registry snapshot (§18.3.2). Free-form descriptions stay ordinary
  labeled data. MCP annotations and skills' `allowed-tools` are free-form in
  this sense.
- **Reviewed files:** "a declarative file checked in by someone you trust" is a
  registry snapshot that the node context accepts. How acceptance is authorized
  is question 3.
- **Calls:** each call is `invokeTool`, and each external write is
  `commitEffect`.
- **Responses:** responses enter through source entry, with `NetworkProvenance`.

### A stdio MCP server in a sandbox

It is a node with a measured identity. Whether one process may serve many calls
without its `pc` growing until nothing can be done is question 5.

### Unreviewed servers and skills

Their descriptors are in no accepted snapshot, so nothing about them is trusted,
and the runtime assumes the worst:

- every call is treated as a side effect;
- the arguments are released to the server's origin as a sink;
- the outputs carry only what source entry assigns.

They remain usable under those assumptions. Whether bridges should also confine
outputs to the owner is question 4.

### The rule for bridges

An importer may emit only existing records: values, references, descriptors and
patterns. If a bridge seems to need something else, either the spec needs it in
general or the bridge is wrong. Every concept a bridge uses already exists
without it, so skills and MCP can fade without the core changing.

[Skills and MCP servers in the fabric](skills-and-mcp-bridges.md) is the plan
that builds the bridges on these terms.

## 3. Cleanups

Each item lines the runtime up with a concept cited above, and none of them adds
a concept.

This is a plan, not a schedule. Whoever next works in one of these areas moves
it toward the item. Six items are on the critical path for skills and MCP, and
those are done on purpose: 1, 2, 4, 5, 6 and 10.

The items describe a direction, not an assignment. Where an owner already has
work under way, the item links to it.

1. **Fold the harness skill tools into the general operations:**
   - `acquire_skill` becomes source entry plus a reference;
   - `read_skill_resource` becomes `read_value`;
   - `run_skill_script` becomes `invokeTool`;
   - the `skill-context` capability becomes a prompt-slot role. That is `quote`
     for third-party text (top/3606).

   The tool names can stay as thin aliases, because models are trained on
   skill-shaped tools. (Ties to 1.4 and 1.6; Topics 1900 and 1771.)
2. **Widen the pinned-fetch atom.** Stop its `pinnedSource` from assuming a git
   commit, and mint D1's `NetworkProvenance` rung for fetched bytes. (Ties to
   1.4.)
3. **Replace `LlmDerived` with D4-A:** absence of integrity plus
   `TransformedBy`. (Ties to 1.4. In progress: top/1892.)
4. **Assign `Origin` and the prompt caveats in `fetch*`, per D1-A.** Label
   blobs. (Ties to 1.1. In progress: top/1892.)
5. **Move tool name lists out of `runtime/runner`,** and source tools from a
   registry snapshot as §18.3.2 describes. (Ties to 1.3.)
6. **One tool descriptor** matching §18.3.2, shared by verbs, host commands and
   harness tools. (Ties to 1.6.)
7. **One agent kernel** (§14.2.2.1). `llmDialog` and the harness stay separate
   products. They share only:
   - prompt-slot handling;
   - how handles are presented to the model.

   Raw links go. (Ties to 1.2.)
8. **Fold the duplicate builtins:**
   - the six fetch sinks (`fetchJson`, `fetchText`, `fetchBinary`,
     `fetchJsonUnchecked`, `fetchProgram`, `streamData`) become one fetch with
     decoders;
   - the one-shot model calls (`llm`, `generateText`, `generateObject`) become
     one. `llmDialog` stays separate (item 7).

   This is housekeeping inside 1.4.
9. **`delegate_task` takes explicit input handles and a callee ceiling,** as
   `agent()` already does. (Ties to 1.6, §14.2.2.1 Delegation.)
10. **Measured execution for the pattern-side sandbox path.** (Ties to 1.4.)
11. **Acting-as through delegation records (§4.8.3, `cf delegation`)** rather
    than the full key. (Ties to 1.3.)

## 4. Holes found (verified 2026-11-24, filed)

- **top/3594:** `runsc-cfc` lets a tainted task send to any host on port 53
  (`sys_cfc.go:619`, still on `commonfabric/gvisor` main `dc7baff`). That
  bypasses the sink rules (§18.2.4).
- **top/3595:** cf-harness `web_fetch` is classed read, and the URL the model
  writes leaves with no check against the context label. A native `web_search`
  child has the same shape.
- **top/3597:** the two agent surfaces disagree on write authority.
  - `llmDialog` writes need no authority evidence unless the target schema
    declares an integrity floor, in every mode, so they fail open.
  - `agent()`'s `call_verb` and `run_pattern` are always refused, because the
    task is hard-wired to `context` under `enforce-explicit`, so they fail
    closed.
- **top/3606:** cf-harness hands third-party skill text to a `delegate_task`
  child as plain prompt text, with no slot role of its own. The child also
  inherits the parent's `direct-command` binding.
- **Comment on top/1892 (Ben, in progress):** webhook payloads enter with no
  source-entry label or provenance. top/1892 already covers D1-A source entry
  and retiring `LlmDerived` (cleanups 3–4 above).

## Appendix: questions for Berni

These would need a new rule or concept, so they are out of the body. They are
meant to go to Berni as one package.

1. **Authority across the reactive hop.** A click mints gesture evidence in a
   handler, but the effect commits in a reactive node, in a later transaction.
   How does the evidence reach `commitEffect`, and may a reactive node issue
   anything but `pure` or `readOnly` steps?
2. **References handed to outside holders.** Webhook ids, ingest-channel
   bearers, space invites, invocation sessions, and exporting the fabric over
   MCP all do this. Should these be one concept, and what evidence does using
   one mint? (Out of scope: user authority for actions started outside the
   fabric. User integrity comes only from actions taken within it.)
3. **Accepting a registry snapshot.** Who may accept one into a node context,
   and can a reviewed descriptor file be the subject of a trust statement
   (§4.8.2)? This is also cfs#11124's open question.
4. **Owner confinement.** Should outputs of unreviewed bridges be confined to
   the owner by default, through a policy record (§5)?
5. **Long-lived sandbox sessions.** Under what rule may a session be
   re-baselined, so its `pc` does not grow without bound?
6. **Commits with unknown outcome, and effects that outlast the call.**
   cfs#11124 raises both, and both are general to `commitEffect`.
