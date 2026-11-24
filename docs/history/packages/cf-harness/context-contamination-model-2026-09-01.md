---
status: historical
created: 2026-09-01
archived: 2026-09-01
reason: "Point-in-time code audit of cf-harness model-context exposure and the runner CFC substrate."
---

# Context contamination in cf-harness, as implemented on 2026-09-01

This report records the implementation at `origin/main`
`660517cad45e8e64a04b30b0002ce30636a885bb`. It is an audit, not a design.
It lives under `docs/history/packages/cf-harness/` because the decisive subject
is what text enters a harness model context and what leaves that context. The
runner owns the cell-label and policy substrate examined in §2 and §4, but its
reactive dataflow is not where the missing context-exposure state is lost.

## 1. Yardsticks

The operator's target model, quoted verbatim, is:

> Any text from an external source — a skill, a web result, anything, local
> registry or online — is a possible prompt-injection carrier; what varies is
> only the label. The system's point is to track WHICH CONTEXTS HAVE BEEN
> EXPOSED. Three rules define the target:
>
> 1. DECLASSIFICATION ADDS EXPOSURE: external text entering model context
>    (skill injection, web content entering a child, a labeled cell value
>    unsealed into text) adds its origin to that context's exposure set.
> 2. EMISSIONS INHERIT EXPOSURE: everything a context emits — a child's return
>    to its parent, tool invocations it makes, cells it writes — carries that
>    context's exposure set. A subagent that did a web_fetch is tainted with web
>    origin; nothing coming out of it is more trustworthy than the website.
> 3. CELLS CARRY LABELS WITHOUT EXPOSURE UNTIL DECLASSIFIED: reactive dataflow
>    through patterns never taints anything; only the read-into-model-text event
>    does. (Skills and web text WILL be declassified — the model must look at
>    them; cells mostly need not be, except when debugging.)

The second yardstick is the operator's CFC ordering:

> The FIRST move is to structure the problem to minimize taint in the first
> place (decomposition, isolation, cells-not-context); the SECOND is to honestly
> propagate taint through every interaction; and the THIRD is that
> declassification, where necessary, must be enforced via the USER'S POLICY —
> whether it is permitted in a given situation (running in a pattern, being
> read by an agent for some task) is a policy decision, not a code default.

The implementation agrees strongly with the first move, has two separate and
uneven implementations of the second, and applies the third at runner sinks but
not at harness model-text boundaries. The runner can keep values in cells,
propagate per-path labels, and evaluate policy records at an egress; the harness
usually decides whether text crosses with a fixed local rule, or records no CFC
event at all. That is the report's central cross-module disagreement, supported
in the sections below.

## 2. The cell side: labels flow without model exposure

### 2.1 Persisted representation and resolution

