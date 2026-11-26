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
rule is in the appendix, which records a provisional answer to each such
question for Berni to confirm.

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
exists; the runtime does not express it. The provisional answer to how authority
crosses that reactive hop is appendix question 1: reactive nodes stay `pure` or
`readOnly`, and effects leave through a runtime outbox that carries the click's
evidence.

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
name. Handle-delivered skill text is recorded as `quote`, and the child that
holds it runs as `quote`. The exception is an acquired skill whose whole bundle,
`SKILL.md` and every script, matches a review the run's trust closure accepts:
that child keeps the delegating run's binding, and the skill's text is still
`quote` ([reviewed skills](reviewed-skills.md)).

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
  registry snapshot that the node context accepts. Each person accepts the
  reviewer that issues the snapshots, once, in their profile (appendix question
  3, provisional).
- **Calls:** each call is `invokeTool`, and each external write is
  `commitEffect`.
- **Responses:** responses enter through source entry, with `NetworkProvenance`.

### A stdio MCP server in a sandbox

It is a node with a measured identity. One process may serve many calls. Its
state is a store that holds the labels of what went into it, so its `pc` only
grows. A restart from the measured image is a new node, and state crosses into
it only by opaque handle or as a labeled store (§18.3, appendix question 5).

### Unreviewed servers and skills

Their descriptors are in no accepted snapshot, so nothing about them is trusted,
and the runtime assumes the worst:

- every call is treated as a side effect;
- the arguments are released to the server's origin as a sink;
- the outputs carry only what source entry assigns.

They remain usable under those assumptions. Their outputs will also be confined
to the person each call runs as. That rule is provisional and nothing enforces
it yet (appendix question 4).

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
   - the `skill-context` capability becomes a prompt-slot role. Handle-delivered
     text already binds as `quote`.

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
- **Comment on top/1892 (Ben, in progress):** webhook payloads enter with no
  source-entry label or provenance. top/1892 already covers D1-A source entry
  and retiring `LlmDerived` (cleanups 3–4 above).

## Appendix: provisional answers for Berni to confirm

Each of these questions needed a rule or concept the body could not supply. Alex
answered them on 2026-11-25, and a check against the spec at `aab6afa4` revised
several answers on 2026-11-26. Every answer is provisional: the plans build on it
now, without waiting, and Berni confirms or corrects the whole package when he
reviews it.

The check found that the spec already decides most of these. Seven answers are
readings of rules the spec already has, so for those the ask is only whether we
read the spec correctly. Question 7 also names a gap: §18.2 says nothing about
network traffic out of a sandbox. Question 4 makes one policy choice, the
default for unreviewed outputs.

1. **Authority across the reactive hop.** A click mints gesture evidence in a
   handler, but an effect issued by a reactive node commits in a later
   transaction.

   _Provisional, a reading of existing rules:_ §8.10.7 already makes the outbox
   the commit path: "the transaction commits first and the effect is performed
   afterward from a durable outbox, keyed by the idempotency key bound to the
   consumed intent". The release decision and the intent check run in the
   handler's transaction, before it commits. The send re-verifies the decision's
   bindings (payload digest, destination, intent) and does not make the first
   check: the runtime "MUST re-verify the release decision's bindings before
   performing the send". The result is written back to a cell that the pattern
   reads reactively. This is the "through the commit boundary" route of
   [handler-callable egress](handler-callable-egress.md). It does not serve a
   handler that must read the response before it finishes, such as an OAuth
   refresh; that needs the plan's other route. Reactive nodes issue only `pure`
   and `readOnly` steps, which is a host arrangement. A one-shot token written to
   a cell was rejected: it turns authority into data, which can be copied, leaked
   or replayed.

   _For Berni:_ confirm that the check runs before commit and the send only
   re-verifies.
