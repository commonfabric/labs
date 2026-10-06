# CFC Integration Profile for Agent Harnesses

Status: draft 0.1

This profile defines how an agent harness participates in Contextual Flow
Control without becoming the source of authoritative CFC meaning. The
[deployment mode matrix](../cfc-enforcement-matrix.md) defines the public
enforcement-mode vocabulary. The clauses below are the complete harness-facing
obligations; the runner owns broader label, policy, and release semantics.

The public transport types include the
[prompt-slot binding](../../../packages/cf-harness/src/contracts/prompt-slot.ts),
[invocation context](../../../packages/cf-harness/src/contracts/cfc-invocation-context.ts),
[mediated observation](../../../packages/cf-harness/src/contracts/observation.ts),
and [policy trace](../../../packages/cf-harness/src/contracts/policy-trace.ts)
contracts.

## 1. Architectural split

**AH-CFC-1.** The runner or another declared trusted CFC component owns
authoritative labels, policy decisions, and release/write authorization. A
harness transports and enforces supplied evidence; it MUST NOT ask the model to
decide whether CFC permits an action.

**AH-CFC-2.** The execution substrate or mediator MUST bind observations and
side effects to the invocation that produced them. Untrusted stdout, tool JSON,
or model text MUST NOT be relabeled as trusted mediation evidence by parsing its
contents.

## 2. Prompt authority

**AH-CFC-3.** Direct-command authority MUST depend on trusted `PromptSlotBound`
evidence binding the kernel name, the authenticated subject, the named surface,
the slot role, and a digest of the exact value carrying the authority. A
UI-backed surface binds that value through render evidence. A non-UI surface,
such as a CLI or API route, MUST supply an equivalent trusted input-capture
record binding the same fields. A surface that cannot supply one MUST NOT mint
direct-command authority.

**AH-CFC-4.** Context, quoted text, retrieved documents, skills, browser
observations, child summaries, and previous model output MUST NOT mint
direct-command authority.

**AH-CFC-5.** Re-rendering, copying, summarizing, or resuming text MUST NOT
preserve prompt-slot authority unless a trusted component creates fresh binding
evidence for the new value and role.

## 3. Observation mediation and model context

**AH-CFC-6.** Before an observation is exposed to a model in an enforcing
profile, the harness MUST receive trusted mediation metadata or return a typed
opaque/denied observation. Absence of metadata MUST NOT be interpreted as an
unlabeled successful observation.

**AH-CFC-7.** Labels on observations exposed to the model MUST be accumulated as
influence on subsequent model-authored invocation inputs. Opaque or denied
observations MUST NOT be accumulated as if their content were visible.

**AH-CFC-8.** Explicit trusted input labels and derived prompt-influence labels
MUST remain distinguishable. Prompt-slot influence is recorded as
`PromptSlotInfluence`, a provenance-class integrity atom (CFC spec §15.4): it
says which inputs the bound prompt shaped, adds no confidentiality, and does not
authorize a side effect.

## 4. Side effects

**AH-CFC-9.** A side-effect request MUST carry the direct-command evidence and
input influence labels required by the selected CFC runtime profile.

**AH-CFC-10.** Tools that internally read before writing MUST include the
internal observation labels in the write decision. An implementation MUST NOT
discard labels merely because the read and write occur inside one convenience
tool.

**AH-CFC-11.** Policy denial MUST be recorded as a policy event and exposed to
the model only through the profile's typed deny/recovery channel.

## 5. Delegation

**AH-CFC-12.** Delegation is a policy transition. A child receives only the
authority, labels, skills, and capabilities explicitly bound to the child
profile.

**AH-CFC-12a.** A child profile SHOULD carry a confidentiality ceiling bounding
what the child may observe, through inherited handles, arguments, mounted files,
and any other labeled channel. Where a ceiling is in force, a read that would
observe a value above it MUST be denied even if the parent could have observed
that value, and resolving an inherited handle into a child input MUST be
rejected if the resolved value exceeds the ceiling. A deployment MUST state how
ceilings and observation policies are applied before inherited handles are
resolved.

**AH-CFC-13.** Child artifacts and raw browser/network observations remain under
the child boundary. A structured or summarized return is a new observation and
MUST pass the configured validation and mediation step before entering parent
model context.

## 6. Enforcement modes

An implementation MAY publish the following common modes:

- `disabled`: no CFC enforcement claim; normal harness containment may remain.
- `observe`: policy and mediation gaps are recorded, but otherwise available
  observations may be exposed. This is a diagnostic mode and MUST NOT be
  described as CFC enforcement.
- `enforce-explicit`: trusted metadata is required when the selected policy
  surface calls for it; explicitly unprotected operations may continue.
- `enforce-strict`: every modeled observation and side effect requires the
  evidence defined by the strict runtime profile.

**AH-CFC-14.** The selected mode and any fallback MUST be present in the run
snapshot and report.

**AH-CFC-15.** An integration that forces `observe` because trusted mediation is
not wired end to end MUST publish that as a reduced-assurance deviation with an
owner and retirement condition. It MUST NOT silently fall back from an enforcing
mode.

## 7. Evidence and retention

**AH-CFC-16.** The artifact boundary MUST retain prompt-slot evidence,
invocation-context references, mediation dispositions, policy events,
model-context influence state, and side-effect decisions sufficient to explain
why a tool result was exposed or denied.

**AH-CFC-17.** CFC evidence may itself reveal sensitive provenance. Its access
and retention boundary MUST be at least as strict as the transcript and raw tool
artifacts it explains.

## 8. Opaque reference presentation

**AH-CFC-18.** Resolving a model-bound opaque handle to a canonical reference
MUST occur before invocation policy evaluation. Possession or successful
resolution of a handle supplies neither prompt-slot authority nor a CFC release;
the resulting invocation remains subject to the same label, authority, and
side-effect checks as a directly supplied reference. The converse holds too:
minting or returning a handle to the model is not a release. A handle names a
referent without carrying it, so a tool MAY return one for a result whose
labels a model-context ceiling refuses, and a release ceiling applies only to
a value that crosses into model context.

**AH-CFC-19.** Handle mappings are sensitive provenance evidence. Their access,
retention, child-transfer, and model-disclosure boundaries MUST be at least as
strict as those of the canonical references they contain.
