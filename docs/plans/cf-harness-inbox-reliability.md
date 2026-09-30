# cf-harness task research and composition

Status: the callable service, bounded citation repair, automatic root startup,
syntax-only example admission, and existing CFC propagation are implemented. The
[six-trial comparison](../history/packages/cf-harness/research-guard-comparison-2026-09-15.md)
records successful indexed composition, browser persistence, and lower
whole-task cost on the synthetic dinner-page task. The next experiments target
opening cost, focused follow-ups, and component contracts. The inbox capstone
requires working email grants and tested indexed email components; synthetic
composition does not establish inbox correctness. Recipe compilation and
behavior still require author/compiler and browser verification.

Goal: every new cf-harness task starts with research that equips its parent and
pattern author to use the available grants, compose indexed patterns, and follow
the actual APIs. The first capstone is the request “give me a simple list view
of my email inbox.” Its result must work, and its use of indexed components must
be measurable.

Track under [CT-2173](https://linear.app/common-tools/issue/CT-2173), supporting
[CT-2319](https://linear.app/common-tools/issue/CT-2319). The
[September 14 analysis](../history/packages/cf-harness/weaver-inbox-run-2026-09-14.md)
holds the baseline. Deliver one small PR and one measured checkpoint at a time.

## One research service

Expose task research as `research`, with a description identifying its CF
documentation, skills, and pattern-index scope. Its question may describe the
whole task or ask for a specific implementation detail. Replace the narrow
`query_docs` surface and retain any compatibility required by persisted runs.
Keep one implementation for automatic research and explicit parent or author
calls.

The host starts research after resolving grants and attached pattern references,
before the parent's first planning or execution turn. Supply the task, granted
handle tokens and their available descriptions, known input schemas, and
attached pattern references. Research can inspect handle metadata through the
existing description surface; it cannot manufacture a connection or infer one
from a connector's name.

Treat “every run” as every new root user task. An author inherits that task's
research and can ask follow-up questions through the same tool. Tool
continuations, compiler corrections, and resumed execution retain the kit
instead of starting duplicate opening passes. A new task or changed grant
inventory requires current research. Give research a bounded turn and output
budget and account for all its model and tool use in the root run.

The research service uses a cheap model with a read-only tool loop. Reuse the
harness's model, tool, cancellation, and diagnostic machinery. Keep the
`pattern-author` restriction on general nested delegation: research is a
host-provided service callable from either context and cannot itself delegate.
An unavailable research dependency yields an explicit incomplete kit; its
absence must not become an unsupported API claim.

## What research can read

| Surface                  | Required behavior                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation and skills | Search the configured corpus, open exact sections, and follow related sections or documents. A poor first search must not make the defining API section unreachable.                      |
| Pattern index            | Search descriptions, argument and result contracts, dependencies, and recorded quality. Distinguish a close textual match from a component that meets the task.                           |
| Indexed source           | Fetch a selected pattern's published program, list its files, read relevant source, and inspect indexed dependencies when needed. Return explicit bounds and addresses for further reads. |
| Available handles        | Describe granted references and their contracts through the existing surface. Keep data in live references for the consuming pattern.                                                     |

The index client already exposes
`getPattern({ patternId, includeSource: true })` and a program containing its
entry point and files. The missing capability is model-facing source inspection.
Build that reader on the existing authenticated client. Verify the published
entry identity, preserve file names and export information, and make omitted or
unavailable source explicit. Source access does not mean that an entry's
behavior has been tested.

Give research corpus reads that work against the host's configured roots. A
citation must be reopenable through those tools, without depending on a checkout
being mounted into the agent sandbox. Symbol-aware search helps discovery, while
direct reads and navigation let research investigate beyond the first selection.

## The implementation kit

Return a structured, bounded kit with enough space for a complete minimal
composition example. The existing 2,000-character answer limit is unsuitable for
this contract. The kit contains:

- **Recommended approach:** run an existing app by ID, compose existing parts,
  or author a named missing capability. Explain the fit and any uncertainty.
- **Available inputs:** real handle tokens, expected argument names and types,
  and relevant registry or connector capabilities. List required missing inputs
  explicitly.
- **Selected patterns:** verified IDs, import specifiers, exports, argument and
  result shapes, dependencies, and the evidence for their suitability. Identify
  whether each is intended for direct use, composition, or reference only.
- **A usable recipe:** an exact `run_pattern` invocation for direct use, or a
  complete minimal source example and its input binding for composition. Use the
  selected patterns' actual contracts and IDs; placeholders are not a completed
  recipe.
- **Applicable rules:** the relevant API contracts and composition details,
  including reactive values, argument defaults, query scope, error handling, and
  how an imported pattern's output and UI enter the consuming pattern.
- **Verification and gaps:** what behavior must be checked, what is already
  demonstrated, and what remains unavailable or needs a new indexed component.
- **Sources:** the documentation sections and indexed source passages supporting
  the recipe, backed by the host's record of what research actually read.

For the inbox task, a completed kit must either identify an adequate whole inbox
pattern or explain exactly how to wire an email reader into a reusable list or
message renderer. Its code must show the real `cf:pattern:` imports, the
returned fields being consumed, the UI composition, and the granted database
input passed to `run_pattern`. A monthly-header reader must be described with
its actual coverage; a missing inbox reader or renderer is a concrete
contribution to make.

Keep host-confirmed identities and contracts distinct from the research model's
recommendations and example code. Validate kit structure and source references
before returning it. Compilation and behavioral checks establish whether the
recipe works; a citation alone does not establish either.

## Handoff and provenance

Attach the opening kit to the parent and pass it intact into pattern-author
delegations. Resolve any included handle tokens through the existing transfer
machinery. Research-discovered pattern records must enter the caller's trusted
reference inventory, so `delegate_task.patternRefs` can select them without a
duplicate parent search. Admit records from actual index responses rather than
from IDs asserted in the kit's prose. Preserve this inventory across resume.

Indexed source and documentation are reading material for this research service,
and derived examples are intentional output to its caller. Update the existing
prompts and contracts that say indexed source never reaches a model. This does
not change the pattern author's result-reference return contract or the data
release rules for live connector values.

Record every document section and source passage sent to research, including
source identity or digest, location, integrity, and research-run identity.
Retain the kit and its relationship to the parent and author. Associate
consulted sources with each resulting authored pattern through publication
provenance, including when the pattern's content identity already exists. Keep
these records separate from `dependencies`: consulting a pattern and importing
it are different facts. Extend publication metadata where needed without
changing source identity. Provenance records the reads and derivation; it is not
an additional release gate.

## Checkpoints

### 1. Research can establish a real component's contract

Question: can research inspect enough of an indexed program and the
documentation to establish how that component actually works?

Add the source reader and corpus search/read tools, then exercise them against a
real indexed mail reader. Compare the returned program with its entry identity
and declared schemas. Include a multi-file program and an indexed dependency in
the checks. Missing source and truncated reads must be distinguishable from a
complete read. Reopen the `WishState<T>` result-shape section from the recorded
natural-language question using the host corpus tools.

The live read probe should expose the monthly reader's limited coverage and the
required database argument. Failure here identifies a source or documentation
access problem before answer generation is introduced.

### 2. One research call produces a usable kit

Question: can the research service equip an author to compose successfully?

Replace the one-turn explore answer with the bounded research loop and kit
contract. Make it callable by the parent and author, with source provenance and
trusted pattern-reference handoff. Ask the full inbox question with a known
grant inventory and a fixed index. Hand the kit to an author without additional
human API advice. Check the example through the real pattern compiler and
inspect the resulting behavior. Record unsupported instructions, additional
research, compilation attempts, and unresolved component gaps.

Also exercise a missing email grant. A valid outcome is a precise missing-input
report with a conditional implementation approach. It must not invent a lookup
or claim to have produced a working inbox. This checkpoint measures the kit's
usefulness independently of automatic startup.

### 3. Every task starts prepared

Question: does the automatic opening pass improve the bare task end to end?

Wire the same research service into root task startup and inherit its kit in
delegations. Verify startup order, follow-up access, handle transfer, and resume
without duplicate research. Use a fixture where only research discovers the
selected pattern; the author must receive its verified reference successfully.

Compare automatic research with the baseline under the same grants, model
settings, and index contents. Include a task that can run an indexed app
directly and one requiring composition. Then run the bare inbox request in an
isolated console. Account for the opening research cost even when it prevents
all later documentation calls or authoring.

### 4. The index supplies the missing email building blocks

Question: can tested reusable components make the researched recipe reliable?

Use the kit's concrete gaps to select contributions. The initial candidates are
an inbox reader, a reusable email renderer, and a whole inbox app composed from
them. Reuse satisfactory entries already present. Keep their input and output
contracts explicit so other compositions can use the reader or renderer alone.

Verify inbox membership, newest-first ordering across month boundaries, bounded
query size, sender, subject, snippet, and date. Exercise pending, empty, missing
connection, and query-error states. Include an older inbox message and a newer
archived message, and reopen the result in a new session. Preserve CFC labels
without requiring private rows to enter model context.

Publish accurate descriptions and capability tags, assign ratings from observed
behavior, and hide unsuitable duplicates without breaking existing imports.
Repeat the bare task with the improved index. Keep this measurement separate
from the fixed-index comparison so library improvements and research
improvements can be evaluated individually. Apply the same process to
Gmail/Plaid bill reconciliation after the inbox checkpoint.

## Next experiments: opening cost and component contracts

Use the
[completed comparison](../history/packages/cf-harness/research-guard-comparison-2026-09-15.md)
as a whole-workflow baseline. Preserve its frozen sources and artifacts. An
experiment against a rebased or otherwise changed harness needs a new matched
control; it must not attribute unrelated source changes to its treatment.

Evaluate a small opening orientation with targeted follow-ups for unresolved
contracts. A short orientation can make canonical `pattern-dev` references
explicit, route capability searches to the index and API questions to docs, and
supply a complete composition example. Resolve any preloaded sections through
the configured corpus, read budget, and citation provenance. Keep the skill's
authoring, deployment, and test workflow with the author. Measure access to a
skill separately from reading it. A callable-only condition can isolate
automatic startup; a separate guard ablation can isolate syntax admission.

Keep models, task, runtime, source corpus, frozen index responses and rankings,
publication policy, and budgets constant within each comparison. Use fresh
sessions and spaces and serialize trials. Verify connectivity before model
calls. Record provider caching, exact source identity, private helper work,
descendants, compiler corrections, and browser outcome. Separate fixed task
acceptance from the choice of components or visual design. Preserve failed
trials and their costs; an infrastructure repair is not a model improvement.

For the dinner-page regression, add and complete a preparation item, add costs
of $4.50 and $2.75, verify a $7.25 increase, and verify persistence after
reload. Check currency units and native checkbox state separately from host
accessibility attributes. Read full submitted-source artifacts to establish
actual component invocation. A successful compiler result is not a browser
acceptance result.

Improve indexed contracts in a separate library experiment: explicit amount
units, writable input requirements, returned fields, and tested minimal
compositions. Keep publication changes out of research-context comparisons.
Upstream index labels remain a classification dependency; successful source
authorization does not supply a public label.

Expand next to a direct-reuse task and the inbox task once its grants are known
to work. Keep new index contributions out of the initial comparison, then
measure their effect in the separate component-library checkpoint.

## Correctness dependencies and measurement

Track independent connector-grant resolution and useful missing-input
diagnostics under [CT-2320](https://linear.app/common-tools/issue/CT-2320). A
missing piece registry must not discard valid connector grants. Grant freshness
remains [CT-2318](https://linear.app/common-tools/issue/CT-2318). Research uses
the granted inventory as fact; it cannot repair either defect by recommending a
lookup. The live inbox success check requires a working email grant.

Record attempts, total tokens, cached tokens, wall time, and verified outcome
for every checkpoint. Include research turns and tool time. Separate patterns
merely found or read from patterns run by ID or imported in executed source.
Record which capabilities were reused, unique dependency IDs, and new source
written; an import count alone cannot establish useful reuse. Read complete
source sidecars when measuring collapsed tool calls.

Check rendered behavior separately from tool `ok` status. A heading with no
successful mailbox query is not an empty inbox. Keep the inbox and bills tasks
as separate benchmarks and retain task text, serving commit, model
configuration, grant inventory, and index state for comparison.

Live turns are serialized. Use an owned console directory and spare port through
the launcher; preserve the pair's console on 8135 and the connector stores.
Follow the space-clone rehearsal procedure before changing existing real-data
pieces.

Before each PR, run relevant tests and the package suite, mutate every new
assertion and record what makes it fail, and run repository-wide
`deno fmt --check`, `deno lint`, and applicable type and documentation checks
with Deno 2.9.4. Run cf-harness suites unsandboxed. Update the live harness
documentation and system map with behavior changes and review through
`cf-review`. Readiness requires current-main ancestry, green CI on that head,
and zero unanswered Cubic findings. Ben merges.
