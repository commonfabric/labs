# Reviewed skills: trusting a skill's text, not what it reads

This is a companion to
[Skills and MCP servers in the fabric](skills-and-mcp-bridges.md), called _the
bridge plan_ below. It uses the bridge plan's terms and those of
[What patterns and agents are made of, in the spec's terms](spec-surface-alignment.md),
called _primitives_. Question numbers refer to the primitives appendix. Spec
citations are to `commonfabric/specs` `cfc/` at `aab6afa4`.

## Why

A cf-harness `delegate_task` child that receives skill text through
`skillHandle` binds that text as `quote` (branch `alex/skill-quote-binding`,
which closes top/3606). The child's whole run binding is lowered with it. Under
the default `enforce-strict` mode the child can then only report back, and under
`enforce-explicit` it can read but not act. Falling back to `observe` and
switching skills off were both rejected.

A skill can itself carry prompt injection, and that is what the lowering guards
against. If someone the person trusts has reviewed the exact text and found
none, that reason is gone. The review should use the same mechanism as trusting
connectors: a reviewed set in a GitHub repository or organization the person
trusts, naming each skill by pin and digest. What the skill reads while it runs
is a different matter. Emails from third parties, web pages and script output
can still carry injection, and they stay tainted however trustworthy the skill
is.

## The answer in brief

- **Authority comes from the person, per call.** A run does not lose it by
  reading third-party text (section 1). The lowering on the branch is a harness
  stand-in for checks the runtime does not make yet.
- **A review is a trust statement over exact bytes.** Its concept is
  `prompt-injection-free`, and the person accepts it the way they accept a
  connector (section 2). It clears the skill's own caveats and none other.
- **The interim:** a child whose skill is fully covered by a review the person
  accepted is not lowered. It keeps the delegating run's binding, and the
  skill's text keeps the `quote` role (section 3). Everything else falls back to
  the branch's lowering.
- **Scripts are a separate claim.** A sealed script run is a `read`, whether or
  not it was reviewed. A reviewed descriptor makes other effect classes
  believable later (section 4).

## 1. Where a run's authority comes from

The spec puts authority on each invocation, not on what a run has observed.

- §3.4: "This specification minimizes broad PC propagation by relying on
  **consumable intents** as the primary authorization mechanism for one-shot
  side effects", and guard evidence "MUST come from evaluated evidence values
  (guard/result labels), not ambient `pcIntegrity` alone".
- §13.11.6 computes the `pc` of a turn that observes two ordinary tool results:
  "the meet is empty". If `direct-command` authority lived in `pc` integrity,
  every turn that reads two unrelated values would lose it.
- §15 classes `PromptSlotBound` as provenance: "slot authority must not extend
  to derivatives".
- §18.3: "The trusted kernel MUST mint `PromptSlotInfluence` onto the invocation
  record as integrity evidence when an invocation input derives from the named
  prompt-slot binding", and "Source-linked prompt-influence caveats arise only
  from labeled source values observed by the node."

In the hardened design, three things admit a call together:

1. **Who commanded the run:** `PromptSlotInfluence` on the invocation record,
   derived from the person's `PromptSlotBound{role: "direct-command"}`.
2. **Whether the person wants this effect:** an `IntentOnce` consumed at the
   commit point. §14.2.2.1: `direct-command` "does **not** by itself bypass
   `IntentOnce` requirements for sensitive tools".
3. **What steered the arguments:** the `Caveat(prompt-influence, s)` and
   material-risk clauses the arguments inherit, checked field by field at the
   sink. §8.10.5.1 asks stronger evidence for routing-sensitive fields, and it
   names "recipients, destinations, tool choices" among them.

A delegated child is §14.2.2's `spawnSubagent`: an attenuated context that
commits only the intents its parent hands it. In §13.6.1 the research child
"cannot send email because it does not have the `IntentOnce`". No rule lowers a
child because of a prompt role, and `quote` text "provides no action authority"
(§14.2.2.1) without taking away the authority of the command beside it.

Today's harness has none of the three. `evaluateToolPolicy`
(`runtime/cf-harness/src/prompt-loop.ts`) admits a call on the run's binding
alone and ignores what the model observed (H9 / CT-2175). The harness puts prompt
caveats only on browser output. The branch's lowering stands in for all of it:
text nobody vouched for, in an instruction position, costs the run its
authority. The harness already skips the lowering where someone did vouch. A
skill the operator configured from `--skills-root` binds as `context`, which
carries no authority either, and lowers nothing.

## 2. What a review is

A reviewed skill entry is a §4.8.2 trust statement:

- `concrete` names exact bytes by digest. The entry lists every file a run can
  load from the bundle (`SKILL.md`, every resource, every script) with its
  digest, keyed by its path relative to the bundle root. The `concrete` is the
  digest of that sorted list, so the bundle is reviewed as a whole and an old
  `SKILL.md` cannot be paired with a new resource. The entry also names the pin
  (`owner/repo/slug@<commit sha>`), which must match too: the digests are the
  identity and the pin is where the bytes live, so the same bytes under another
  repository fail closed;
- `implements` is `https://commonfabric.org/cfc/concepts/prompt-injection-free`,
  a concept §4.8.1 already lists;
- `verifier` is the organization whose reviewed set holds the entry.

A person accepts a set with a §4.8.3 verifier delegation. This is the trust
closure (§4.8.9) that also trusts a connector, and `runtime/runner/src/cfc/trust.ts`
already implements it as deployment config. A reviewed set is a list of such
statements, kept wherever connectors live: a default set, plus organizations a
person adds. Adding one is a potentially dangerous action, and the UI treats it
as one (question 3). The runtime checks no signatures, so in practice the
organization's branch protection is the signing key.

Revocation and expiry belong to the set, not to new fields on the entry.
Revoking an entry is a new commit of the set that drops it or lists it in the
set's revocation file, as for connectors. Expiry is §4.8.2's optional
`scope.validUntil`. Both are checked when the child starts and again at each
file load. A failure fails closed with the generic "not accepted" status of
§18.3.2. `CfcTrustStatement` in `trust.ts` has no `scope` yet, so it gains
§4.8.2's `scope: { validUntil }`.

Every listed file is fetched from the pinned commit at acquisition. Only putting
a resource into the model's context is lazy. Each load re-checks that file's
digest, and a path the entry does not list is refused. Acquisition today admits
only `SKILL.md` and `scripts/<name>` and refuses symlinks and nested directories
(`isAdmittedScript`). Admitting resources reuses that rule.

The frontmatter, `allowed-tools` included, is not part of what the entry
vouches for beyond its bytes. It stays free-form labeled data (primitives §2).
A child's tools come from what its parent hands it.

Connector trust and skill trust share the closure but not the claim. A connector
statement vouches for provenance (§5.6.3's `TrustedProvider ⊓ AuthoredBy`). A
skill statement vouches for a concept about text. A delegation names which
concepts it covers (§4.8.3 `scope.concepts`).

### 2.1 What the review clears, once source entry assigns caveats

At source entry, fetched skill text is to get `Origin`,
`Caveat(prompt-injection-risk-unscreened, s)` and `Caveat(prompt-influence, s)`
(§5.6.1). That is primitives cleanup 4, and it is not built. When the bytes'
digest matches a statement the acting person's closure accepts, the trusted
boundary mints evidence for two exchange rules:

1. **Material risk.** Value-stage `CaveatScreened{kind, source: s, stage:
   "value", valueRef, detector, verdict: "pass"}` over the exact bytes (§10.1:
   evidence "from a detector/profile the governing policy accepts", "binding the
   **exact current value**"). A node whose observation policy refuses
   unscreened text may then hold the skill.
2. **Steering.** Every call a run makes while following the skill has
   arguments, and a tool choice, that carry `Caveat(prompt-influence, s)`.
   §8.10.5 clears influence "only through ordinary exchange rules guarded by
   disclosure/acknowledgment/disclaimer/assessment evidence that binds the same
   `kind`, `source`, and sink context". Without evidence here, a reviewed skill
   would need the person's acknowledgment for every routing field it steers,
   like an unreviewed one. The atom that fits is a `CaveatAssessment` minted
   from the review, binding:
   - `kind`: prompt-influence;
   - `source`: the source-entry reference of the reviewed bytes;
   - `assessor`: the statement's verifier;
   - `evidenceDigest`: the digest of the entry and its file list;
   - `sink`: the sinks the entry declares;
   - `result`: `supported`;
   - the time of the set commit.

   It carries no `intentId`, because it is minted at source entry, before any
   intent exists. Whether an assessment minted from a review, rather than from
   one output, is admissible is a question for Berni. Until a rule admits it,
   the profile clears influence only with source- and sink-bound disclosure,
   acknowledgment or disclaimer evidence (§8.10.5), never `InjectionSafe`. The
   interim does not depend on it: no sink checks influence yet, and the
   reviewed child's binding rests on the trust statement alone.

   The clearing is scoped by kind of field, following §8.10.5.2, under which
   evidence sufficient for one sink class "MUST NOT be treated as sufficient for
   routing-sensitive or public-release fields unless the policy explicitly says
   so":
   - content fields, at action and display sinks;
   - routing fields, only at the sinks the entry declares;
   - never for a public audience.

   It is also scoped by source. An argument that an email also steered keeps
   the email's clause, so the review never launders what the skill reads.

One concept covers both jobs. Accepting a set for `prompt-injection-free`
mints both the screening evidence and the assessment.

Both are value-bound or source-bound. They never cover a summary of the skill,
a script's output, a fetched page, or anything else whose `source` is not the
reviewed bytes.

The review never mints `PromptSlotBound`, never raises the role, and never mints
`AuthoredBy` or a provenance rung. It adds no authority. A reviewed skill gets
exactly the delegating person's authority, and in the hardened design only the
intents handed to it.

### 2.2 What a review must check

Bytes are not behavior. Prose that tells the agent to fetch something and do
what it says has clean bytes, and the behavior it delegates is set by data. The
set's repository therefore keeps a versioned checklist, and each entry cites the
version it was reviewed against in §4.8.2 `scope.conditions`. The prose fails
review if it:

1. tells the agent to fetch something and follow what it says;
2. tells it to bypass checks, handle credentials, or contact destinations
   unrelated to the skill's purpose;
3. hides text, such as HTML comments, zero-width characters or encoded blobs;
4. steers toward a tool or destination it does not name, or one that does not
   fit its purpose (the routing scope in section 2.1 relies on this);
5. refers to a file the entry does not list.

Scripts are code, so what they do is a separate claim (section 4). Their bytes
are still in the list, because the prose's meaning depends on the scripts it
names, and swapping a script voids the review.

## 3. The interim: a reviewed child keeps its binding

The branch lowers a child to `quote` when its skill arrived through a handle
(`promptSlotBindingAtMost` in `prompt-loop.ts`). The interim changes that
predicate to: _when its skill arrived through a handle without accepted review
evidence_. Provisionally decided by Alex on 2026-11-26.

- **When the child is not lowered.** The pin matches, and every file the run can
  load from the bundle matches by digest a statement the acting person's closure
  accepts for `prompt-injection-free`. A missing file, a digest mismatch, an
  expired or revoked entry, or a verifier the person has not accepted: the
  branch's lowering applies unchanged.
- **The role stays `quote`.** Only the lowering predicate changes. The skill's
  text is still third-party text, and §18.3.1 declares a role "by the runtime
  input route, not by the text".
- **Uncovered files are refused.** A reviewed child does not load a bundle
  file the entry does not cover, through `read_skill_resource` or
  `run_skill_script`.
- **The decision is recorded** on the child's run manifest: the statement, the
  verifier, the entry and the file digests.

### 3.1 What it costs today

Under the interim, an injected email or page that a reviewed-skill child reads
can make it do anything the parent run could:

- `bash`, with egress on by default and DNS exempt (top/3594);
- `write_file` into the persistent workspace;
- `call_verb` writes as the person;
- sending data out in a URL (top/3595).

That is the exposure the parent run already has when it reads the same email
itself (H9), and per-call authority closes it for both. The one new exposure is
that the reviewed set becomes load-bearing: a bad review puts attacker text in a
run with the person's full authority.

### 3.2 The alternative not taken

The alternative was to keep the child lowered and let only its reviewed scripts
run, through descriptors. It needs the most unbuilt machinery: registry
snapshots, `ToolDescriptorBound`, a sink check, a sealed sandbox and a change to
strict mode. Even then, a skill with no scripts, which is most skills, still
cannot write a file. Its safety margin is also smaller than it looks. The
child's report returns to a parent that holds `direct-command` and ignores what
it observes. `scrubHandleSkillText` removes the skill's text from that report,
and nothing removes what the text made the child write. The margin is one model
hop, not a boundary, and that holds for unreviewed skills on the branch too.

### 3.3 How the interim is retired

Each piece becomes part of the hardened design:

- the entry and digest match become the trust statement checked at source
  entry;
- the manifest record becomes the minted `CaveatScreened` and
  `CaveatAssessment`;
- both arms of the lowering are deleted once calls carry `PromptSlotInfluence`
  and sinks check caveats.

## 4. Scripts

A script is code, and the review of a script is a claim about what it does, not
about injection.

- **A sealed run is a `read`, reviewed or not.** _Sealed_ means:
  - no network interface at all, rather than an egress policy, which also
    closes the DNS hole (top/3594);
  - a fresh session, and a fresh scratch working directory for each call;
  - no fabric mount, and the run's workspace either absent or read-only;
  - a sandbox target, never the host (acquired scripts are already refused on
    the host);
  - an environment cleared down to the declared arguments
    (`createClearedHostProcessEnv` exists);
  - argv, stdin and the working directory labeled as inputs
    (`cfcInputLabelPaths` exists);
  - the measured image digest on the invocation record (§18.2.2, §18.2.4.1),
    and the script digest re-checked, as it already is;
  - only stdout and stderr returned, still tainted.

  Every channel out is then off or a labeled write to scratch that dies with
  the call (§18.2.3). `commitEffect` exists only for "an externally visible side
  effect" (§14.2.2), so the run is an untrusted transition (question 7). It
  reads the skill's files, so its class is `read`. The harness has no `pure`
  class and needs none. The class is computed from the resolved sandbox profile,
  `read` when sealed and `side-effect` otherwise, and never declared. Scripts
  the operator runs on the host stay `side-effect`.
- **Today no run is sealed.** Egress is on by default, DNS is exempt
  (top/3594), a host target exists, and the default working directory is the
  persistent workspace, so a script's writes outlive the call. That is why
  `run_skill_script` is `side-effect`. One call site in `prompt-loop.ts` also
  passes a literal `"side-effect"` when it authorizes the call, and it must pass
  the tool's computed class instead.
- **A reviewed script descriptor comes later.** Each reviewed script becomes a
  §18.3.2 `ToolDescriptor` whose `contractPredicateDigest` names a §18.2.4.1
  measured contract over the script bytes, the interpreter and the sandbox
  image. That makes a stated `read` or `write` believable. A read that sends
  requests also needs a sink check, and that check needs labels on the
  arguments the model writes, an audience for each origin, and mediated egress.
  A write needs `IntentOnce`. Under the interim, a reviewed child holds the
  parent's binding, so it runs scripts on that binding like any other tool.
- **Outputs stay tainted.** stdout and stderr "inherit confidentiality caveats,
  including prompt-injection risk" (§18.2.4.1). A contract can clear material
  risk only for fields a trusted parser validates as instruction-inert, such as
  exit codes, counts and closed enums.

## What stays treated as injectable

Everything except the exact reviewed bytes:

- pages, emails and API responses the child or a script reads;
- script stdout and stderr, and any file a script writes;
- output of every other tool the child calls;
- anything the model writes, including its own summary of the skill;
- any bundle file the entry does not list;
- a skill with one byte changed, or whose entry the person has not accepted, was
  revoked or expired: it is unreviewed again.

Today "treated as injectable" means less than it will: only browser output is
marked, and no call is checked against what fed it. That is H9, and it is the
same for the parent run.

## Build order

| Step | Piece                                                                                          | Exists?                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Reviewed-set entries as trust statements, and a delegation for each accepted set               | Partly. `trust.ts` has statements with pattern concretes, delegations and the closure, as deployment config. Per-person acceptance is question 3. |
| 2    | A digest of the served bytes to match against                                                  | Yes: `acquire_skill`'s `valueDigest`, the external-ingest stamp, `run_skill_script`'s digest check.                                               |
| 3    | The lowering predicate consults the closure; the manifest records the evidence; uncovered files refused | No. The `childPromptSlotBinding` computation in `prompt-loop.ts`, plus the resource and script tools.                                     |
| 4    | Sealed `run_skill_script`, classed `read`; the literal `"side-effect"` replaced                | No. Independent of review; built after steps 1 to 3 or alongside them. It lets a lowered child run scripts under `enforce-explicit` only: under the default `enforce-strict`, even a `read` needs `direct-command`. |
| 5    | Source entry assigns prompt caveats to fetched text and script output; then the review mints `CaveatScreened` and `CaveatAssessment`, and the tier rules check `detector` | No (cleanup 4, top/1892). The tier rules in `standard-profile.ts` ignore `detector` today. |
| 6    | Per-call authority: `PromptSlotInfluence` on invocation records, argument labels, `IntentOnce` | No (H9 / CT-2175). This deletes the lowering.                                                                                                     |
| 7    | Script descriptors, registry snapshots, `ToolDescriptorBound`, the sink check                  | No (cleanups 5 and 6).                                                                                                                            |

Steps 1 to 3 are the 20%.

## Decisions for Alex

These are provisional until Berni reviews the package, like the bridge plan's.

1. **The interim.** A child whose skill is fully covered by an accepted review
   keeps the delegating run's binding, and the skill's text stays `quote`.
   Decided 2026-11-26.
2. **The entry.** A reviewed skill is a trust statement in a reviewed set, beside
   connector entries, with no separate skill registry. Decided 2026-11-26:
   1. a digest per file, keyed by bundle-relative path, and the digest of that
      sorted list as the `concrete`;
   2. the pin required, and matched as well as the digests;
   3. every listed file fetched at acquisition, each load re-checked, and
      unlisted paths refused;
   4. revocation and expiry kept in the set, with `scope: { validUntil }`
      added to the runtime's trust statements;
   5. script bytes in the list, and what a script does claimed separately by a
      tool descriptor in the same set file;
   6. a versioned review checklist in the set's repository, cited from each
      entry;
   7. frontmatter and `allowed-tools` left as free-form labeled data.
3. **What a review vouches for.** An accepted review clears the skill's own
   injection risk and its steering. Steering is cleared for content fields, for
   routing fields only at the sinks the entry declares, never for a public
   audience, and only for the skill's own source. One concept covers both.
   Decided 2026-11-26.
4. **Sealed scripts.** Built as a separate track, after steps 1 to 3 or
   alongside them, for reviewed and unreviewed skills alike. The effect class is
   computed from the sandbox profile, never declared. Decided 2026-11-26.
5. **The one-hop margin.** Filed as top/3722: a lowered child's report returns
   to a parent that ignores what it observes, so lowering is not a boundary.

## For Berni

1. **Authority per invocation.** Confirm that `direct-command` authority is
   carried per invocation (`PromptSlotInfluence` plus `IntentOnce`), that `pc`
   integrity is not consulted for it (§3.4, §13.11.6), and that observing
   `quote` text never removes it.
2. **"Derives from the named prompt-slot binding"** (§18.3). What does it
   require for a call the model writes, and for a child's calls after
   `spawnSubagent`: every call of a run the slot seeded, or something narrower?
3. **A trust statement over text.** May a trust statement's `concrete` be a
   content digest of text rather than code, with `implements:
   prompt-injection-free`, and what atom type names it? `CodeHash` is defined
   for code. May accepting it mint value-stage `CaveatScreened`
   for text that is instructions by design? §14.1.3 defines material risk as
   "attacker-provided instruction-like content", and the registry defines
   `InjectionSafe` as "instruction-inert", so the spec answers two ways. This is
   a semantic gap.
4. **Steering by a reviewed source.** Which evidence clears
   `Caveat(prompt-influence, s)` for a reviewed source at action sinks, routing
   fields and tool choice included? The options are a `CaveatAssessment` from
   the reviewer not scoped to one sink, a rule guarded by the concept, or
   nothing short of `DisclosureAcknowledged`.
5. **Tool choice as routing.** Is tool choice a routing-sensitive field of every
   call (§8.10.5.1)? If so, a run steered by any unreviewed text needs an
   acknowledgment for each call.
6. **Sealed runs.** Confirm that a run whose every channel out is off or
   mediated (§18.2.3) is an untrusted transition needing no authority, reviewed
   or not (question 7).
