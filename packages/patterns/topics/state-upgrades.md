# Topic state upgrades

Topics owns its durable state format. `topic.tsx` declares an ordered list of
upgrade identifiers, the functions implementing those steps, and a shared
`upgradeTopicState` runner. This is pattern code using ordinary cell reads and
writes; the runtime does not choose or interpret Topic versions.

## Version and sequence

`topicStateVersion` is an optional stored input with a default of zero. Version
zero is the shape accepted before any listed upgrade has completed. A version of
N means the first N steps have completed. `TOPIC_STATE_VERSION` is the list's
length, so the board's browser composer and `addTopic` stamp the same current
version when creating a Topic.

The list contains stable string identifiers. Its order defines the sequence;
append steps and retain the existing positions. A switch dispatches identifiers
to their implementations. Its explicit boolean return type requires every
identifier to return a completion result, so an unhandled new step fails to
compile. This keeps module-scope data serializable in the pattern sandbox. A
single version represents progress through a prefix of the sequence, which makes
prerequisites explicit without independent completion flags or arbitrary flag
combinations.

The shared runner validates the stored version as a nonnegative safe integer. A
current version is a no-op. An older version runs its remaining steps in order.
A future or invalid version is left unchanged by the lift and rejected by a
durable mutation, with the verb name in the error.

## Execution and mutation boundary

Running a Topic runs the upgrade lift. No consumer has to read the result or
open the author UI for the lift to write. Each headless content verb and browser
handler also calls the shared runner after validating the request and before its
first durable write. A handler can complete an upgrade when its reads satisfy
that step's readiness guard. For the author step, legacy records with no
structured author object defer to the lift. Incomplete reads leave the version
unchanged; the author upgrade is additive, so content mutations can still
operate on version-zero state when their own inputs are available.

The guarded entry points include comment creation, editing and retraction; link
creation and retraction; title and body saves; and adding or removing mentions.
Module-scope browser handlers carry the same upgrade binding as the headless
handlers. Local draft edits, opening editors, and canceling editors operate on
session state and do not require an upgrade.

A handler does not acquire the lift's suspension behavior by calling the same
runner. A later unavailable input can still prevent that handler's own mutation
from completing. The upgrade guard neither queues the mutation nor promises a
retry. Upgrade progress and the requested mutation's outcome are separate.

## Step contract

Each step reads every source and destination it needs before making its first
write. In the lift, cell-handle reads distinguish a valid absent optional field
from an unresolved link: the unresolved read suspends the lift and registers the
dependency that runs it again when data arrives. Optional property reads can
conflate those cases.

Handler reads can return `undefined` for both absence and an unresolved link.
The author step handles that ambiguity conservatively. An unavailable comment
array leaves the whole step incomplete, without author writes. For a blank
structured name, the author object, its name and kind, and the legacy name must
all be defined before a handler can complete the step. A nonblank structured
name already supplies attribution and does not require a legacy name. The lift
can complete genuinely absent fields. A version-zero record with only
`createdByName` or `authorName`, and no corresponding structured author object,
therefore requires the lift. A handler can complete this step when each author
already has a nonblank structured name or has the defined fields required by the
guard; partially populated structured authors with a blank name can meet that
condition.

A step returns `true` only after completing its writes, or `false` for
incomplete reads. Only `true` lets the runner write the next version in the same
transaction. An incomplete step stops the sequence. A transaction can commit
writes made before a later unresolved read, so reading first is part of
correctness. If a later step is blocked, earlier completed steps and their
version can remain committed. Implementations must be deterministic, read no
clock, and tolerate an already-upgraded target shape. Fabric handles transaction
conflicts; the pattern adds no locking or revision protocol.

Each step must define which mutations remain valid while that step is
incomplete. The author step preserves the old content shape, so the runner
returns to the content handler when migration cannot finish. A step that changes
the shape a handler needs must reject that mutation until its prerequisites are
complete. Future and invalid versions are always rejected before any durable
mutation.

