# Reviewed skills: trusting a skill's text, not what it reads

This is a companion to
[Skills and MCP servers in the fabric](skills-and-mcp-bridges.md), called _the
bridge plan_ below. It uses the bridge plan's terms and those of
[What patterns and agents are made of, in the spec's terms](spec-surface-alignment.md),
called _primitives_. Question numbers refer to the primitives appendix. Spec
citations are to `commonfabric/specs` `cfc/` at `aab6afa4`.

## Why

A cf-harness `delegate_task` child that receives skill text through
`skillHandle` binds that text as `quote` (top/3606). The child's whole run
binding is lowered with it. Under the default `enforce-strict` mode the child
can then only report back, and under `enforce-explicit` it can read but not act.
Falling back to `observe` and switching skills off were both rejected.

A skill can itself carry prompt injection, and that is what the lowering guards
against. If someone the person trusts has reviewed the exact text and found
none, that reason is gone. The review should use the same mechanism as trusting
connectors: a reviewed set in a GitHub repository or organization the person
trusts, naming each skill by its id and digest. What the skill reads while it
runs is a different matter. Emails from third parties, web pages and script
output can still carry injection, and they stay tainted however trustworthy the
skill is.

## The answer in brief

- **Authority comes from the person, per call.** Reading third-party text
  removes no authority the run holds, but it taints everything the run writes
  afterward, the details of a later intent included (section 1). The lowering
  is a harness stand-in for checks the runtime does not make yet.
- **A review is a trust statement over exact bytes.** Its concept is
  `prompt-injection-free`, and the person accepts it the way they accept a
  connector (section 2). It clears the skill's own caveats and none other.
- **The interim:** a child whose skill is fully covered by a review the person
  accepted is not lowered. It keeps the delegating run's binding, and the
  skill's text keeps the `quote` role (section 3). Everything else falls back to
  the lowering.
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

Reading `quote` text removes no slot record and no intent already minted, and
`quote` text "provides no action authority" (§14.2.2.1) without taking away the
authority of the command beside it. It does cost something. Everything the run
writes after reading it carries its taint (D4-A), and that includes the
parameters of an intent refined later. §3.8.4 says "Low-integrity values …
MUST NOT determine these parameters" when they decide destination, audience or
scope. So an intent's routing is fixed before the run reads third-party text,
copied exactly from the person's own words (§8.4), or confirmed by the person.
"Reply to whoever emailed me" needs a confirmation. `pc` integrity is not where
authority lives, but it is still consulted: §3.4 keeps it for minting intents
and policy-state transitions, and §3.8.4 checks it at declassification gates.

"Derives from the named prompt-slot binding" (§18.3) has a broad reading: every
call the kernel run that the slot seeded makes derives from it. The narrow
reading, only calls whose arguments trace back to the command, is not reachable
even later: a value the model writes carries the whole `pc`, so under D4-A
argument labels cannot tell "from the command" apart from "from the email". What
narrows a call's authority is `IntentOnce` binding its operation and route,
plus the caveats checked at the sink.

A delegated child is §14.2.2's `spawnSubagent`: an attenuated context that
commits only the intents its parent hands it. In §13.6.1 the research child
"cannot send email because it does not have the `IntentOnce`". The child is its
own kernel run. It does not inherit the parent's slot role: "derivatives get
fresh influence evidence from their own runs" (§15 `PromptSlotInfluence`), and
"slot authority must not extend to derivatives" (§15 `PromptSlotBound`). No
rule lowers a child because of a prompt role.

Today's harness has none of the three. `evaluateToolPolicy`
(`runtime/cf-harness/src/prompt-loop.ts`) admits a call on the run's binding
alone and ignores what the model observed (H9 / CT-2175). The harness puts prompt
caveats only on browser output. The lowering stands in for all of it:
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
  `SKILL.md` cannot be paired with a new resource. The entry also names the
  skill's discovery id (`owner/repo/slug`), which must match too, compared
  without regard to case: the digests are the identity and the id is where
  the bytes live, so the same bytes under another repository fail closed. The
  commit the reviewer read is recorded, and is not matched. Acquisition pins
  whatever commit the default branch points at, so matching it would void
  every review at the repository's next commit, while the same bytes at a
  later commit are the bundle that was reviewed;
- `implements` is `https://commonfabric.org/cfc/concepts/prompt-injection-free`,
  a concept §4.8.1 already lists;
- `verifier` is the organization whose reviewed set holds the entry.

The atom the `concrete` names is an extension atom (§4.1.2) for a content
digest, minted on the exact bytes by source entry. It is the same atom a
reviewed descriptor file uses (primitives question 3). It is not `CodeHash`,
which the registry defines for "trusted runtime / handler / refiner / endorser
code" (§15), and its name does not say "skill".

A person accepts a set with a §4.8.3 verifier delegation to the organization
that keeps it, and each later snapshot of the set is then accepted while it is
unexpired and unrevoked (§18.3.2). This is the trust
closure (§4.8.9) that also trusts a connector, and `runtime/runner/src/cfc/trust.ts`
already implements it as deployment config. A reviewed set is a list of such
statements, kept wherever connectors live: a default set, plus organizations a
person adds. Adding one is a potentially dangerous action, and the UI treats it
as one (question 3). The runtime checks no signatures, so in practice the
organization's branch protection is the signing key.

Revocation and expiry belong to the set, not to new fields on the entry.
Revoking an entry is a new commit of the set that drops it or lists it in the
set's revocation file, as for connectors. Expiry is §4.8.2's optional
`scope.validUntil`. Both are checked when the child starts. A failure fails
closed with the generic "not accepted" status of §18.3.2. The harness checks
them itself before it asks the closure: `trust.ts`'s resolver is a pure
function of its configuration and consults no clock, so `CfcTrustStatement`
gains no `scope`.

Every file is fetched from the pinned commit at acquisition, and the bundle
digest covers every file fetched. `SKILL.md` reaches the child as the text the
handle resolves to, checked against acquisition's digest when the child starts.
`run_skill_script` re-checks a script's digest at each run and refuses a script
the acquisition did not fetch. Acquisition admits only `SKILL.md` and
`scripts/<name>` and refuses symlinks and nested directories
(`isAdmittedScript`). Admitting resources reuses that rule, with a digest
re-check at each load like a script's.

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
(§5.6.1). That is primitives cleanup 4, and it is not built. A review clears
both caveats for the reviewed bytes, each by a route this plan proposes.

1. **Material risk, by an exchange rule guarded by the concept.** The
   injection-risk caveat for source `s` is discharged when the exact current
   value carries integrity that satisfies `Concept(prompt-injection-free)`
   under the acting person's closure (§4.8.9: "Policy guards MAY require
   concepts"). The rule fires when the value is observed, so the caveat never
   enters `pc`. The review does not mint `CaveatScreened`. A passing
   `CaveatScreened` "MAY be normalized into `InjectionSafe`" (§10.1), and
   `InjectionSafe` means "instruction-inert", which a skill never is: its text
   is instructions by design. What the review establishes is §14.1.3's other
   half, that the instructions are not "attacker-provided". Whether §10.1's
   "positive injection-safe integrity such as `InjectionSafe`" admits integrity
   that satisfies the concept is a question for Berni, alongside §10.1's
   requirement that prompt-caveat release be "expressible entirely through"
   caveats, boundary contexts, `InjectionSafe`, the generic evidence atoms and
   ordinary exchange rules.
2. **Steering, by an assessment minted at each decision.** Every call a run
   makes while following the skill has arguments that carry
   `Caveat(prompt-influence, s)`. §8.10.5 clears influence "only through
   ordinary exchange rules guarded by disclosure/acknowledgment/disclaimer/
   assessment evidence that binds the same `kind`, `source`, and sink context".
   An assessment minted once, at source entry, cannot bind a sink. So the
   trusted boundary mints a `CaveatAssessment` at each release decision,
   binding:
   - `kind`: prompt-influence;
   - `source`: the source-entry reference of the reviewed bytes;
   - `sink` and `purpose`: the decision's own;
   - `assessor`: the statement's verifier;
   - `evidenceDigest`: the digest of the entry and its file list;
   - `result`: `supported`.

   Minting at each decision also checks expiry and revocation against the trust
   snapshot the decision is made under. §13.13.3's proposed rules are the
   precedent for an assessment with no intent, trusted through §4.8.

   The clearing covers content fields only, never a public audience, and only
   source `s`. Keeping it off routing is a policy choice. A route copied
   exactly from the intent (§8.4) carries no skill caveat, so there is nothing
   to clear, and a fixed destination belongs in a reviewed tool descriptor's
   `sink`, not in prose. A routing field the skill did steer still needs
   "routing-scoped evidence and an already-verified intent binding" (§8.10.5).
   An argument that an email also steered keeps the email's clause, so the
   review never launders what the skill reads.

   Until a rule admits a review-derived assessment, the profile clears influence
   only with source- and sink-bound disclosure, acknowledgment or disclaimer
   evidence (§8.10.5), never `InjectionSafe`. The interim does not depend on
   it: no sink checks influence yet, and the reviewed child's binding rests on
   the trust statement alone.

One concept covers both jobs. Accepting a set for `prompt-injection-free` lets
both the exchange rule and the assessment fire.

Both are bound to the reviewed bytes. They never cover a summary of the skill,
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
   fit its purpose;
5. refers to a file the entry does not list.

Scripts are code, so what they do is a separate claim (section 4). Their bytes
are still in the list, because the prose's meaning depends on the scripts it
names, and swapping a script voids the review.

## 3. The interim: a reviewed child keeps its binding

The harness lowers a child to `quote` when its skill arrived through a handle
(`promptSlotBindingAtMost` in `prompt-loop.ts`). The interim changes that
predicate to: _when its skill arrived through a handle without accepted review
evidence_. Provisionally decided by Alex on 2026-11-26.

- **When the child is not lowered.** The skill id matches, and every file the
  run can load from the bundle matches by digest a statement the acting person's
  closure accepts for `prompt-injection-free`. A missing file, a digest
  mismatch, an expired or revoked entry, or a verifier the person has not
  accepted: the lowering applies unchanged.
- **The role stays `quote`.** Only the lowering predicate changes. The skill's
  text is still third-party text, and §18.3.1 declares a role "by the runtime
  input route, not by the text".
- **Uncovered files are refused.** A reviewed child does not load a bundle
  file the entry does not cover. Acquisition fetches only `SKILL.md` and
  `scripts/`, the bundle digest covers every file it fetched, and
  `run_skill_script` refuses a script the acquisition did not fetch or whose
  bytes changed since, so the review covers every file the child can load.
- **The decision is recorded** on the child's run manifest: the statement, the
  verifier, the entry and the file digests.
- **Keeping the binding is itself a cut corner.** In the spec a child never
  inherits its parent's slot role; it holds only the intents handed to it
  (section 1). Every child, reviewed or not, carries the parent's binding today,
  and the lowering is the only thing that takes it away. That is CFC-debt item
  4, retired with the lowering by step 6.

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
hop, not a boundary, and that holds for unreviewed skills too.

### 3.3 How the interim is retired

Each piece becomes part of the hardened design:

- the entry and digest match become the trust statement checked at source
  entry;
- the manifest record becomes the concept-guarded exchange rule and the
  assessment minted at each decision;
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
| 1    | Reviewed-set entries as trust statements, and a delegation for each accepted set               | Yes, as an operator file: `--reviewed-skills`, read by `runtime/cf-harness/src/skills/reviewed-skills.ts`, evaluated through `trust.ts`'s closure. Per-person acceptance is question 3. |
| 2    | A digest of the served bytes to match against                                                  | Yes: `acquire_skill`'s `valueDigest`, the external-ingest stamp, `run_skill_script`'s digest check, and a bundle digest over all of them. |
| 3    | The lowering predicate consults the closure; the manifest records the evidence; uncovered files refused | Yes. The `childPromptSlotBinding` computation in `prompt-loop.ts`; the manifest's `reviewedSkill`.                          |
| 4    | Sealed `run_skill_script`, classed `read`; the literal `"side-effect"` replaced                | No. Independent of review; built after steps 1 to 3 or alongside them. It lets a lowered child run scripts under `enforce-explicit` only: under the default `enforce-strict`, even a `read` needs `direct-command`. |
| 5    | Source entry assigns prompt caveats to fetched text and script output, and mints the content-digest atom; then the concept-guarded rule clears the skill's material risk, and the boundary mints a `CaveatAssessment` at each decision | No (cleanup 4, top/1892). |
| 6    | Per-call authority: `PromptSlotInfluence` on invocation records, argument labels, `IntentOnce` | No (H9 / CT-2175). This deletes the lowering.                                                                                                     |
| 7    | Script descriptors, registry snapshots, `ToolDescriptorBound`, the sink check                  | No (cleanups 5 and 6).                                                                                                                            |

Steps 1 to 3 are the 20%.

## CFC debt

The intended policy: a skill's own bytes, reviewed by a verifier the acting
person accepts, carry no prompt injection, so holding them does not cost a run
its authority. Nothing the skill reads is cleared, and the review grants
nothing the person lacked. Steps 1 to 3 cut these corners:

1. **The atom.** A statement's `concrete` names an atom of type
   `https://commonfabric.org/cf-harness/atom/SkillBundle` (skill id and bundle
   digest), which the harness builds to ask the closure and nothing carries on
   a label. Real CFC has source entry mint a content-digest extension atom on
   the fetched bytes, shared with reviewed descriptor files (section 2).
2. **Acceptance.** The operator's file accepts its verifiers with
   deployment-root delegations (`delegator: "*"`), for everyone the run acts
   for. Real CFC has each person delegate to a verifier in their profile, with
   a set file separate from acceptance (primitives question 3).
3. **Expiry and revocation** are checked by the harness before the closure,
   once, when the child starts. A review that expires mid-run keeps covering
   that child. Real CFC checks §4.8.2 `scope.validUntil` against the trust
   snapshot each decision is made under, which minting the assessment at each
   decision does (section 2.1).
4. **The decision is the run's binding,** not each call's, and the reviewed
   child keeps its parent's binding, which a spec child never inherits. That is
   section 3's interim, deleted by step 6.

## Decisions for Alex

These are provisional until Berni reviews the package, like the bridge plan's.

1. **The interim.** A child whose skill is fully covered by an accepted review
   keeps the delegating run's binding, and the skill's text stays `quote`.
   Decided 2026-11-26.
2. **The entry.** A reviewed skill is a trust statement in a reviewed set, beside
   connector entries, with no separate skill registry. Decided 2026-11-26:
   1. a digest per file, keyed by bundle-relative path, and the digest of that
      sorted list as the `concrete`;
   2. the skill's discovery id required, and matched as well as the digests;
      the commit the reviewer read recorded but not matched, since
      acquisition pins the default branch's current commit (revised
      2026-11-26);
   3. every listed file fetched at acquisition, each load re-checked, and
      unlisted paths refused;
   4. revocation and expiry kept in the set, and checked by the harness
      before it asks the closure, so `trust.ts` stays clock-free (decided
      2026-11-26);
   5. script bytes in the list, and what a script does claimed separately by a
      tool descriptor in the same set file;
   6. a versioned review checklist in the set's repository, cited from each
      entry;
   7. frontmatter and `allowed-tools` left as free-form labeled data.