2. **References handed to outside holders.** Webhook ids, ingest-channel
   bearers, space invites, invocation sessions, and exporting the fabric over
   MCP all do this.

   _Provisional, a reading of existing rules:_ two existing mechanisms, split by
   direction.
   - **Inbound** (webhook ids, ingest bearers): what arrives carries the
     `ExternalIngest` provenance rung of its channel. Using the reference
     evidences that rung and never the issuer's own integrity, because "No two
     rungs are synonyms" (§5.6.4). §13.6.4 already keeps other people's text from
     counting as the person's authority.
   - **Outbound** (exporting the fabric over MCP, invites): a §4.3.5 durable
     grant record whose recipient is a key principal, a `did:key` that the bearer
     secret controls, so "bearer" needs no concept of its own. Expiry and
     revocation are already §4.3.5's: "An absent, malformed, unsynced, expired, or
     revoked record resolves nothing".

   This is not urgent: nothing in the skills and MCP plan needs it. (Out of scope:
   user authority for actions started outside the fabric. User integrity comes
   only from actions taken within it.)

   _For Berni:_ confirm the split.
3. **Accepting a registry snapshot.** Who may accept one into a node context,
   and can a reviewed descriptor file be the subject of a trust statement
   (§4.8.2)? This is also cfs#11124's open question.

   _Provisional, a reading of existing rules:_
   - **A person accepts a reviewer, not each snapshot.** Acceptance is a §4.8.3
     verifier delegation to the organization that keeps the set, made once in the
     person's profile. Each snapshot that verifier issues is then accepted while
     it is unexpired and unrevoked, and §18.3.2 pinning keeps a plan on the
     snapshot it was planned against. The default set's verifier comes
     pre-accepted.
   - **Adding an organization is bounded.** It is a potentially dangerous action,
     and the UI treats it as one. The delegation's existing `scope.concepts` and
     `maxConfidentiality` (§4.8.3: "Upper bound on what this verifier can
     authorize") limit what the added organization can vouch for.
   - **Whose acceptance counts depends on what the entry does.** An entry that
     only states a tool's effect class or schema is judged under the closure of
     the person the call runs as, so in a shared space each person's calls use
     their own accepted reviewers. An entry that relaxes a confidentiality clause
     (a declassifying filter, an audience taken from a server field, a
     pattern-declared policy) is judged under the closure of that clause's owner,
     because "one principal's trust choices do not silently authorize another
     principal's data release" (§5.7.5, and §5.3.3's clause-local authority).
   - **A trust statement names a file by its content hash,** with an extension
     atom for content digests (§4.1.2) that reviewed skills share
     ([reviewed skills](reviewed-skills.md), Berni question 3). A changed file is
     no longer trusted.

   The same acceptance covers reviewed declassifying filters and
   pattern-declared policies: it is the verification mechanism that top/3599
   says comes later.

   _For Berni:_ confirm, in particular that a declassifying entry is judged
   under the clause owner's closure.
4. **Owner confinement.** Should outputs of unreviewed bridges be confined to
   the owner by default?

   _Provisional, a reading of existing rules plus one policy choice:_ yes. The
   owner is the principal whose authority the call runs under: the owner of the
   credential when the call carries one, and otherwise the person acting. It is
   not the person who imported the tool. If it were, another person's call would
   carry their own clauses joined with `User(importer)` (§5.3.1), which neither
   of them could read alone. No §5 policy record is needed: the label is what
   source entry assigns from the call's record (D1-A), and §18.8 already
   normalizes a bare owner DID to `User{subject}`. The owner releases outputs
   later by ordinary widening (§8.12.7), through the handler attached to a
   trusted gesture that top/3599 lays out; that handler is unbuilt. The policy
   choice is the default itself. Review can set a different one, and most tools
   people use are expected to be reviewed, so this default mostly applies to
   drafts and niche servers.

   _For Berni:_ confirm.
5. **Long-lived sandbox sessions.** Under what rule may a session be
   re-baselined, so its `pc` does not grow without bound?

   _Provisional, a reading of existing rules:_ §18.3 already names the rule:
   "Re-baselining creates a new node; outputs from the prior node cross into it
   only by opaque handle." A session's state is a store that holds the labels of
   what went into it, and its `pc` only grows. A restart from the measured image,
   with scratch discarded, is "a new explicitly recorded invocation boundary"
   (§18.2.4). A cache that survives the restart is a store and keeps its label.

   _For Berni:_ confirm the reading.
