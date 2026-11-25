# Skills and MCP servers in the fabric

This builds on
[What patterns and agents are made of, in the spec's terms](spec-surface-alignment.md),
called _primitives_ below. Every term here is defined in one of three places:
primitives, the CFC specification, or cfs#11124, merged as
[`docs/development/proposals/mcp-bridge.md`](https://github.com/commonfabric/cfs/blob/main/docs/development/proposals/mcp-bridge.md)
in the cfs repository. Where this proposal would need a rule that none of those
has, the rule goes into the primitives appendix with a provisional answer, and
not into the design.

## Why

A tinkerer arrives with a folder of Agent Skills and a few MCP servers. We want
to tell them: bring them, they work in the fabric, and they work better here.
What they read is labeled, what they send is gated, and the people they share
with keep the same guarantees. Then, one piece at a time, the work moves into
patterns, which give it UI, sharing and composition that a skill never will.

Skills and MCP are popular now and will fade, the way Gopher did once the web
arrived. So the fabric gets bridges at its edge, and its core gets no skill or
MCP concept. Primitives §2 shows that the core needs none: a skill is fetched
text plus programs, and an MCP server is a set of discovered tools.

The goal is pragmatic and principled at once: about 80% of the value for 20% of
the effort, built so that each step is the long-term mechanism in a smaller
form. Nothing is built that a later step has to rip out.

**Assumption: the system is hardened to CFC's guarantees.** The design states
what CFC promises and relies on it. Where the runtime does not yet keep a
promise, the gap is a hardening item, listed under "Until hardening lands", and
it does not shape the design.

**Out of scope: the other direction.** This proposal brings outside tools into
the fabric. It does not cover outside agents acting on the fabric, such as
Claude Code using the fabric over MCP. User integrity comes only from actions
taken within the fabric.

## The shape

### An imported tool is a pattern

A bridge is an importer, and it emits only records that already exist
(primitives §2). For each source, that is one skill folder or one MCP server,
and the importer produces three things.

**1. A pattern, the wrapper.** Each tool is one of its verbs. Each handler makes
the tool's one outside call with builtins patterns already have:

| Tool                             | What the handler does                                                    |
| -------------------------------- | ------------------------------------------------------------------------ |
| Remote MCP tool                  | A `fetch` of the server's endpoint.                                      |
| Skill script or stdio MCP server | A sandboxed run of the pinned bytes (primitives cleanup 10).             |
| A skill's prose                  | A labeled value the wrapper exposes for agents to bind as a prompt slot. |

**2. Candidate tool descriptors (§18.3.2),** one per tool. A tool's free-form
description is labeled data behind `docRef`.

**3. Labeled values for whatever arrives as text,** entered through source
entry: `Origin`, the two prompt caveats, and only the provenance rung the
evidence shows (D1-A, §5.6).

Everything calls the verbs: other patterns, cf-harness, and `agent()` through
`call_verb`. That is the single path, so the two sides cannot drift apart.

### The one check is at the edge

The handler's outside call carries the tool's descriptor binding, which §18.3.2
calls `ToolDescriptorBound`. The runtime checks it at the sink:

- whether the descriptor is in a snapshot the caller's context accepts;
- whether that snapshot has expired or been revoked;
- whether the schema hash still matches.

None of this is built yet. The runtime has no registry snapshots, no
`ToolDescriptorBound`, and no sink check against them. They are primitives
cleanups 5 and 6, and they come before reviewed sets (step 3 below). Unreviewed
tools need none of it, because nothing about them is trusted.

The check runs in the runtime, never in generated code. A revoked tool therefore
stops at once, even if its wrapper is never regenerated.

### Lowering: how the bridge fades

Lowering means rewriting a handler. The person, or an agent, replaces one
handler's outside call with pattern code. The verb, its schema and its callers
stay the same. What changes:

- Its new descriptor no longer names an outside call.
- Its effects are reviewed again like any other change, because seeing labels is
  not the same as reviewing effects.

Lowering can then happen bit by bit and largely automatically: an agent proposes
a rewrite of one handler, and the person accepts it. When no handler makes an
outside call, the wrapper is just a pattern, and nothing that called it ever
knew it began as a skill.

## Trust: review unlocks trust, not use

### Reviewed sets

A reviewed set lives wherever connectors live. Today that is Loom's repository,
and later it will be a repository of its own. A fabric starts with the default
set, and a person can add sets from other GitHub organizations they trust. In
spec terms, a set's reviewed entries are the descriptors of a registry snapshot,
and adding a set is accepting that snapshot. Each person accepts sets once, in
their profile, and the default set comes pre-accepted. Adding another set is a
potentially dangerous action, and the UI treats it as one. A call is trusted
when the person whose authority it runs under has accepted the set (question 3).
A person's own unreviewed draft stays in their own space, and it is never a set.

### Unreviewed tools are usable, under worst-case assumptions

A candidate descriptor that is in no accepted snapshot is untrusted data, so the
runtime assumes the worst about the tool. It does not refuse it. Agents and
patterns can call it:

- **Its effect class is unknown, so it is treated as a side effect.** Each call
  needs per-call authority, which means `IntentOnce` at commit (primitives 1.4).
- **Its arguments go to the server's origin, which is a sink release.** An agent
  that has read private data cannot send that data there unless the labels allow
  it. This is cfs#11124's "a query is a release", stated as the ordinary sink
  rule.
- **Its outputs get what source entry assigns, and they are confined to the
  person who imported the tool.** That person will release them with the
  gesture-bound reclassification that any owner will use for their own data,
  once it is built (question 4).
- **A call whose outcome is unknown is not retried.** An unreviewed tool cannot
  be declared `idempotentCommit`, so it gets one attempt (question 6).

Review then adds trust, not permission. A reviewed `read` is treated as a read:
it needs no per-call authority, and agents call it freely. A reviewed tool also
gets its reviewed schema pins.

### Skill prose

Third-party prose binds as `quote`. §14.2.2.1 defines `context` as "same-user
notes or task context". §18.3.1 says a README containing "ignore previous
instructions" stays `quote`. A person's own skill, which they wrote, may bind as
`context`. Neither role carries authority for actions. Text can steer an agent,
but it cannot authorize an effect. Effects need per-call authority
(`IntentOnce`), and a call that quoted text influenced is not admitted on the
run's direct-command authority alone. Review would add nothing here, because
nobody can certify prose as injection-safe.

### Credentials

No credential enters a sandbox, a pattern, or a model context.

- **Remote MCP calls.** The token goes in a declared authority-only field of the
  handler's fetch (§5.3.1, for example `options.headers.Authorization`). It is
  released at the sink with an `AuthorizedRequest` (§5.2). None of that is
  enforced yet. A policy template can declare `dependencies.authorityOnly`
  (`runtime/runner/src/cfc/policy.ts`), but the declaration is only validated:
  nothing protects a request field or mints an `AuthorizedRequest`. Until that
  enforcement exists, the bridge stores no tokens, and a server that needs one
  waits.
- **Stdio servers that read a key from their environment.** These wait. Swapping
  a placeholder for the real key on the way out does not work:
  - it needs TLS interception inside the sandbox;
  - signing keys such as SigV4 never travel in a request;
  - a server can echo the placeholder back through a field the origin stores.

## Reviewed sets and Loom's adapters

Labs keeps descriptors in §18.3.2's terms. A translator turns Loom's reviewed
adapters into those descriptors.

**Fields the descriptor carries:**

| cfs#11124 field              | Descriptor field                                                          |
| ---------------------------- | ------------------------------------------------------------------------- |
| `class`                      | `effectClass` (a tool marked `off` is left out)                           |
| `schemaDigest`               | close to the schema hashes, but it is one digest with reviewed exclusions |
| `validUntil`, `revoked.json` | snapshot expiry and revocation                                            |

**Fields that stay Loom host policy until Berni rules on cfs#11124's
correspondence table:**

- `labels.audienceFrom` and `authorFrom`, which declassify. Provisionally, a
  trusted connector's access claims may set the audience, once a person's DID is
  bound to the principals the connector mints (question 8);
- argument roles, `effects`, `commit` and `perIntent`;
- `origin` and `oauthIssuer`, `egress`, `budget`, `retention`, `actsAs`,
  `effectsBy` and `preview`;
- `reviewedBy`, read as a trust statement (question 3).

**The two formats converge.** As rows of that table are ruled, the ruled fields
become a shared format in the shared connectors repository, and the translator
shrinks toward the identity. Until then, it keeps unruled fields out of the
runtime.

## The 20% we build first

Each step is the long-term mechanism in a smaller form.

1. **Skills for every agent.** Generalize what cf-harness already does to
   `agent()`. The harness takes skills from `--skills-root` and from skills.sh
   pins, and loads them with `acquire_skill` (see
   [acquiring skills from the open internet](external-skill-acquisition.md)).
   For `agent()`:
   - prose enters through source entry and binds as `quote` (primitives cleanups
     2 and 4);
   - the four harness skill tools become aliases over the general operations
     (cleanup 1).

   Agents can use prose skills everywhere, and harness runs keep scripts.
2. **`cf import mcp <url>`.** It generates the wrapper pattern and the candidate
   descriptors, and each handler fetches the server's endpoint. Two things come
   first:
   - [handler-callable egress](handler-callable-egress.md), because today a
     handler cannot issue a request and await its result. Its "through the
     commit boundary" route is the runtime outbox of question 1, which carries a
     click's evidence to the effect and writes the result back to a cell. The
     verb's caller reads the result from that cell, so `call_verb` must be
     notified when the cell settles rather than when the handler returns, and
     that is part of this step;
   - source entry for fetched responses (primitives cleanup 4, top/1892), so
     that what a server returns arrives labeled and is never left unlabeled.

   Servers that need a token wait for the authority-only enforcement described
   under "Credentials". Unreviewed tools run under worst-case assumptions. Until
   `IntentOnce` exists, that means the person confirms each call. Remote MCP
   servers are then usable from patterns and agents.
3. **The translator, and accepted sets.** It reads the connectors repository's
   reviewed adapters into a snapshot that the fabric accepts. Reviewed reads
   become free for agents.
4. **`cf import skill`** builds the same wrapper for a skill. Its scripts run in
   the sandbox, with each channel out of it either mediated like any other sink
   or switched off (question 7). Skill scripts and stdio MCP servers then reach
   patterns.

**Later:**

- stdio servers that need keys;
- long-lived stdio sessions, whose taint only grows until a restart (question
  5);
- MCP writes with `IntentOnce`, retried only with an idempotency key that a
  reviewed descriptor vouches for (question 6);
- reads that fill cells on a schedule (cfs#11124 level 2).

## Until hardening lands

These are gaps in the runtime, not in the design. Each one is filed, and each
has an interim limit that lifts when the gap closes.

| Gap                                                                                                                                                                  | Interim limit                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| H9 / CT-2175: side effects are admitted on run-level direct-command authority. top/3606: skill text in a delegated child inherits that authority.                    | A run that holds unreviewed prose runs side effects only when the person starts them.                                |
| `IntentOnce` is unbuilt.                                                                                                                                             | Per-call authority means the person confirms each call.                                                              |
| Registry snapshots, `ToolDescriptorBound` and the sink check against them are unbuilt (primitives cleanups 5 and 6).                                                 | No reviewed sets: every imported tool runs as unreviewed.                                                            |
| Authority-only request fields are declared in policy templates but not enforced, and nothing mints `AuthorizedRequest`.                                              | The bridge stores no tokens; servers that need one wait.                                                             |
| `fetch*` assigns no source-entry labels (primitives cleanup 4, top/1892).                                                                                            | `cf import mcp` waits for it.                                                                                        |
| top/3597: `llmDialog` writes fail open, and `agent()`'s `call_verb` fails closed.                                                                                    | Agents reach wrapper verbs only through cf-harness.                                                                  |
| top/3595: tools that take a URL do not check the context label. top/3594: DNS egress.                                                                                | Runs that hold unreviewed prose do not get `web_fetch`.                                                              |
| Sandbox: not every channel out is mediated. Egress is on by default, DNS is exempt (top/3594), sessions persist between calls, and there is a host execution target. | The bridge runs unreviewed scripts with network mode `none`, a fresh session and no fabric mount, never on the host. |
| The gesture-bound reclassification of a person's own `User(A)` data is unbuilt (top/3599).                                                                           | Unreviewed outputs stay with the person who imported the tool and cannot be shared.                                  |
| Nothing binds a person's DID to the `did:mailto:` principals a connector mints.                                                                                      | `audienceFrom` stays Loom host policy.                                                                               |
| A reactive `fetch` is deduplicated by `inputHash`, and authority does not cross the reactive hop (primitives 1.7). The outbox of question 1 is unbuilt.              | Wrapper handlers call tools only from events, never from reactive recompute.                                         |

## Decisions

1. **Format.** Labs keeps a translator now, and the formats converge as rows are
   ruled.
2. **Where sets live.** Wherever connectors live: a default set, plus GitHub
   organizations a person adds.
3. **The pattern surface.** The wrapper pattern only. Its handlers use existing
   builtins, the edge call carries the descriptor binding, and agents call its
   verbs.
4. **Prose before review.** Yes. It binds as `quote`, and the interim limits
   above apply.
5. **Unreviewed tools.** They are usable under worst-case assumptions. Review
   unlocks trust, not use.

Alex answered the open questions on 2026-11-25. The answers are provisional, and
this plan builds on them without waiting. They are in the
[primitives appendix](spec-surface-alignment.md#appendix-provisional-answers-for-berni-to-confirm),
and the question numbers in this document refer to it.

## For Berni

The primitives appendix is the whole package: eight provisional answers, each
with what it asks of him. Five propose new rules (questions 1 to 4 and 8). Three
are readings of rules the spec already has and need only a check (questions 5
and 7, and the first half of question 6). Nothing in this plan waits for his
answers.
