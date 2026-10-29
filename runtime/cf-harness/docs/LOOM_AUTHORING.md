# Durable Loom authoring

Status: current implementation reference

## Why

A Pattern Instance and a Loom are different objects. `run_pattern` instantiates
a pattern in a Fabric space; `assign_slug` names that instance. A Loom is a
durable collection with components, stage placement, and focus, owned by the
Loom command host. A harness caller needs commit evidence to open that
collection, and a continuing agent needs the original receipt to avoid
duplicating it after an interruption.

## Host configuration

The batch CLI, both interactive stdio entrypoints, and console accept
`--loom-authoring-config /absolute/host-config.json` or
`CF_HARNESS_LOOM_AUTHORING_CONFIG`. The file is supplied by the operator, read
on the host, and never passed into the sandbox. Without it the three Loom tools
are absent, including when an allowlist names them.

Batch profiles can grant `loom_compose`, `loom_inspect`, and
`loom_authoring_context` through `--allow-tool` or a run manifest. The CLI
capability response lists all three as parent tools. Such a grant still needs
the host configuration above before the tools become available.

To collect a held Pattern Instance token, both interactive stdio entrypoints
accept the same complete Fabric binding as batch: `--fabric-api-url`,
`--fabric-identity`, and `--fabric-space`, or their `CF_HARNESS_FABRIC_API_URL`,
`CF_HARNESS_FABRIC_IDENTITY`, and `CF_HARNESS_FABRIC_SPACE` environment
defaults. CFC posture and read ceiling options retain the batch CLI's validation
and defaults. A partial binding fails before the service starts. The host
supplies `inputCells` per turn to grant existing handles; this does not relax
the token checks below.

A broker-backed configuration pins the existing scoped queue:

```json
{
  "cliPath": "/opt/loom/src/bin/loom",
  "transport": {
    "kind": "broker",
    "queuePath": "/private/loom/run/command-queue"
  }
}
```

A direct configuration pins an instance and agent attribution:

```json
{
  "cliPath": "/opt/loom/src/bin/loom",
  "transport": {
    "kind": "direct",
    "instanceDir": "/private/loom/instances/dev",
    "runId": "weaver-console",
    "actor": "agent:cf-harness"
  }
}
```

Paths must be absolute. A direct run identity is nonempty, canonically trimmed,
and at most 128 characters. The optional `boundLoomId` binds context reads for a
batch run, never an implicit composition target. Interactive turns bind their
own `input.loomId` and clear this configuration target when none is supplied.

The command process runs with a cleared environment, the host's executable
search path, and only the configured routing variables. It receives structured
arguments on stdin. The model cannot change the executable, queue, instance,
actor, or run identity. A disappeared broker queue does not permit fallback to
direct access. Direct calls pass `command run --transport direct` before the
command id so filesystem queue discovery cannot replace the configured instance.
An older CLI rejects this flag before dispatch. The host must run a Loom version
supporting that routing flag, `loom.compose`, `loom.inspect`, and
`loom.authoring-context` and must grant those commands to the configured broker.

## Tools and authority

- `loom_compose` creates or extends a collection from 1–100 components. A
  component supplies exactly one `ref` (`page:`, `artifact:`, `url:`, `person:`,
  `thread:`, `moment:`, `loom:`, `wish:`, `intention:`, `chat:`, or `run:`) or
  `pattern_token`, plus optional title, stage, and focus. An existing target is
  named by `loom_id` and may carry an `expected_version` guard.
- `loom_inspect` reads the current version, component metadata, and layout of
  one exact target. It does not grant handles to the referenced cells or return
  renderer internals.
- `loom_authoring_context` returns at most 32 historical receipts in this run's
  actor namespace, plus a separately bound target. History never selects a write
  target and does not count as work newly completed in a turn. A missing
  implicit origin is reported as unavailable beside the remaining historical
  receipts; an explicitly requested missing target remains an error.

Pattern Instance tokens are resolved inside the dedicated tool, without generic
inbound token substitution. They must be held general address handles to whole
Pattern Instances in the configured Fabric session's own space and `space`
scope. Restricted skill handles, subpaths, foreign spaces, and plain cells are
refused before a host write. The host converts the accepted token into the
canonical `pattern:<space>/<instance-id>` Loom reference. That reference stays
outside model-visible output. Legacy `piece:` references read from a Loom are
reported with reference kind `pattern`.

Composition is a write for the harness's existing prompt-slot policy: enforcing
modes still require direct-command authority. The two inspection tools are
reads. This is an authority check, not a new CFC flow-aware commit gate for
Loom's store; host command execution, collection metadata, and titles remain
trusted host responsibilities. Reading a receipt does not attest successful
rendering.