A step's legacy field names are permanent storage identifiers. Keep their
spellings and interpretation fixed when renaming current fields or changing
current authoring conventions. Evolve subsequent shapes with new steps.

## Version zero to one: legacy author names

The first step copies useful `createdByName` and comment `authorName` values
into missing structured author names. A useful value is a nonblank string whose
trimmed value is not the exact placeholder `"someone"`. The stored name is
copied verbatim; trimming only decides whether it supplies attribution.

A nonblank structured name wins. Existing kinds and avatars are preserved; a
copied name with no kind receives `"legacy"`, which expresses that the author
classification is unknown. The step leaves source fields, comment identities,
and unrelated content unchanged. It does not rewrite already-structured
`"someone"` names or infer identities from profiles.

The internal reader accepts partially populated structured authors. Existing
objects receive individual name and kind writes, preserving other properties. An
absent or explicitly undefined author receives a new object; writing a child
property through an explicitly undefined value is not a valid cell write. Reads
through the name and kind handles keep unresolved subfields pending in the lift.

The public input fields retain their broad legacy domains. The upgrade reader
uses the explicit schema type union `["string", "unknown"]`: strings are read as
values, while non-string legacy data stays opaque. TypeScript's
`string | unknown` alone collapses to opaque `unknown` and cannot express that
reader. Both the lift and mutation bindings use the same explicit schema. The
creator and comment-author projections use `Partial<TopicAuthor>`, which the
schema generator inlines. Both must remain inline: the upgrade contract is
embedded in lift and handler schemas, and local `$ref` references resolve
against the enclosing schema document's root. A projection that emits references
requires its definitions at every containing document root. The Topics suites
exercise these bindings and fail when a reference cannot resolve.

Mutations carry a cell containing the upgrade handles. The cell keeps the nested
read-only source handle intact through handler state typing; reading the binding
yields handles, and the runner reads the version before following the legacy
data. Other handler fields retain their generated contracts. The structured
creator remains plain in the outer Topic input; the internal upgrade binding
supplies its writable destination.

## Rollout and rollback

Retire legacy writers before applying the update. The first step covers the
records present when it completes; a legacy client writing another old-style
comment afterward does not reset the version or rerun that step.

Restoring source does not undo data writes. A version-aware older implementation
can render supported portions of newer state while refusing its durable
mutations. This is a write guard, not a guarantee that every future format will
render correctly in old code. It cannot constrain code that predates the guard,
already-running legacy clients, or writes made directly to stored cells.

Use the space-clone rehearsal procedure before applying source to real data.
Admission checks, tests of the exact packaged source, and observation of actual
migration writes establish different things; a successful source compatibility
check alone does not establish successful migration execution.

## Tests and extension

Each step needs coverage starting from the shape immediately before that step,
including already-upgraded targets and unresolved input recovery. Keep a
version-zero-to-current test alongside those per-step cases as the list grows.
The first step is both the individual zero-to-one case and the full sequence.

The Topics suite covers execution without a result read, absent creator names,
placeholders, opaque values, preservation of comment links, reopening from
stored source, replay without overwriting structured names, and two clients
sharing progress. The inertness test clears a structured name after completion
so that ignoring the version would cause an observable unwanted copy.

The version tests exercise all durable entry points against future state and
check both rejection and unchanged data. They also cover invalid versions and a
standalone browser handler upgrading version-zero state before appending,
without a Topic lift to do the work for it. A standalone browser save also
checks that ambiguous inputs preserve the version while allowing the title
write, then completes the upgrade on another save after data arrives.
Integration cases send a title mutation while creator names, comment names,
whole comments, structured authors, and author subfields are unresolved, then
verify migration recovers without losing the title or overwriting arriving
structured attribution. Cases with explicitly undefined and partially populated
authors check object initialization and preservation of existing properties. New
entry points must receive the upgrade binding and join this coverage.
