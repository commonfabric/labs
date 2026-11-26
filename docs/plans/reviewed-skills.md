# Reviewed skills: trusting a skill's bytes, not what it does

This is a companion to
[Skills and MCP servers in the fabric](skills-and-mcp-bridges.md), called _the
bridge plan_ below, and uses its terms and those of
[What patterns and agents are made of, in the spec's terms](spec-surface-alignment.md),
called _primitives_. Question numbers refer to the primitives appendix. Spec
citations are to `commonfabric/specs` `cfc/` at `aab6afa4`.

## Why

A cf-harness `delegate_task` child that receives skill text through
`skillHandle` binds that text as `quote` (branch `alex/skill-quote-binding`,
which closes top/3606). The child's run binding is lowered with it. In the
default `enforce-strict` mode the child can then only report back, and in
`enforce-explicit` it can read but not act. `run_skill_script` is a
`side-effect` tool, so it never runs under enforcement. Falling back to
`observe` and switching skills off were both rejected.

A skill that someone trusted has reviewed should do better: its scripts should
run under enforcement. One distinction has to stay sharp. Trusting the skill's
bytes does not make what the skill does trusted. What the skill's run reads
(fetched pages, tool output, script output) can still carry prompt injection
and is still treated that way.

## The answer in brief

The authority a reviewed skill needs comes from its **scripts' descriptors**,
not from its prose. A reviewed script is a §18.3.2 tool descriptor naming a
§18.2.4.1 measured contract, and the descriptor states the script's true effect
class in place of today's blanket `side-effect`. The descriptor is a trusted
record, not authority: discovered tools are "labeled inputs, not ambient
authority" (§14.2.2.1). It makes the stated class believable, and the ordinary
rules then decide what each call needs. A sealed read needs nothing, a read that
sends arguments out needs its sink checks, and a write needs per-call
authority.

The prose keeps the `quote` role. A role records the route text arrived by, and
a review does not change who wrote the text. Even `context` carries no action
authority (§14.2.2.1), so raising the role would buy nothing. What a review can
add to the prose is screening evidence. That only changes who may observe the
text, and it waits for source entry to assign prompt caveats at all.

All of it is one more kind of entry in the reviewed set the bridge plan already
describes. The same translator reads it into the same registry snapshot, and the
same per-person acceptance applies (question 3).

## 1. What a reviewed skill entry says

The entry names the pin (`owner/repo/slug@<commit sha>`) and commits by digest
to the whole bundle a run can load: `SKILL.md`, every file under `references/`
or other resource paths, and every script. A file the entry does not cover is
unreviewed, whatever the entry says about its neighbors. Each script also gets
an effect class, the origins it may reach if any, and the sandbox image it was
reviewed under.

Reviewing an entry is reviewing what its bytes delegate. Prose that tells the
agent to fetch something and follow what it says fails review. Its bytes are
benign, and the behavior they delegate is set by data.

## 2. The scripts: authority from the descriptor

### 2.1 A reviewed script is a descriptor with a measured contract

Each reviewed script becomes a `ToolDescriptor` in the snapshot (§18.3.2):

- `toolId` names the pin and path;
- `effectClass` is the reviewed class;
- `contractPredicateDigest` names a measured contract whose bundle predicate
  binds the script bytes, the interpreter and the sandbox image (§18.2.4.1: a
  contract for an interpreter invocation "is valid only if it is deliberately
  scoped to the specific script, argv/env shape, dependency/rootfs policy, and
  output parser"). The bundle measures `argvDigest`, but the spec defines no
  predicate over argument shape. The 20% below binds no argument shape: it
  treats arguments as untrusted inputs, which is sound only where they cannot
  leave the run.

A `run_skill_script` call for that pin and path carries
`ToolDescriptorBound(registrySnapshotDigest, descriptorDigest, toolId,
contractPredicateDigest)`. The sink checks three things: that the person
accepted the snapshot, that it has not expired or been revoked, and that the
measured bundle matches. If any measured part differs, "the invocation falls
back to the conservative rule", which is the unreviewed treatment.
`run_skill_script` already refuses a script whose bytes no longer match the
digest they were pinned at. The descriptor and the sink check do not exist yet
(primitives cleanups 5 and 6).

The descriptor reaches the policy through the hook harness tools already have:
`effectClassOf` returns the bound descriptor's class for a matching pin, path
and digest, and `side-effect` otherwise. `evaluateToolPolicy` is unchanged for
`enforce-explicit`, which already admits `read`. One call site changes: the
`run_skill_script` path in `prompt-loop.ts` passes a literal `"side-effect"` to
`evaluateToolPolicy` when it authorizes the call, and it must pass the
descriptor-derived class instead.

### 2.2 What authority each call needs

What a call needs depends on what the script can reach, not on its prose.

- **A sealed run is a `read`, reviewed or not.** _Sealed_ means:
  - no network;
  - a fresh session;
  - no fabric mount;
  - a sandbox target, never the host;
  - a fresh scratch working directory for each call;
  - the run's workspace either not mounted or mounted read-only.

  Every channel out of such a run is then either off or a labeled write to
  scratch that dies with the call (§18.2.3). `commitEffect` exists only for "an
  externally visible side effect" (§14.2.2), so the run is an untrusted
  transition, not a side effect (question 7). It reads the skill's files, so
  its class is `read`. The harness has no `pure` class, and it needs none. The
  class comes from how the sandbox is configured, not from the review.

  Today the harness cannot show that a run is sealed. Egress is on by default,
  DNS is exempt (top/3594), and a host target exists. The default working
  directory is the run's persistent workspace, so a script's writes there
  outlive the call, and later `bash` and `read_file` calls see them. That makes
  the run a `write`. This is why `run_skill_script` is `side-effect` today, and
  it is the bridge plan's sandbox hardening row.
- **A reviewed `read` that sends requests needs its sink checks.** Take a
  script that fetches from the origins its entry names and changes nothing. It
  is a reviewed read, as a reviewed MCP read is in the bridge plan, and it needs
  no per-call authority. Its arguments do go to those origins, though, and that
  is a sink release (cfs#11124's "a query is a release"). Checking that release
  needs three things the runtime lacks:
  - labels on the arguments the model writes (D4-A; the harness tracks only
    confidentiality today);
  - an audience for each reviewed origin;
  - mediated egress.

  Until all three exist, such scripts run only where the person starts them.
- **A reviewed `write` or `side-effect` needs per-call authority.** The
  descriptor says what the script does, not that the person wants it done now.
  Per §14.2.2.1, sensitive tools "still bottom out in `IntentOnce`-checked
  commit points", and `direct-command` "does not by itself bypass `IntentOnce`".
  The descriptor names the intent kind (`requiresIntentKind`). Until
  `IntentOnce` exists, the person confirms each call, which is the bridge plan's
  existing interim.

So a reviewed descriptor admits sealed reads on the existing read rule.
Reads that send requests out wait for the sink check. Write and side-effect
scripts also need H9 / CT-2175's per-call authority.

### 2.3 The confused deputy

Data the run reads can steer the model into calling a reviewed script with
arguments an attacker chose. The script being benign does not help: it becomes
a deputy. The rules above hold anyway.

- **A sealed run** reaches nothing, so steering it changes only its output, and
  that output is tainted anyway.
- **A read that sends requests** could carry workspace secrets in an argument,
  such as a query string, to a reviewed origin. Nothing about the script's
  shape stops that, and only the sink check of section 2.2 does. That is why
  those reads wait for it.
- **A write** needs an intent from the person for that call, so steering alone
  never commits it.

A descriptor admits the call but leaves the labels on its inputs and outputs as
they are:

- **Arguments** keep the influence they carry. No reviewed descriptor
  discharges it.
- **Outputs** follow §18.2.4.1's default rule: stdout and stderr "inherit
  confidentiality caveats, including prompt-injection risk". The reviewer
  vouched for the script's bytes, not for what it prints, and what it prints
  depends on what it read. A contract can clear material risk only for fields a
  trusted parser validates as instruction-inert, such as exit codes, counts and
  closed enums. Free-form output is never cleared.

## 3. The prose: observation, not authority

### 3.1 The role stays `quote`

A prompt role "is declared by trusted surface metadata or by the runtime input
route, not by the text" (§18.3.1), and §14.2.2.1 describes the roles by where
text comes from:

- `context` is "same-user notes or task context";
- `quote` is "external or third-party text".

A reviewed skill is still third-party text. The harness binds a skill the
operator configured from `--skills-root` as `context`, and that stays as it is:
the operator, who stands in for the person, configured it.

Raising the role would not restore authority anyway. `context`, like `quote`,
carries none, and the harness's own role ordering says so
(`contracts/prompt-slot.ts`: "`context` and `quote` carry none"). Only
`direct-command` admits a non-read call in `evaluateToolPolicy`. Even that is
looser than the spec, which wants `IntentOnce` for sensitive tools on top of it
(H9).

So the child given a reviewed skill runs lowered to `quote`, as on the branch.
Its reviewed scripts then run through their descriptors (section 2), and
nothing else the child might call gains anything.

### 3.2 Material risk: screening evidence from a reviewer the person trusts

When source entry assigns prompt caveats to fetched text, the text will arrive
with `Caveat(prompt-injection-risk-unscreened, s)` and
`Caveat(prompt-influence, s)`, where `s` references the source-entry record
(§5.6.1). Source entry does not assign them yet (cleanup 4, top/1892). A node
whose observation policy does not admit material risk cannot read text that
carries the first caveat.

A review can discharge that caveat for the reviewed bytes through the screening
gradient (§10.1). In this runtime that is the tier rules of
`runtime/runner/src/cfc/standard-profile.ts`
(`tier-upgrade:unscreened-to-ingress`, `tier-upgrade:ingress-to-value` and
`discharge-value-screened`):

- **Where it is minted.** At source entry, by the trusted boundary that
  computed the digest. `acquire_skill` already computes `valueDigest` over the
  bytes the pinned commit served, and the skills-root loader hashes what it
  reads. When that digest equals the entry's digest in a snapshot the acting
  person accepted, the boundary mints the ingress-stage and value-stage
  `CaveatScreened` evidence the tier rules expect. That evidence carries
  `source: s`, a `valueRef` binding the text, `verdict: "pass"`, and a
  `detector` naming the snapshot. Only the runtime mints `CaveatScreened`
  (`RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`).
- **Whose acceptance counts.** §10.1 requires evidence "from a detector/profile
  the governing policy accepts". The acceptance is a verifier delegation
  (§4.8.3, "User → Verifier → Trust Statement → Concrete Principal"): a trust
  statement (§4.8.2) whose `concrete` is the snapshot, and a delegation from
  the person to the reviewer. `runtime/runner/src/cfc/trust.ts` already has
  both. §5.6.3's `TrustedProvider ⊓ AuthoredBy` has the same conditional shape,
  but it concerns authorship, and a review is not authorship, so it does not
  apply here. Adding a set is creating that delegation,
  and its `scope.concepts` bounds what the set can vouch for. Today's tier rules
  accept a `CaveatScreened` from any trusted mint and never read `detector`, so
  they need a detector guard that goes through the acting person's trust
  closure.
- **What it never reaches.** `CaveatScreened` is value-bound (§15;
  `runtime/memory/v2/cfc-atom-classes.ts`). A non-`exactCopyOf` transformation
  drops it, so the attestation never covers a summary of the skill, a script's
  output, a page the skill fetches, or text the model writes after reading it.
  That is the spec's own guarantee for the distinction above, and it needs no
  new rule.
- **What it leaves.** `Caveat(prompt-influence, s)` stays. §10.1:
  "`PROMPT_INFLUENCE` MUST NOT be cleared by `InjectionSafe` alone". Everything
  the run derives from the skill records that the skill steered it, which is
  true.
- **What it does not mint.** It mints no provenance rung (§5.6.4). The bytes'
  rung is still the pin's, and a review says nothing about where bytes came from
  (§5.6.6). It mints no `AuthoredBy`, because the reviewer did not write the
  skill. It mints no whole-value `InjectionSafe` either: a skill is instructions
  by design, and the registry defines `InjectionSafe` as "instruction-inert".
  The discharge goes through the value-screened tier, as the runtime's
  deployment profile already does. Whether §10.1 allows that for instructions
  is the first question for Berni.

This half gains observation only. It is worth building when source entry
assigns the caveats, and not before: until then there is nothing for it to
discharge.

## What stays treated as injectable

Everything except the exact reviewed bytes:

- script stdout and stderr, and any file a script writes;
- pages and API responses a script or the child fetches;
- output of every other tool the child calls;
- anything the model writes, including its own summary of the skill;
- any file of the bundle the entry does not cover;
- a reviewed skill with one byte changed, or whose snapshot the person has not
  accepted, or that was revoked or expired: it is unreviewed again.

The skill's own influence caveat also stays on everything the run derives.

## Runtime pieces

| Piece                                                                   | Exists?                                                                                                                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Digest over the served bytes, per text and per script                   | Yes: `acquire_skill`'s `valueDigest`, `run_skill_script`'s digest check.                                                                              |
| `effectClassOf` on harness tools                                        | Yes. `run_skill_script` does not use it; its class is a fixed `side-effect`.                                                                          |
| Registry snapshots, `ToolDescriptorBound`, the sink check               | No (cleanups 5 and 6).                                                                                                                                |
| The translator reading reviewed entries into a snapshot                 | No (bridge plan step 3). A skill entry is one more entry kind.                                                                                        |
| Measured contracts with a bundle predicate and output parser            | No. `runsc --cfc` measures, but no contract registry applies. No predicate over argument shape exists, in the spec or here.                           |
| A sealed sandbox (section 2.2)                                          | Partly. Sessions are refused under enforcement. Egress, DNS (top/3594), the host target and the writable workspace as default working directory remain. |
| Labels on model-written arguments, audiences for origins, mediated egress | No. All three gate reads that send requests (D4-A, top/3594).                                                                                       |
| `IntentOnce`                                                            | No (H9 / CT-2175). Interim: the person confirms each call.                                                                                            |
| Prompt caveats on fetched skill text and on script output               | No. `stampExternalFetchIngest` mints provenance only, and the harness adds caveats only to browser output (cleanup 4, top/1892).                      |
| `CaveatScreened`: only the runtime mints it, and it is value-bound      | Yes.                                                                                                                                                  |
| Tier rules over `CaveatScreened`                                        | Yes, but they ignore `detector`. They need a guard through the trust closure.                                                                         |
| Trust statements, verifier delegations, concept guards                  | Yes, as deployment config (`cfcTrustConfig`). Per-person acceptance in the profile is question 3.                                                     |

## The 20% first

1. **Seal the skill sandbox.** Under enforcement, `run_skill_script` runs
   sealed as section 2.2 defines it, and the run record shows that it did. This
   is close to the bridge plan's interim for unreviewed scripts, plus a fresh
   scratch working directory and a workspace that is read-only or absent.
2. **Reviewed script entries.** The translator reads skill entries into the
   snapshot, beside the MCP adapters. `run_skill_script`'s `effectClassOf`
   returns `read` for a sealed run of a script whose pin, path and digest match
   a reviewed entry, and `side-effect` otherwise. The call site that passes a
   literal `"side-effect"` uses that class instead. A reviewed skill's scripts
   then run under `enforce-explicit` on the existing read rule (decision 4 asks
   whether the review is needed for that at all).
3. **Strict mode** admits sealed reads (decision 3). Reviewed skills then work
   under the default mode. Reads that send requests out are not admitted under
   either mode until their sink check exists.
4. **Writes** wait for `IntentOnce`. Until then, the person confirms each call.
5. **Screening evidence**, once source entry assigns the prompt caveats: mint
   the `CaveatScreened` pair at acquisition, and add the detector guard.

## Decisions for Alex

These are provisional until Berni reviews the package, like the bridge plan's.

1. **The entry kind.** A reviewed skill is one more entry in the reviewed set.
   It covers the pin, a digest for every file of the bundle, and each script's
   effect class, origins and sandbox image. There is no separate skill
   registry.
2. **The prose role.** Either:
   1. reviewed text stays `quote`, and the authority comes from script
      descriptors (recommended);
   2. reviewed text binds as `context`. That needs a ruling, because `context`
      is "same-user", and it restores no authority by itself.
3. **`enforce-strict`.** Strict refuses every call without `direct-command`,
   reads included, so a reviewed-skill child under the default mode still only
   reports back. The spec requires no authority for a read: it gates reads by
   observation policy and sink fit. So strict's read gate is a harness choice.
   Either:
   1. under strict, admit every read that sends nothing out of the run and
      whose class the harness can show: the builtin reads and sealed script
      runs alike (recommended). Relaxing the gate only for reviewed scripts
      would trust a third party's script over the harness's own `read_file`;
   2. keep strict as it is, and run reviewed skills under `enforce-explicit`.
4. **Sealed scripts.** A run that is provably sealed is a `read` whether or
   not it was reviewed (question 7), so an unreviewed skill's sealed scripts
   could run under enforcement too. Should review gate only the channels out,
   and not sealed computation? If yes, step 2 needs no review, and review
   matters first for reads that send requests and for writes.
5. **Rejected: lifting the child's binding.** Leaving a reviewed-skill child at
   the parent's `direct-command` binding would hand the parent's whole
   authority to a run that reads data that can carry injection. That is H9 for
   every run, and the review cannot close it. This decision confirms the
   rejection.

## For Berni

1. **Where `direct-command` lives.** Under D4-A a node's `pc` takes the plain
   integrity intersection of what it observes (§18.3). Third-party text carries
   no `direct-command` `PromptSlotBound`, so after observing it the `pc` may
   hold none. Alternatively, the authority persists per invocation through
   `PromptSlotInfluence`, and steering is handled by influence caveats at
   sinks, which is how §13.6 reads. Which is it? The first reading makes the
   harness's run-level lowering spec behavior for any observed third-party
   text, fetched pages included. The second makes it an interim.
2. **Screening text that is instructions by design.** §14.1.3 defines material
   risk as "attacker-provided instruction-like content", and the registry
   defines `InjectionSafe` as "instruction-inert". A reviewed skill is
   instruction-like and, according to the review, not attacker-provided. May
   value-stage `CaveatScreened{verdict: "pass"}` discharge material risk on
   such text? Or does it need a distinct discharge? The spec answers this two
   ways, so it is a semantic gap.
3. **A review as a detector.** May the `detector` of a `CaveatScreened` be a
   reviewed registry snapshot, a human review of exact bytes, accepted through
   a trust statement and verifier delegation (§4.8.2–4.8.3)? §14.2.2.1 says
   free-form tool documentation must not become "caveat-clearing evidence
   merely because it came from a registry". The claim here is that an explicit
   attestation over a digest, by a reviewer the person trusts, is more than
   coming from a registry. This is also question 3's open half: can the
   `concrete` of a trust statement be a descriptor file named by content hash?
4. **Sealed runs need no authority.** Confirm that a run whose every channel
   out is off or mediated (§18.2.3) is an untrusted transition that needs no
   authority, reviewed descriptor or not. This is question 7 applied to effect
   classes, so a reading, not a new rule.
5. **Argument shape in a measured contract.** §18.2.4.1 scopes a contract to an
   "argv/env shape" but defines no predicate over it, only `argvDigest`. A
   reviewed read that sends requests will want one. Is that a profile choice
   (chapter 18), or does it need a ruling?