6. **Commits with unknown outcome, and effects that outlast the call.**
   cfs#11124 raises both, and both are general to `commitEffect`.

   _Provisional, first half a reading of existing rules:_ §6.5.2 consumes an
   intent only on commit and lists a timeout as a non-commit outcome, so after a
   timeout the same intent could commit a second time. An unreviewed tool
   therefore gets `maxAttempts: 1`, with its attempt cell (§6.5.3) claimed before
   the send. §6.5.3 makes attempt cells a SHOULD; the profile makes them a MUST
   for tools that cannot be declared `idempotentCommit`. The outcome reaches the
   person as "may have happened", and a retry needs a new intent (§7.5.1). A
   reviewed tool whose descriptor says its server honors the intent's
   idempotency key can be declared `idempotentCommit` and retried with the key.

   _Second half, also a reading:_ three existing artifacts cover effects that
   outlast the call.
   - A commit still in progress is a `LongIntent` (§6.4.4).
   - A standing effect outside the fabric, such as a subscription a server
     created, is an egress record. §8.10.7 says out-of-fabric egress is
     irrevocable, so it must not be shown as a grant the person can revoke.
   - A standing permission the fabric enforces, such as a callback reference, is
     a grant (question 2).

   A person's one list of what acts for them is their current grants together
   with their past egress records.

   _For Berni:_ confirm both readings.
7. **Unreviewed sandboxed runs.** When may a sandboxed run of an unreviewed
   script count as an ordinary untrusted transition rather than a side effect,
   and what must its run record show?

   _Provisional, a reading of existing rules for a sealed run:_ a run whose every
   channel out is off or mediated is an untrusted transition and needs no
   authority, reviewed or not. `commitEffect` is for a step that "reaches an
   externally visible side effect" (§14.2.2). Sealed means:
   - no network interface;
   - a fresh session;
   - no fabric mount, and only the three mount kinds §18.2.3 allows: a measured
     immutable rootfs, scratch labeled from `pc`, or a mount declared out of
     scope;
   - stdout and stderr returned still tainted (§18.2.4.1).

   The effect class is computed from the sandbox profile, never declared. The run
   record is §18.2.2's invocation record, which carries the rootfs or image
   identity among its fields, and the script digest. The run's `pc` is coarse:
   once it reads a secret, everything it sends afterwards carries that label.
   That is ordinary process-level taint. State kept between calls is a store
   (question 5).

   _A gap:_ §18.2 mediates files, execution, output and timing, but never network
   traffic. Treating a sandbox's traffic as a `fetch` sink checked against the
   run's `pc` would be a new profile clause, with §13.13's "Every action that
   reaches a site is a release to that site" as its model. Until one exists, a
   sandbox run is sealed or it is a side effect.

   _For Berni:_ confirm the sealed form, and say whether the network clause is
   wanted.
8. **Audience from a field the server returns.** May a reviewed configuration
   assign a result's audience from a field the server returns?

   _Provisional, a reading of existing rules:_ yes, and the spec already has the
   mechanism, so §5.6.3, which is about integrity, needs no extension. A reader
   set taken from a returned field is an author-written OR-clause created with
   the value, `anyOf(User(owner), did:mailto:…)` (§3.1.8, whose own example is
   "the participants of an email message"). Invariant 7 bounds it: "A reader set
   derived from stored content is an audience parameter", allowed only over
   content within the writer's own release authority. The field must meet the
   integrity threshold, which here is `ConnectorObserved` plus trusted parsing
   (§13.12.6 covers forged fields). The owner accepting the reviewed
   configuration is the owner choosing an audience for their own content, which
   is why question 3 judges such entries under the clause owner's closure. A
   prerequisite is binding a person's DID to the `did:mailto:` principals that a
   connector mints; until that exists, `audienceFrom` stays Loom host policy.

   _For Berni:_ confirm the reading.