Comment threads retain their ordinary read-only policy unless the host
configuration explicitly sets `allowCommentThreads: true`. With that grant, only
the dedicated Loom tools already named in the session policy survive the
comment-thread restriction. Shell commands, file writes, and delegation remain
unavailable. The grant does not manufacture direct-command prompt-slot
authority. Delegated children do not inherit host Loom configuration
automatically.

## Receipts and recovery

After a successful Loom-mediated Pattern deployment, call
`loom_authoring_context` with no deployment arguments. Supporting hosts return
run-scoped `loom-deployed-pattern-v1` receipts in a separate
`deployed_patterns.receipts` field. The tool admits at most 32 entries, checks
each API base URL and space against the host-configured Fabric session, and
loads the cell to verify its whole Pattern identity. It returns accepted entries
as `deployed_patterns: [{pattern_token}]`; the prompt loop replaces canonical
links with opaque handles in model-facing messages and persists those handles
for subsequent composition and resume. Tool artifacts retain the canonical links
as host-side evidence.

Repeated context calls reuse general handles, including qualified own-space
addresses, and do not expand a restricted skill handle into a composition grant.
Missing Fabric backing, omitted receipt fields from older hosts, foreign or
malformed receipts, and unavailable cells contribute no Pattern tokens while
ordinary Loom context remains available. Shell output and model supplied Pattern
addresses do not authorize this handoff. The Loom deployment route remains
responsible for recording actual success under its broker run identity
independently of best-effort placeholder placement.

Choose one `request_id` for one logical composition and retain its exact
arguments on retry. The host atomically commits components, operations, and a
receipt. A successful tool observation has `kind: "loom-authored"`, its
historical `receipt`, `replayed`, `current_version`, and current `displaced`
component ids. The receipt includes the Loom id, logical request id, commit
version, created flag, component ids, operation ids, and historical displaced
component ids.

An identical retry returns the original receipt. Its commit version may be older
than `current_version`; a replay's current `displaced` is empty even when the
old receipt recorded an eviction. Report only current effects as actions
performed by this invocation.

Verified host refusals retain an allowlisted code and bounded recovery guidance.
A version conflict requires inspection and reconsideration. A request conflict
means the key already names different committed arguments: recover the original
receipt before deciding whether any new work is needed. Raw host errors are not
relayed to the model. An unreadable or malformed composition response remains an
uncertain outcome; retry the identical request with the same key. Cancellation
before invocation prevents a command. A started host command settles even if the
model turn is cancelled, and cancellation does not roll back a commit.

## Interactive and console delivery

Direct interactive calls derive their receipt namespace from the configured run
identity and stable session id, using the shared SHA-256 implementation. Each
turn retains its own run id for artifacts. Broker-backed calls retain the
broker's attribution and namespace.

`POST /api/task` accepts optional `loomId`, validated before a turn starts. It
is persisted as `input.loomId`, delivered to that turn's host configuration and
context message, and returned as `originLoomId`. A later turn or a change of UI
focus does not replace an earlier origin. The originating Loom is context: an
explicit request for a separate collection can still create one.

Completed console results retain `pieces` and add an always-present `looms`
array. Entries contain `receipt`, `replayed`, and `current_version`. Only
verified successful `loom_compose` observations generated in that turn qualify.
Earlier transcript history, inspections, history lookups, prose, and malformed
receipts produce no authored entries. An explicit replay in the current turn is
included as a replay. Callers open a returned Loom by its receipt id through
their Loom host; they never infer success from assistant text.

A named Pattern also carries optional `loomComponents: [{loomId, componentId}]`
when its successful `assign_slug` call and a successful `loom_compose` call used
exactly the same held token in this turn. Tool-call IDs must uniquely pair with
preceding current-turn calls; receipt component count must match the request,
and receipt IDs retain request order. Missing, historical, malformed or
ambiguous pairs prove no membership. Different tokens for one Pattern can
therefore leave a conservative duplicate; the console does not resolve token
aliases here. When using this metadata, the native client must check both IDs
against a freshly read opened manifest before suppressing ordinary Pattern
placement. Weaver's legacy exact-reference comparison can independently prove
membership; missing token correlation does not always require placement. No
token or cell address is exposed by this metadata.

Existing durable sessions retain their recorded tool policy. An adapter enabling
new tools must create a session with the updated policy or explicitly refresh
its policy; merely restarting a console does not expand an existing session's
grants.
