# Revising a piece's source from an agent session

A person points at a piece they already have and says what should be
different. The pattern-author child reads the piece's current source, writes
a revised one, and the piece updates in place: data intact, a revision the
person can see and roll back.

Two tools on the `pattern-author` subagent surface do it, and the runtime
does everything else. This document says what they are, what they lean on,
and what is deliberately not built.

## What already exists

Almost all of it. Recording that first is what keeps the harness surface to
two tools.

A piece carries an append-only log of source revisions. A revision names the
exact content-addressed pattern, the origin at that point, and one of eight
operations — `baseline`, `create`, `edit`, `origin-update`, `detach`,
`revert`, `follow`, `repoint`
([`runner.ts:1190`](../../packages/runner/src/runner.ts#L1190),
[`runner.ts:1200`](../../packages/runner/src/runner.ts#L1200)).
[`readPieceSourceState`](../../packages/piece/src/ops/piece-origin.ts#L577)
returns every source fact one piece carries, including its authored files.

Replacing a piece's source is two calls on the piece controller.
[`checkPattern`](../../packages/piece/src/ops/piece-controller.ts#L4647)
compiles a candidate without persisting it and answers every compatibility
reason at once — pattern schema, retained argument, retained links, and the
CFC schema envelope stored on the argument document.
[`setPattern`](../../packages/piece/src/ops/piece-controller.ts#L4713)
applies one, detaching the piece from any origin it follows and returning
the accepted setup transaction's receipt: the content-addressed pointer, the
source revision id, and the origin it detached. The harness already holds
the controller that makes those calls — a fabric session is a connected
`PiecesController`
([`fabric-session.ts:21`](../../packages/cf-harness/src/fabric-session.ts#L21)).

Undo already has a face, and it is not the agent's. The piece menu that
`cf-render` gives every host, the Weaver included, lists every recorded
revision, and an earlier one offers **Use this version**
([`piece-source-lifecycle.md`, "Trust model"](../specs/piece-source-lifecycle.md#trust-model)).
A session that could revert could quietly discard a person's change, and
what it would buy is a button that already exists.

The pill already sends the piece. Loom's selected-instance path mints each
selected pattern instance as an ordinary input cell —
`{'name': 'pattern_N', 'ref': '/of:' + piece_id}`
([`src/lib/cf_harness_pattern_inputs.py:148`](https://github.com/commonfabric/loom/blob/cb1653bfc/src/lib/cf_harness_pattern_inputs.py#L148),
loom #5722) — so a handle over the piece's root cell reaches the session
today, and `describe_handle` answers shape, labels and fill over it.

And the parent already cannot see what the child reads. The
`pattern-author` profile's return contract is a discriminated union with,
in its own words, "no field for source, in any encoding, because a parent
has no use for source it should not be compiling"
([`subagent.ts:251-306`](../../packages/cf-harness/src/contracts/subagent.ts#L251-L306)),
and the profile holds authority over that contract
([`subagent.ts:509`](../../packages/cf-harness/src/contracts/subagent.ts#L509)),
so a delegation cannot widen it with a `returnSchema` of its own
([`subagent.ts:560-566`](../../packages/cf-harness/src/contracts/subagent.ts#L560-L566)).
One test pins that this holds for a return carrying source.

What that establishes is a property of the return contract, not of every
route out of a child. The run artifact root holds each raw tool output and a
parent's `bash` can read it — CT-2117, a recorded defect that predates this
and defeats every withheld-content boundary in the harness the same way. What
this change adds to it is a new kind of content on that route, program text a
third party authored, rather than a new route.

## What is built

Two tools, both on `PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS` and on no
other surface.

A parent reaches them by delegating, and has to be told so. Keeping a
capability off a surface leaves that surface unable to tell "you may not do
this here" from "this cannot be done", and a model reads the second: the
first live run refused the request outright, having tried every tool it
held, because nothing in `delegate_task` said a pattern-author child could
change a piece rather than build one. That sentence is now in the `profile`
description a parent reads when it chooses one.

### `read_piece_source`

Takes a handle token naming a piece root and returns that piece's current
authored source files. The read goes through `readPieceSourceState`, so it
is addressed by handle rather than by path and is not a file read.

The output carries the piece's live CFC labels, the same view
`describe_handle` reports over the same referent, so the child's context
ceiling rises to include them and every later boundary measures the child
against them. It also carries the current `sourceRevisionId`, so a read and
a later write can name the same revision.

Where the source came from is reported as one plain fact beside it —
`deployment-served`, `followed-in-fabric`, or `authored-in-place` — and,
being part of the tool's output, it is in the run artifact with everything
else the call returned. Not an atom, not a taxonomy, not a new label.

Those three are the piece's own origin states rather than a claim about
who typed the code, and the difference matters: **the revision log records
no author**
([`runner.ts:1200`](../../packages/runner/src/runner.ts#L1200) — a revision
carries an id, a timestamp, a pattern, a source link, an origin and an
operation, and nothing about a principal). So "this principal wrote it"
versus "another principal did" is not a fact this can report today. What
the piece does record is whether it follows a pattern the deployment
serves, follows source elsewhere in the fabric, or follows nothing, which
is what an in-place edit leaves behind. If per-author provenance is wanted,
it is a revision-log change in the runner and not a harness one.

### `revise_piece`

Takes a piece handle and a revised `sourceText`, runs
`checkPattern` and then `setPattern`, and returns the revision id and a
handle to the refreshed result. It never returns source.

`expectedRevisionId` is optional. Supplied, the piece's current revision is
read before anything is compiled and a mismatch refuses the write: a piece
that moved since the source being edited was read is a different piece to
revise. Independently of it, the write carries the piece's current pattern
as `expectedPattern`, which the apply path re-checks inside the write
transaction, so a writer landing between the preflight and the commit is
refused by name rather than written over.

**Neither is atomic, and the residual case is worth naming.** The
precondition is a read, and the pin names a content-addressed pattern rather
than a revision. So a concurrent revision landing between the precheck and
the commit is caught by the pin only when it changed what the piece runs; a
concurrent revision to *byte-identical* source keeps the same pattern
identity, satisfies the pin, and commits. What that case costs is a revision
id the caller did not expect, over source the caller did read — the piece
runs the program the caller was editing against either way. Closing it
properly means pinning the revision inside the write transaction, which is a
piece-controller change rather than a harness one.

`dangerouslyAllowIncompatibleSchema` is not exposed. A session cannot
obtain the informed consent that flag stands for, and the spec requires
explicit human confirmation bound to the exact compiled candidate
([`piece-source-lifecycle.md`, "Compatibility policy"](../specs/piece-source-lifecycle.md#compatibility-policy)).
An incompatible candidate is a refusal carrying `checkPattern`'s report,
which is what the child needs to write its next attempt.

Every refusal goes through the same bare-identifier scrub `run_pattern`
gives its model-facing text, so a lower-layer error naming a document does
not carry that address into the child. One error is handled by type instead
of by scrub: a piece that moved under the pin raises an error quoting the
pattern it was proved against as `<identity>#<symbol>`, and a bare content
identity carries no scheme for the scrub to recognize, so that case is
answered in this tool's own words.

That refusal is also where [`space-clone-rehearsal.md`](../development/space-clone-rehearsal.md)
sends a change a person has to judge. Its first trigger is exactly this
one — the compatibility check failing, or the update needing the override —
and on a space that holds pieces the refusal says so and names the
procedure. The procedure needs a server-side `VACUUM INTO`, a copy to an
operator's machine, and a person judging whether content survived, none of
which is in a session's reach; a rehearsal claimed by an agent would be a
claim the artifact could not back. Additive input fields with defaults and
UI-only changes are exactly what it says needs no rehearsal, and they are
what a revision to the bills piece is.

Its other three triggers — a changed result schema a sibling reads, more
than one live pattern generation, a board whose children are separate
pieces — are not detected. Each needs information the tool would have to
grow machinery to get, and the compatibility check already stands between
this tool and the case those triggers exist to catch, which is a candidate
applied over data it cannot run. Detecting them is worth doing when a run
shows one of them mattering, and not before.

The name is the spec's. Its transition table calls this row "Directly edit
or wish an existing piece to change", appending a **direct edit**
([`piece-source-lifecycle.md`, "Source transitions"](../specs/piece-source-lifecycle.md#source-transitions));
`update_pattern` would collide with `origin-update`, a different row.

### What applying it does to labels

Nothing new, and that is the point. The existing data keeps its labels: the
update replaces the program, not the argument or the stateful documents,
and is refused outright if the retained argument does not satisfy the
candidate. The revised program's derived values go through the runner's
commit boundary like any write. A revision that widens what a cell reads is
caught by writer-fit, a named per-transaction refusal gate measured at
commit
([`refusal-detail.ts:68`](../../packages/runner/src/cfc/refusal-detail.ts#L68)) —
the same rule that catches a first-authored program doing the same thing.
The setup transaction carries the requesting principal's CFC trust snapshot
rather than the serving identity's
([`server-pattern-lifecycle.md`, "Authority"](../features/server-pattern-lifecycle.md#authority)).

## Open, and not built

### Is `revise_piece` really `run_pattern` with a target piece?

Ben's question, and it is a good one. The two tools do overlap: both take
`sourceText`, both compile it, both return a handle to a result. The
difference is the target — `run_pattern` creates a piece, `revise_piece`
replaces the source of one that exists — and everything else follows from
that: the compatibility checks, the revision id, the rehearsal refusal.
`run_pattern` with an optional `piece` argument would fold them into one.

What a model gains from one tool: fewer tools to choose between, and the
choice it does make is a data choice (is there a piece id?) rather than a
naming choice. Authoring and revising are the same act to a model that has
already written the source, so a single tool matches what it is doing.

What it loses: the two calls have genuinely different failure vocabularies.
`run_pattern`'s failures are compile and startup; `revise_piece`'s are
those plus four compatibility refusals and a rehearsal refusal, none of
which can happen without a target. One tool means one schema describing
both, so the model reads about refusals that cannot apply to the call it is
making, and a tool description that is the union of two contracts. It also
means the rehearsal refusal has to be explained on the tool a model reaches
for constantly rather than on the one it reaches for when revising.

Not settled here. It is worth revisiting once the demo has shown which
mistake a model actually makes: reaching for the wrong tool, or misreading
a merged one.

### The fresh-authoring retype cost

An agent that gets one character wrong retypes the whole pattern. Runs 3–7
of CT-2189 spent four to eight `run_pattern` attempts each to land one
working program, and every failed attempt resent the entire source, so the
burn is superlinear in attempts rather than linear. That is CT-2299, and it
is not what this change fixes.

The obvious shape — write the pattern to a file with `edit_file`, then run
it from the file — is refused today, and for a reason that is worth having
written down beside this. `run_pattern` accepts only inline `sourceText`; a
workspace-file source is a trusted-host read channel whose compile
diagnostics can exfiltrate file content, so it comes back only as a
mediated capability, with reads routed through the same policy surface as
`read_file` and CFC observation metadata on the source bytes
([`ROADMAP.md` §5](../../packages/cf-harness/docs/ROADMAP.md)). The other
shape is edits against a source the harness already holds host-side, which
needs no new read channel at all. Both are CT-2299's to choose between.

## Defects found while building

Go to CT-2320, not here. This document describes what the two tools are; it
is not a ledger of what was wrong on the way.