3. **What a review vouches for.** An accepted review clears the skill's own
   injection risk, by a concept-guarded exchange rule rather than
   `CaveatScreened`, and its steering of content fields, by an assessment
   minted at each decision. It never clears routing, never for a public
   audience, and only for the skill's own source. One concept covers both.
   Decided 2026-11-26.
4. **Sealed scripts.** Built as a separate track, after steps 1 to 3 or
   alongside them, for reviewed and unreviewed skills alike. The effect class is
   computed from the sandbox profile, never declared. Decided 2026-11-26.
5. **The one-hop margin.** Filed as top/3722: a lowered child's report returns
   to a parent that ignores what it observes, so lowering is not a boundary.

## For Berni

These go with the [primitives appendix](spec-surface-alignment.md#appendix-provisional-answers-for-berni-to-confirm)
as one package. Each has a provisional answer to confirm or correct.

1. **Authority per invocation.** _Provisional, a reading:_ `direct-command`
   authority is carried per invocation (`PromptSlotInfluence` plus
   `IntentOnce`), not stored in `pc` integrity (§3.4, §13.11.6). `pc` integrity
   is still consulted for minting intents and policy-state transitions (§3.4)
   and at declassification gates (§3.8.4). Reading `quote` text removes no slot
   record or minted intent, but an intent refined afterward has tainted
   parameters, which may not decide routing (§3.8.4). So routing is fixed
   before the read, copied exactly, or confirmed. _Confirm._
2. **"Derives from the named prompt-slot binding"** (§18.3). _Provisional, a
   reading:_ every call the kernel run that the slot seeded makes, permanently.
   Under D4-A the narrow per-argument reading cannot be reached, because a value
   the model writes carries the whole `pc`; `IntentOnce` and sink caveats narrow
   authority instead. A child after `spawnSubagent` is its own run with its own
   `PromptSlotInfluence` and holds only the intents handed to it (§15).
   _Confirm._
3. **A trust statement over text.** _Provisional:_
   - **Concrete:** a trust statement's `concrete` may be a content digest of
     text (§4.8.2 says "e.g., code hash"), named by an extension atom (§4.1.2)
     that reviewed descriptor files share. This half is a reading.
   - **Material risk:** accepting the statement does not mint `CaveatScreened`,
     because §10.1 lets a pass normalize into `InjectionSafe`, which means
     "instruction-inert". Instead, one exchange rule discharges the skill's own
     material-risk caveat when the exact current value satisfies
     `Concept(prompt-injection-free)` under the acting person's closure. This is
     the semantic gap: §14.1.3 defines the risk as "attacker-provided
     instruction-like content".
   - _Ask:_ does §10.1's "positive injection-safe integrity such as
     `InjectionSafe`" admit concept-satisfying integrity, given that §10.1 also
     requires prompt-caveat release to be "expressible entirely through"
     caveats, boundary contexts, `InjectionSafe`, the generic evidence atoms and
     ordinary exchange rules?
4. **Steering by a reviewed source.** _Provisional, a reading:_ a
   `CaveatAssessment` minted by the trusted boundary at each release decision,
   binding that decision's sink and purpose, with the verifier as assessor
   (§8.10.5; §13.13.3's proposed rules are the precedent). It covers content
   fields only, never a public audience, and only the skill's own source.
   Keeping it off routing is a policy choice: a route copied exactly from the
   intent (§8.4) carries no skill caveat. The alternative Berni may prefer is to
   treat reviewed text like slot-bound text, which under D4 "is not an
   untrusted influence source": source entry would assign the reviewed bytes no
   prompt caveats at all. That is simpler, but §10.1 says "Verifier-issued
   influence evidence is policy evidence, not a global implicit caveat clear",
   so it needs a rule change. _Confirm or choose._
5. **Tool choice as routing.** _Provisional, a reading:_ tool choice is
   routing-sensitive (§8.10.5.1). It needs no acknowledgment for each call,
   because a committing call's tool choice is an exact copy (§8.4) of the
   operation the intent binds, and carries no caveat to clear.
   - **A call with no release site,** such as a fabric-internal read or a
     sealed run, has nothing to clear.
   - **A committing tool's choice** must equal the intent's operation and route.
   - **A read that sends its arguments out,** such as `web_fetch`, releases them
     to a destination, which is a routing field. A reviewed descriptor that
     fixes the destination covers it. A destination the model chose needs a rule
     like §13.13's, which would be new (top/3595).

   _Confirm, and say whether the model-chosen destination rule is wanted._
6. **Sealed runs.** This is primitives question 7.