Every persisted CFC envelope can carry a per-path `labelMap`. Each entry has an
independent update-discipline origin: `declared`, `link`, `derived`,
`structure`, `external-ingest`, or `label-metadata`; legacy entries have no
origin. The effective label is the join of the independently resolved origin
components
([`types.ts:158-227`](../../../../runtime/runner/src/cfc/types.ts#L158-L227)).

Within each component, the runner takes the longest covering path and joins
equal-specificity entries defensively; it then joins the winning entries across
components
([`prepare.ts:158-249`](../../../../runtime/runner/src/cfc/prepare.ts#L158-L249)).
A recursive read also joins labels below the read path, while a non-recursive
read observes only that node. Observation classes distinguish value, shape,
enumeration, and link-following; following a link consumes the link entry, and
the target content becomes labeled only when the target is actually read
([`prepare.ts:251-318`](../../../../runtime/runner/src/cfc/prepare.ts#L251-L318)).

This is the important non-contamination property: a link can carry sensitivity
and provenance through reactive structure without placing the linked value in
model text. The label is data-plane metadata until an observer consumes it.

### 2.2 Link edges

When a link is persisted, the runner reads the authoritative stored source
metadata, resolves the source-path label, and prevents an author-influenceable
carried view from weakening that result
([`prepare.ts:4451-4515`](../../../../runtime/runner/src/cfc/prepare.ts#L4451-L4515),
[`prepare.ts:6370-6414`](../../../../runtime/runner/src/cfc/prepare.ts#L6370-L6414)).
The target receives `origin: "link"`; the source subpaths are re-derived from
the stored label map, not trusted solely from the carried view
([`prepare.ts:6370-6422`](../../../../runtime/runner/src/cfc/prepare.ts#L6370-L6422)).
The runtime also mints a value-bound `LinkReference` atom containing the exact
source and target coordinates
([`prepare.ts:4375-4398`](../../../../runtime/runner/src/cfc/prepare.ts#L4375-L4398),
[`atom-classes.ts:28-46`](../../../../runtime/runner/src/cfc/atom-classes.ts#L28-L46)).

### 2.3 Derived flow and `TransformedBy`

`deriveFlowJoin` joins confidentiality from contributing observations and takes
the weakest-link meet of hereditary integrity. Pointer-follow observations and
label-metadata observations contribute confidentiality but not content
integrity
([`prepare.ts:1929-1956`](../../../../runtime/runner/src/cfc/prepare.ts#L1929-L1956),
[`prepare.ts:2015-2067`](../../../../runtime/runner/src/cfc/prepare.ts#L2015-L2067)).
When one defined implementation identity authored every non-privileged write in
the transaction, and the join is nonempty, it also mints `TransformedBy`;
ambiguous or unattributed writes omit the claim
([`prepare.ts:2068-2089`](../../../../runtime/runner/src/cfc/prepare.ts#L2068-L2089)).

The flow-label dial has three materially different effects. `off` computes no
join, `observe` computes it for diagnostics, and `persist` stamps every value
write with the joined label
([`prepare.ts:5578-5614`](../../../../runtime/runner/src/cfc/prepare.ts#L5578-L5614)).
Persisted value and existence entries use `origin: "derived"`; container
membership uses `origin: "structure"`
([`prepare.ts:6759-6807`](../../../../runtime/runner/src/cfc/prepare.ts#L6759-L6807),
[`prepare.ts:6811-6838`](../../../../runtime/runner/src/cfc/prepare.ts#L6811-L6838)).
Overwrites clear per-value `derived`, `link`, and `structure` entries under the
written path, while untouched entries retain their origin and observation
class; declared entries follow their separate monotone discipline
([`prepare.ts:6289-6350`](../../../../runtime/runner/src/cfc/prepare.ts#L6289-L6350)).
The final entries are coalesced into the persisted envelope, and canonically
equal recomputations do not rewrite it
([`prepare.ts:7037-7068`](../../../../runtime/runner/src/cfc/prepare.ts#L7037-L7068)).

The E3 result in [CT-2076](https://linear.app/common-tools/issue/CT-2076/e3-legibility-read-back-reconstruct-the-taint-story-from-persisted)
is therefore consistent with current code: a cell-side story can be rebuilt
from `labelMap` origins, `LinkReference` edges, derived entries, and
`TransformedBy`. That story is provenance of dataflow. It is not a record of
which model context saw the value.

## 3. Declassification boundaries: where text becomes model-visible

The harness turns every ordinary tool result into a JSON tool transcript
message after a tool-specific model-facing rendering pass
([`prompt-loop.ts:3418-3461`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3418-L3461)).
Only four sandbox result families are selected for CFC mediation: `bash`,
sandbox `run_skill_script`, successful `read_file`, and successful `edit_file`.
Every other tool result takes a special-case branch or the generic
`stripInternalCfcFields` path
([`prompt-loop.ts:1664-1673`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1664-L1673),
[`prompt-loop.ts:3576-3629`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3576-L3629)).
The boundaries below are the resulting inventory.

### 3.1 Structured results and labeled cell values

The shared structured-result sanitizer first validates the raw value. It
releases a string literally only when the matching schema fixes that value with
`enum` or `const`, including through the supported combinators
([`structured-result.ts:73-113`](../../../../runtime/runner/src/cfc/structured-result.ts#L73-L113)).
Other strings become `opaque:` links; arrays recurse; an unmodeled object key
seals the whole object because the key name can itself be data; and other
primitives pass through unchanged
([`structured-result.ts:404-497`](../../../../runtime/runner/src/cfc/structured-result.ts#L404-L497)).
The opaque link is only a handle id plus JSON pointer
([`observation.ts:454-472`](../../../../runtime/runner/src/cfc/observation.ts#L454-L472)).

`run_pattern` is fabric-backed, so its raw result is read from the result cell
and sanitized with the caller-supplied `resultSchema`; sealed positions are
replaced with live addresses into that result cell
([`run-pattern.ts:1313-1349`](../../../../runtime/cf-harness/src/tools/run-pattern.ts#L1313-L1349)).
The raw value remains in the tool artifact, while the prompt loop removes it,
the piece id, the raw failure message, and the inline schema before the model
sees the result
([`run-pattern.ts:1717-1729`](../../../../runtime/cf-harness/src/tools/run-pattern.ts#L1717-L1729),
[`prompt-loop.ts:3581-3605`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3581-L3605)).

This is a fixed shape rule, not a label or policy decision. Neither the
sanitizer nor the `run_pattern` extraction reads the result cell's CFC label,
and their option types carry only schema, value, handle id, and reserved keys
([`structured-result.ts:500-519`](../../../../runtime/runner/src/cfc/structured-result.ts#L500-L519),
[`run-pattern.ts:1330-1335`](../../../../runtime/cf-harness/src/tools/run-pattern.ts#L1330-L1335)).
Consequently a labeled number, boolean, or enum/const string can enter model
text without its origin being added to any model-context record. Conversely a
free string is sealed regardless of a user policy that might permit its release.

### 3.2 Skill injection and skill resources

`loadHarnessSkillContextFromText` inserts the exact handle-resolved cell text in
a `<skill_context source="handle:…">` model-context block. Its activation records
the handle source, exact payload digest, activation time, and prompt role
`context`
([`registry.ts:824-852`](../../../../runtime/cf-harness/src/skills/registry.ts#L824-L852)).
Registry skills are read from local files and injected in the same kind of
block; their activation records registry paths and digest
([`registry.ts:855-913`](../../../../runtime/cf-harness/src/skills/registry.ts#L855-L913)).
The activation contract calls the handle token plus digest “provenance,” but it
is harness audit metadata, not a CFC atom or a label on model context
([`skill.ts:187-226`](../../../../runtime/cf-harness/src/contracts/skill.ts#L187-L226)).
The child passes both forms as `contextMessages` after persisting their
activations
([`prompt-loop.ts:3982-4040`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3982-L4040)).
No `HarnessCfcModelContextObservation` is created at either injection site.

Supporting skill resources have a second direct text path. The tool reads the
call-time file, computes and compares registry and observed digests, and returns
the truncated decoded bytes in `content`
([`read-skill-resource.ts:420-480`](../../../../runtime/cf-harness/src/tools/read-skill-resource.ts#L420-L480),
[`read-skill-resource.ts:503-528`](../../../../runtime/cf-harness/src/tools/read-skill-resource.ts#L503-L528)).
Because `read_skill_resource` is not in the sandbox-mediation inventory, that
content takes the generic transcript path with no exposure label
([`prompt-loop.ts:1664-1673`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1664-L1673),
[`prompt-loop.ts:3628-3629`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3628-L3629)).

Digest and source records answer “which bytes were activated or read.” They do
not answer “which model context was exposed,” and they do not influence later
emissions.

### 3.3 Web fetch, browser, native search, and the pattern index

`web_fetch` stores both the decoded raw body and extracted text in its artifact,
with URL, redirect, digest, and time metadata
([`web-fetch.ts:24-41`](../../../../runtime/cf-harness/src/tools/web-fetch.ts#L24-L41),
[`web-fetch.ts:305-341`](../../../../runtime/cf-harness/src/tools/web-fetch.ts#L305-L341)).
Its model-facing transform removes only `rawContent`; extracted `text`, title,
links, URLs, digest, and fetch time remain
([`web-fetch.ts:377-385`](../../../../runtime/cf-harness/src/tools/web-fetch.ts#L377-L385)).
The prompt loop special-cases that transform before the sandbox-mediation path,
so it creates no model-context observation
([`prompt-loop.ts:3576-3579`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3576-L3579)).
The web-fetch profile limits the child to that one tool, which minimizes the
blast radius, but the extracted website text still enters the child unlabeled
([`subagent.ts:62-64`](../../../../runtime/cf-harness/src/contracts/subagent.ts#L62-L64),
[`subagent.ts:378-385`](../../../../runtime/cf-harness/src/contracts/subagent.ts#L378-L385)).

The browser boundary has the same exposure shape with a different containment
mechanism. The browser tool explicitly tells the model to treat page output as
untrusted, and restricts the host process to a typed, leased browser action
([`browser.ts:99-115`](../../../../runtime/cf-harness/src/tools/browser.ts#L99-L115)).
Page text, snapshots, errors, and diagnostics return as ordinary output strings
after endpoint redaction and truncation
([`browser.ts:721-759`](../../../../runtime/cf-harness/src/tools/browser.ts#L721-L759)).
`browser` is not sandbox-mediated, so no origin joins the child context
([`prompt-loop.ts:1664-1673`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1664-L1673)).

The native web-search profile gives the child no harness tools and enables the
provider's native search tool
([`subagent.ts:387-397`](../../../../runtime/cf-harness/src/contracts/subagent.ts#L387-L397)).
Provider search metadata is embedded in the assistant message, and assistant
messages are appended directly to the transcript; there is no harness
declassification hook between provider search and child context
([`openai-compatible-gateway.ts:121-145`](../../../../runtime/cf-harness/src/model/openai-compatible-gateway.ts#L121-L145),
[`prompt-loop.ts:2672-2723`](../../../../runtime/cf-harness/src/prompt-loop.ts#L2672-L2723)).

`search_patterns` is the local/remote registry-text case. It returns published
descriptions, hashtags, signals, import hints, and rendered argument/result
shapes, deliberately omitting source
([`search-patterns.ts:1-10`](../../../../runtime/cf-harness/src/tools/search-patterns.ts#L1-L10),
[`search-patterns.ts:218-252`](../../../../runtime/cf-harness/src/tools/search-patterns.ts#L218-L252)).
That decomposition is good first-move CFC: less external text enters context.
The remaining description and schema text still takes the generic unlabeled
tool-result path
([`prompt-loop.ts:3628-3629`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3628-L3629)).

### 3.4 Sandbox outputs and local files

For mediated `bash`, sandbox `run_skill_script`, `read_file`, and `edit_file`,
the prompt loop renders only the channels the trusted sandbox result classifies
as observable. It creates a model-context observation for each `policy:
"observed"` stdout, stderr, or exit-code channel
([`prompt-loop.ts:1962-1998`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1962-L1998),
[`prompt-loop.ts:2000-2065`](../../../../runtime/cf-harness/src/prompt-loop.ts#L2000-L2065),
[`prompt-loop.ts:2134-2195`](../../../../runtime/cf-harness/src/prompt-loop.ts#L2134-L2195)).
If mediation metadata is absent, `disabled` and `observe` expose raw output
(`observe` records a warning), while enforcing modes return a denial
([`prompt-loop.ts:3631-3684`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3631-L3684)).

This is the only current path that adds any CFC label when text becomes visible
to a harness model. It adds confidentiality only, not the observation's
integrity/provenance, and only if the trusted sidecar already supplied a
nonempty confidentiality label
([`cfc-model-context.ts:66-75`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L66-L75),
[`cfc-model-context.ts:107-129`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L107-L129)).

There is a further internal disagreement for skill scripts. A sandbox skill
script gets invocation labeling and output mediation, but a host skill script
runs without an invocation context
([`run-skill-script.ts:1160-1206`](../../../../runtime/cf-harness/src/tools/run-skill-script.ts#L1160-L1206)).
The output-mediation selector explicitly excludes the host branch, so its text
falls through as a generic result
([`prompt-loop.ts:1664-1673`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1664-L1673)).
The same tool therefore embodies two different CFC boundary models depending
on execution target.

### 3.5 `describe_handle`

`describe_handle` discloses only a structurally rebuilt schema, stripping
value-bearing and prose keywords, but its policy is explicitly “permissive and
fixed”: any run holding the token may obtain the shape
([`describe-handle.ts:40-75`](../../../../runtime/cf-harness/src/tools/describe-handle.ts#L40-L75)).
The prompt loop additionally scrubs bare Fabric identifiers from keys and
values, then returns the schema directly
([`prompt-loop.ts:3617-3626`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3617-L3626)).
This is deliberate minimization, but not user-policy-driven declassification
and not exposure accounting.

### 3.6 What policy-carrying cells do today

The cell side already supports policy-carrying labels. `Policy` and `Context`
atoms are hash-bound record references, and module policy references bind an
implementation identity, symbol, policy digest, and subject
([`cfc.ts:223-264`](../../../../base/api/cfc.ts#L223-L264)).
At runner sink requests, the transaction collects the labels of consumed reads,
adds sink boundary context, evaluates exchange rules against policy records,
trust evidence, grants, and carried policy manifests, and in enforcing mode
uses the rewritten confidentiality to decide whether the egress fits its
ceiling
([`prepare.ts:5022-5099`](../../../../runtime/runner/src/cfc/prepare.ts#L5022-L5099),
[`prepare.ts:5132-5218`](../../../../runtime/runner/src/cfc/prepare.ts#L5132-L5218)).
The evaluator changes confidentiality only, respects clause-local policy
selection, never persists its rewrite, and fails closed on exhaustion
([`exchange-eval.ts:40-77`](../../../../runtime/runner/src/cfc/exchange-eval.ts#L40-L77)).

`run_pattern` preserves input cells as live references rather than reading them
into the harness, so their labels and policy references remain available to the
pattern runtime
([`run-pattern.ts:933-988`](../../../../runtime/cf-harness/src/tools/run-pattern.ts#L933-L988)).
The harness session defaults leave flow labels and policy evaluation off, but an
operator can select `max-enforcement`, which enables persisted flow labels,
policy evaluation, policy records, and sink ceilings
([`config.ts:38-55`](../../../../runtime/cf-harness/src/config.ts#L38-L55),
[`runtime-presets.ts:609-620`](../../../../runtime/runner/src/runtime-presets.ts#L609-L620),
[`runtime-presets.ts:682-702`](../../../../runtime/runner/src/runtime-presets.ts#L682-L702)).
Runner policy refusal reaches the harness as a `CfcCommitRefusalError`, and the
harness withholds its label-bearing detail from model text
([`run-pattern.ts:1368-1414`](../../../../runtime/cf-harness/src/tools/run-pattern.ts#L1368-L1414)).

This is not yet a complete user-policy surface even inside the runner. A cell's
label can select a hash- or digest-bound policy record, but the records
themselves come from `RuntimeOptions`, and cf-harness exposes posture, flow, and
enforcement dials rather than a per-run policy-record input
([`cfc.ts:223-264`](../../../../base/api/cfc.ts#L223-L264),
[`runtime.ts:1476-1501`](../../../../runtime/runner/src/runtime.ts#L1476-L1501),
[`config.ts:38-55`](../../../../runtime/cf-harness/src/config.ts#L38-L55)).
The max-enforcement posture installs the runner's standard prompt-caveat record,
not a policy supplied through the input cell
([`runtime-presets.ts:609-620`](../../../../runtime/runner/src/runtime-presets.ts#L609-L620)).
Thus policy-carrying inputs have a real selection and enforcement mechanism, but
the operator's fuller “user's policy” part remains only partially surfaced.

None of that machinery is consulted by the harness boundaries in §§3.1-3.5.
The structured sanitizer, skill injection, skill-resource read, web fetch,
browser, native search, pattern-index results, child return, and handle-shape
disclosure each apply fixed code rules or no CFC rule. Thus “fixed rules
everywhere, no user-policy consultation” is accurate for harness
declassification, while it would be false for runner sink declassification.
The disagreement is between modules, not an absence of a policy engine.

## 4. Influence direction: `PromptSlotInfluence`

`PromptSlotInfluence` is a provenance-shaped CFC atom containing the trusted
prompt-slot role, kernel, surface, optional subject/event/digests/path, and a
small run-manifest summary
([`cfc.ts:500-521`](../../../../base/api/cfc.ts#L500-L521)).
The harness mints it from the run's `PromptSlotBinding` and places it on selected
invocation input paths as a confidentiality label
([`cfc-invocation-context.ts:194-257`](../../../../runtime/cf-harness/src/contracts/cfc-invocation-context.ts#L194-L257)).

For `bash` the selected paths are `command` and, when explicitly supplied,
`cwd`
([`bash.ts:149-161`](../../../../runtime/cf-harness/src/tools/bash.ts#L149-L161)).
Other sandbox tools select write/edit args and stdin, or skill-script argv,
args, environment, and optional cwd
([`write-file.ts:138-152`](../../../../runtime/cf-harness/src/tools/write-file.ts#L138-L152),
[`edit-file.ts:733-804`](../../../../runtime/cf-harness/src/tools/edit-file.ts#L733-L804),
[`run-skill-script.ts:1189-1206`](../../../../runtime/cf-harness/src/tools/run-skill-script.ts#L1189-L1206)).
This agrees with the 2026-08-31 #6483 ground truth recorded on
[CT-2116](https://linear.app/common-tools/issue/CT-2116/cfc-input-labels-are-dropped-silently-the-harness-writes-invocation):
the measured atoms were confidentiality-axis `PromptSlotInfluence` on command
and cwd.

What it covers is the influence of the run's bound prompt slot on selected
sandbox invocation fields. It is confidentiality influence, not integrity or
side-effect authority
([`agent-harness/02-cfc-integration.md:55-57`](../../../specs/agent-harness/02-cfc-integration.md#L55-L57)).
It does **not** record which external text the model observed; it does not label
a skill block, web page, tool transcript message, child summary, host tool, or
cell result merely because those bytes entered context. It also does not stamp
the model's other emissions. Those omissions follow from the mint accepting
only a `PromptSlotBinding`, run-manifest summary, and chosen invocation paths
([`cfc-invocation-context.ts:194-257`](../../../../runtime/cf-harness/src/contracts/cfc-invocation-context.ts#L194-L257)).

## 5. The inert model-context seam

`HarnessCfcModelContext` is the code path behind the #6483 statement “Model-
context labels: the code path exists and emitted nothing.” It stores a
cumulative label plus an ordered list of tool/channel observations
([`cfc-model-context.ts:15-48`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L15-L48)).
Each visible sandbox observation is reduced to confidentiality only; the
accumulator unions those clauses and persists the resulting run state
([`cfc-model-context.ts:107-168`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L107-L168),
[`engine.ts:955-964`](../../../../runtime/cf-harness/src/engine.ts#L955-L964)).
The prompt loop batches observations after adding their tool messages to the
transcript, then records them before the next model turn
([`prompt-loop.ts:2765-2818`](../../../../runtime/cf-harness/src/prompt-loop.ts#L2765-L2818)).

The downstream stamping path is also implemented. Given selected invocation
paths, it clones the accumulated confidentiality label onto each path
([`cfc-model-context.ts:170-191`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L170-L191)).
The invocation builder merges explicit labels, `PromptSlotInfluence`, and these
model-context labels
([`cfc-invocation-context.ts:260-291`](../../../../runtime/cf-harness/src/contracts/cfc-invocation-context.ts#L260-L291)).

There is a naming trap in the opt-in surface. `read_file` is the only tool that
explicitly sets `cfcModelContextInputLabelPaths`, selecting `args`
([`read-file.ts:128-143`](../../../../runtime/cf-harness/src/tools/read-file.ts#L128-L143)).
But the builder falls back to the shared `cfcInputLabelPaths` when that specific
option is absent, for both model-context and prompt-slot influence
([`cfc-invocation-context.ts:276-290`](../../../../runtime/cf-harness/src/contracts/cfc-invocation-context.ts#L276-L290)).
Therefore the effective stamping surface is wider: bash command/cwd,
write/edit args and stdin, edit verification args, and sandbox skill-script
argv/args/env/cwd all inherit accumulated model-context confidentiality through
their shared path declarations
([`bash.ts:158-160`](../../../../runtime/cf-harness/src/tools/bash.ts#L158-L160),
[`write-file.ts:149-151`](../../../../runtime/cf-harness/src/tools/write-file.ts#L149-L151),
[`edit-file.ts:743-831`](../../../../runtime/cf-harness/src/tools/edit-file.ts#L743-L831),
[`run-skill-script.ts:1200-1205`](../../../../runtime/cf-harness/src/tools/run-skill-script.ts#L1200-L1205)).

The #6483 corpus was silent because no model-visible sandbox observation
arrived with nonempty confidentiality, so the accumulator had nothing to append
and nothing to stamp. Current code makes that a distinct state from the path
being absent: empty or integrity-only observations return `undefined`
([`cfc-model-context.ts:107-129`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L107-L129)).

This seam is the natural structural home for a context exposure set: it already
records context-entry events, accumulates them per run, persists them, and feeds
later invocation labels. It is not that set today. It accepts only mediated
sandbox channels, discards integrity/provenance, never observes skill/web/
browser/registry/cell/child inputs, and is not passed into a newly constructed
child engine
([`cfc-model-context.ts:10-26`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L10-L26),
[`cfc-model-context.ts:66-75`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L66-L75),
[`prompt-loop.ts:3781-3867`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3781-L3867)).
It also reaches only the sandbox invocations named above, not every tool call,
cell write, transcript emission, or child return.

## 6. The child-return boundary

The default return policy includes a summary, sanitized run-state summary, and
manifest, while excluding the child transcript and raw failures
([`subagent.ts:307-355`](../../../../runtime/cf-harness/src/contracts/subagent.ts#L307-L355)).
Without a return schema, the child's final assistant text becomes the free-form
parent summary after child-handle resolution
([`prompt-loop.ts:4045-4067`](../../../../runtime/cf-harness/src/prompt-loop.ts#L4045-L4067)).

With a return schema, the child final text is parsed as JSON and passed through
the same fixed structured-result sanitizer; the raw value remains in the child
artifact and the parent gets the sanitized value plus a fixed status summary
([`prompt-loop.ts:1387-1498`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1387-L1498),
[`subagent-return.ts:25-42`](../../../../runtime/cf-harness/src/subagent-return.ts#L25-L42)).
A delegation carrying a handle-delivered skill additionally scrubs the exact
injected payload, its JSON-escaped spelling, and every parsed structured string
before return
([`prompt-loop.ts:1012-1069`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1012-L1069),
[`prompt-loop.ts:4051-4102`](../../../../runtime/cf-harness/src/prompt-loop.ts#L4051-L4102)).

The assembled `HarnessSubagentResult` carries summary, model information,
sanitized run state, manifest, and optional structured return. None of those
types has an exposure or origin field
([`prompt-loop.ts:4121-4157`](../../../../runtime/cf-harness/src/prompt-loop.ts#L4121-L4157),
[`subagent.ts:500-552`](../../../../runtime/cf-harness/src/contracts/subagent.ts#L500-L552)).
No exposure/origin information crosses from child to parent today. A child that
read `web_fetch`, browser output, a native search result, a registry skill, a
skill resource, or mediated confidential stdout returns a summary or structured
value that is indistinguishable at the parent boundary from one produced
without those observations. Exact skill-text scrubbing prevents one verbatim
leak; it does not propagate the skill's influence.

This directly contradicts the live harness profile's stated delegation rule
that a child return is a new observation which must pass configured validation
and mediation before entering the parent context
([`agent-harness/02-cfc-integration.md:72-81`](../../../specs/agent-harness/02-cfc-integration.md#L72-L81)).
Validation exists. Exposure mediation does not.

## 7. Origin vocabulary

### 7.1 What is on current `origin/main`

The current `ExternalIngest` atom is one vouched-channel shape: `channel`,
`audience`, `receivedAt`, and `valueDigest`
([`cfc.ts:201-216`](../../../../base/api/cfc.ts#L201-L216)).
Its constructor has the same four arguments
([`cfc.ts:591-603`](../../../../base/api/cfc.ts#L591-L603)).
The runner's split mint derives it only from verified ingest stamp metadata and
persists it under `origin: "external-ingest"`
([`prepare.ts:6954-6976`](../../../../runtime/runner/src/cfc/prepare.ts#L6954-L6976)).

Other relevant current provenance families are `UserSurfaceInput`,
`LlmDerived`, `PromptSlotInfluence`, `TransformedBy`, `LinkReference`, and the
generic `Origin` type URI. The propagation registry classifies them as
value-bound or provenance rather than hereditary evidence
([`cfc.ts:66-116`](../../../../base/api/cfc.ts#L66-L116),
[`atom-classes.ts:28-46`](../../../../runtime/runner/src/cfc/atom-classes.ts#L28-L46)).
`Origin` is only a type constant in `packages/api/cfc.ts`: there is no exported
typed atom shape or constructor beside it. Runner introspection nevertheless
expects an informal `uri` field
([`cfc.ts:29-117`](../../../../base/api/cfc.ts#L29-L117),
[`label-introspection.ts:387-397`](../../../../runtime/runner/src/cfc/label-introspection.ts#L387-L397)).

### 7.2 #6668 is not current-main ground truth

As of this snapshot, [PR #6668](https://github.com/commontoolsinc/labs/pull/6668)
is open and its cited commit `6515a1be10` is not contained in `origin/main`.
That pending commit turns `ExternalIngest` into a discriminated family with the
existing vouched-channel variant and a weaker `kind: "fetch"` variant carrying
a pinned URL, commit SHA, retrieval time, and value digest
([`cfc.ts@6515a1be10:201-240`](https://github.com/commontoolsinc/labs/blob/6515a1be10/packages/api/cfc.ts#L201-L240),
[`cfc.ts@6515a1be10:615-641`](https://github.com/commontoolsinc/labs/blob/6515a1be10/packages/api/cfc.ts#L615-L641)).
It is useful vocabulary evidence, but not evidence of today's implementation.

### 7.3 Sufficiency against the target origins

- **Vouched channel:** represented and minted on current main
  ([`cfc.ts:201-216`](../../../../base/api/cfc.ts#L201-L216),
  [`prepare.ts:6954-6976`](../../../../runtime/runner/src/cfc/prepare.ts#L6954-L6976)).
- **Pinned fetch:** represented only on the pending #6668 line above, not
  current main.
- **Unpinned web:** no dedicated current atom and no context-exposure mint at
  `web_fetch`, browser, or native search
  ([`prompt-loop.ts:3576-3579`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3576-L3579),
  [`prompt-loop.ts:1664-1673`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1664-L1673)).
- **Local registry:** skill activations and pattern search results retain
  source/digest audit metadata, but no CFC origin atom is attached to the
  consuming model context
  ([`registry.ts:824-913`](../../../../runtime/cf-harness/src/skills/registry.ts#L824-L913),
  [`search-patterns.ts:237-252`](../../../../runtime/cf-harness/src/tools/search-patterns.ts#L237-L252)).
- **Generic URI origin:** a convention exists, but its API shape and minting
  authority are unspecified in the typed API
  ([`cfc.ts:29-117`](../../../../base/api/cfc.ts#L29-L117),
  [`label-introspection.ts:387-397`](../../../../runtime/runner/src/cfc/label-introspection.ts#L387-L397)).

The vocabulary is therefore sufficient for current vouched ingest and has a
pending pinned-fetch extension. It is not sufficient as a typed vocabulary for
the target's transient web and local-registry context exposures. More
importantly, adding atom variants alone would not fix the system: no context
boundary currently mints or accumulates them.

## 8. Common structure and module disagreements

The tools share one underlying problem even though they currently solve it in
different local ways:

1. External or labeled bytes have an acquisition record: cell label, URL and
   digest, skill activation, registry record, browser lease, sandbox sidecar, or
   child artifact.
2. A boundary selects a model-visible projection: literal-or-handle sanitizer,
   raw-content removal, truncation, structural schema scrub, endpoint scrub,
   exact skill-text scrub, or mediated observed channel.
3. The projected text enters one model context.
4. That context later emits tool inputs, cell writes, or a child return.

Only the sandbox-output path connects steps 3 and 4 with an accumulated label,
and even there it carries confidentiality rather than origin exposure
([`cfc-model-context.ts:107-191`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L107-L191)).
Every other path stops at acquisition audit or projection. This is the common
shape the refinement pass can converge on; this report does not propose its API.

The first-class disagreements are:

- Runner sinks ask labels, boundary context, policy records, trust, and grants
  whether confidentiality may be rewritten; harness model-text boundaries use
  hardcoded shape/scrub/expose rules and never ask that policy engine
  ([`prepare.ts:5022-5099`](../../../../runtime/runner/src/cfc/prepare.ts#L5022-L5099),
  [`structured-result.ts:404-519`](../../../../runtime/runner/src/cfc/structured-result.ts#L404-L519)).
- Sandbox output can create cumulative context influence, while web, browser,
  skill, registry, host-script, and child-return text silently drops the same
  concept
  ([`prompt-loop.ts:1962-2195`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1962-L2195),
  [`prompt-loop.ts:3576-3629`](../../../../runtime/cf-harness/src/prompt-loop.ts#L3576-L3629)).
- `PromptSlotInfluence` describes bound-prompt influence flowing toward selected
  sandbox arguments; it is not external-text influence or authority, despite
  both kinds of influence being confidentiality labels in invocation contexts
  ([`cfc-invocation-context.ts:236-291`](../../../../runtime/cf-harness/src/contracts/cfc-invocation-context.ts#L236-L291)).
- `run_pattern` preserves a sealed value as a fabric address; a child structured
  return uses an output-scoped opaque handle unless an address-shaped raw string
  can be reminted into the parent's handle table
  ([`run-pattern.ts:1330-1349`](../../../../runtime/cf-harness/src/tools/run-pattern.ts#L1330-L1349),
  [`prompt-loop.ts:1464-1498`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1464-L1498)).
- The same `run_skill_script` tool is CFC-mediated in the sandbox and generic
  unlabeled output on the host
  ([`run-skill-script.ts:1160-1206`](../../../../runtime/cf-harness/src/tools/run-skill-script.ts#L1160-L1206),
  [`prompt-loop.ts:1664-1673`](../../../../runtime/cf-harness/src/prompt-loop.ts#L1664-L1673)).

These disagreements are consistent with an integration-first pass that got
tools connected. They are the map for iterative convergence, not evidence that
one new all-purpose API should be designed in this audit.

## 9. Judgment against the three rules

### Rule 1: declassification adds exposure

**Partly holds only for mediated confidential sandbox outputs.** Observable
sandbox channels append confidentiality to `HarnessCfcModelContext`
([`cfc-model-context.ts:107-168`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L107-L168)).
It fails for origin exposure even there, because integrity/provenance is
discarded. It fails entirely for structured cell values, skill injection,
skill resources, web fetch, browser, native search, pattern-index text, host
skill scripts, handle-shape disclosure, and child returns, whose boundaries do
not append an origin exposure (§3).

### Rule 2: emissions inherit exposure

**Partly holds for sandbox invocation inputs after a mediated confidentiality
observation.** The accumulator stamps its confidentiality onto the selected
paths of bash, file, edit, and sandbox skill-script invocations
([`cfc-model-context.ts:170-191`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L170-L191),
[`cfc-invocation-context.ts:276-291`](../../../../runtime/cf-harness/src/contracts/cfc-invocation-context.ts#L276-L291)).
It fails as a general emission rule: host and non-sandbox tools, ordinary
assistant text, cell writes made outside those invocation labels, new child
contexts, and every child return carry no accumulated exposure (§5-§6).

### Rule 3: cells carry labels without exposure until declassified

**Holds on the runner dataflow side.** Links, derived values, structure, and
overwrites propagate or update label metadata without creating a model-context
event (§2). **Fails at the read-into-model-text half.** `run_pattern` reads a
labeled result and applies a shape sanitizer without joining the cell's origins
to the model context (§3.1). Handle-delivered skill text is an even clearer
case: a cell is materialized directly into child context with activation
provenance but no CFC exposure (§3.2).

### Judgment against the three-move CFC philosophy

The first move is the strongest part of today's system: live cell references,
sealed addresses, child capability profiles, raw-body withholding, source
omission, schema-shape reduction, and transcript exclusion all reduce what a
model sees
([`run-pattern.ts:933-988`](../../../../runtime/cf-harness/src/tools/run-pattern.ts#L933-L988),
[`subagent.ts:307-355`](../../../../runtime/cf-harness/src/contracts/subagent.ts#L307-L355)).
The second move is complete for runner cell flow but fragmentary for model
contexts. The third move exists one layer down at runner sinks and is bypassed
by every harness declassification boundary. That pairing is both the system's
largest disagreement and the favorable fact for refinement: the needed policy
concepts are not being invented from zero.

## 10. Smallest path toward the target, ordered by leverage

No API is proposed here. The smallest sequence of seams and verification gaps
is:

1. **Wake and generalize the existing model-context path as the exposure
   accumulator.** Add context-entry events at the existing projection seams for
   skill/context injection, skill resources, web fetch, browser/native search,
   registry results, structured cell unsealing, host-script output, and child
   observations. Preserve origin/provenance rather than reducing every input to
   confidentiality. This has highest leverage because persistence, joining, and
   later invocation stamping already exist
   ([`cfc-model-context.ts:107-191`](../../../../runtime/cf-harness/src/contracts/cfc-model-context.ts#L107-L191)).
   Verify it with one origin-specific fixture per entry seam, plus a multi-origin
   context whose next sandbox invocation contains their union. Re-run the #6483
   corpus shape and require model-context emissions where external text was
   actually exposed.
2. **Stamp the child-return observation with the child's accumulated exposure.**
   Apply this at the existing assembly point shared by free-form and structured
   returns, without treating exact skill-text scrubbing as influence removal
   ([`prompt-loop.ts:4057-4157`](../../../../runtime/cf-harness/src/prompt-loop.ts#L4057-L4157)).
   Verify with a web-fetch child and a skill-handle child: the parent must receive
   the child's origin set on both summary and structured-return paths, and the
   parent's next emission must inherit it.
3. **Bring user-policy evaluation to the harness's existing declassification
   seams by reusing the runner's concepts before growing new ones.** The runner
   already has label-carried `Policy`/`Context`, boundary context, policy records,
   grants, fail-closed exchange, and a diagnostic/enforcing dial
   ([`exchange-eval.ts:40-77`](../../../../runtime/runner/src/cfc/exchange-eval.ts#L40-L77),
   [`prepare.ts:5022-5099`](../../../../runtime/runner/src/cfc/prepare.ts#L5022-L5099)).
   The gap is that sanitizer/skill/web/child-return boundaries do not call it.
   Verify each boundary with the same deny/allow policy pair and demonstrate
   that changing only user/deployment policy changes release while fixed shape
   and source stay constant.
4. **Grow the origin family only with arriving consumers.** Land the pending
   pinned-fetch variant with its durable ingest consumer; add an unpinned-web or
   local-registry origin when the exposure accumulator has a boundary that will
   mint it; decide whether the generic `Origin { uri }` convention should become
   typed when a real consumer needs it (§7). Verify each variant cannot
   impersonate a stronger one and that its source fields survive accumulation,
   child return, and downstream emission.

This ordering deliberately does not attempt a final unified API. It makes the
shared shape observable first, closes the child trust reset second, connects
the already-existing policy engine third, and extends vocabulary only where a
consumer proves the need.

## 11. Sources read and not read

### Read before code

- [`vouched-ingest-channel-mint.md`](../../../features/vouched-ingest-channel-mint.md),
  in full.
- The CFC/ingest sections of
  [`self-serve-ingest-channels.md`](../../../features/self-serve-ingest-channels.md),
  the CFC egress and threat-model sections of
  [`host-embedding.md`](../../../features/host-embedding.md), and
  [`gateway-request-provenance.md`](../../../features/gateway-request-provenance.md)
  in full.
- The CFC entries in [`docs/features/README.md`](../../../features/README.md).
- As historical background only, the relevant CFC sections of
  [`cfc-spec-audit.md`](../../cfc-spec-audit.md) and
  [`cfc-s16-default-transition-design.md`](../../specs/cfc-s16-default-transition-design.md).

### Linear searched before reference

- [CT-2068](https://linear.app/common-tools/issue/CT-2068/one-calling-convention-every-agent-boundary-is-fabric-backed-and):
  fabric-backed boundaries and the shape/integrity/holder declassification
  dials.
- [CT-2116](https://linear.app/common-tools/issue/CT-2116/cfc-input-labels-are-dropped-silently-the-harness-writes-invocation):
  closed input-label transport issue and the #6483 model-context ground truth.
- [CT-2154](https://linear.app/common-tools/issue/CT-2154/web-origin-content-flow-taint-audit-and-the-fetch-provenance-family):
  transient web-origin audit request and the durability trigger for a weaker
  fetch variant.
- [CT-2076](https://linear.app/common-tools/issue/CT-2076/e3-legibility-read-back-reconstruct-the-taint-story-from-persisted):
  E3 offline cell-side reconstruction and its artifact/store gaps.

### Not read

The non-CFC feature documents and non-CFC portions of the feature tree were not
read. The full runner, harness, API, HTML, LLM, and piece packages were not read;
the investigation followed the named CFC, model-context, tool-rendering,
skill, web, invocation, policy, and child-return seams cited above. Historical
documents outside the two named CFC records were not treated as current-system
evidence. The open #6668 branch was inspected only to resolve the explicit
current-main contradiction; its pending code was not used as evidence of
today's behavior.
