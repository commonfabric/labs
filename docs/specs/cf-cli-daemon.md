# `cf` CLI daemon

## Status

This document specifies intended behavior. The daemon is not implemented.

The invocation-identity rules it describes ARE in effect for direct execution:
`resolveInvocationIdentity` (`packages/cli/commands/piece.ts`) mints both
halves when neither is supplied, takes both when both are, and rejects an
invocation id offered without the session it is replayable within. What this
document adds is where those rules sit relative to a daemon — resolved by the
short-lived client before admission, carried as request-owned data, never read
or minted or retained by the daemon process.

## Summary

Fabric-facing `cf` commands currently create an identity-backed connection,
runtime, storage manager, authenticated memory connection, and synchronized
replica for each invocation. A named local daemon retains the reusable
connection state so separate CLI invocations can avoid that setup cost.

The daemon is a **connection host**, not an execution host. It retains identity,
connection, replica, and safe content-addressed caches. Every request receives
fresh execution state, and request-created pieces, reactive graphs,
subscriptions, collectors, and background work are torn down before the next
request executes.

Daemon use is explicit. Ordinary `cf` commands continue to run directly. A
caller starts a named daemon and selects it on each routed command. The CLI
never silently starts a daemon, selects one, falls back to direct execution, or
replays a mutation.

## Goals

- Reduce the latency of repeated fine-grained commands against one Fabric
  context.
- Preserve the direct command's arguments, output, exit status, authorization,
  piped-input behavior, synchronization, and durability behavior.
- Support independent CLI processes, agents, scripts, and shell completion.
- Make daemon selection, ownership, compatibility, health, and staleness
  visible to the caller.
- Prevent overlapping daemon requests from introducing new runtime or storage
  races.
- Make observation distinct from execution: inspection and completion never
  start a piece or trigger reactive work implicitly.
- Detect loaded code and identity material becoming stale and fail closed.

## Non-goals

- Keeping pieces or reactive execution running between commands.
- Making a sequence of CLI commands atomic.
- Providing offline reads from a stale replica.
- Providing exactly-once mutation execution after a daemon crash.
- Accelerating local-only, offline, test, or interactive terminal commands.
- Serving watch, subscribe, streaming, or otherwise indefinite commands. These
  commands retain execution by definition and remain direct. A retained-
  execution host, if wanted, is a separate design built on the connection and
  lifecycle seams established here.
- Sharing one daemon across unrelated identities, APIs, primary spaces, or
  runtime configurations.
- Hiding daemon use as an automatic implementation detail.

## Use cases and command scope

### Observation and execution boundary

Daemon command classification follows behavior rather than command naming. An
observational request may synchronize and read persisted Fabric state, but it
must not start a piece, schedule reactive execution, invoke a handler or
builtin, or cause a write. A command or option that can do any of those things
is effectful even when its primary purpose is to display information.

The default inspection forms are cold in both direct and daemon execution.
Existing implementations that start pieces while listing metadata, discovering
callables, building maps, or completing a command must be refactored before
those forms can enter daemon scope. The daemon does not create a second set of
inspection semantics merely to make routing safe.

Callers that want computation use an explicit execution operation such as
`piece step`, `piece get --step`, `piece call`, or `piece render`. If a future
inspection command needs a combined start-and-observe form, its name or option
must identify that execution explicitly. Such a form enters the effectful
request class and is not enabled merely because its cold form is supported.

### Repeated inspection

Humans and agents repeatedly inspect one space through:

- `cf piece ls`
- `cf piece get`, excluding `--step` initially
- `cf piece inspect`
- `cf piece verbs`
- `cf piece search`
- `cf piece map`

These commands form the first implementation scope after their implementations
satisfy the observational boundary. A command remains unsupported until it has
a cold implementation; in particular, the current start-on-read behavior of
listing, callable discovery, mapping, or completion cannot be routed unchanged.
The commands reuse the synchronized replica while receiving fresh request
state.

### Fabric-backed shell completion

`cf completion complete` uses the daemon for Fabric piece, callable, and
cell-path candidates when the half-typed command line contains
`--daemon <name>`. The completion parser resolves that option from the line it
is completing; the shell script does not carry a daemon setting of its own.
Completion script generation remains direct.

Completion reads persisted metadata and never starts a piece. A callable or
other candidate that cannot be discovered without execution is absent until an
explicit execution operation has materialized the necessary state. Pressing
Tab must not execute user code or produce Fabric writes.

Completion keeps its existing silent-empty failure contract. An absent, busy,
stale, or incompatible daemon produces no Fabric candidates and no diagnostic
in the candidate stream. This is the deliberate exception to the normal
routed-command rule that daemon failures are reported to the caller.

### Fine-grained mutation

The required second scope is:

- `cf piece set`
- `cf piece apply`
- `cf piece call`
- `cf piece link`
- `cf piece set-slug`
- `cf piece rm`

These commands require request identifiers, confirmed completion, and explicit
outcome-unknown handling. They never receive transport-level automatic replay.

### Pattern development and semantic discovery

The following commands are later scope because they add filesystem,
compilation, or execution-lifecycle concerns:

- `cf piece new`
- `cf piece setsrc`
- `cf piece getsrc`
- `cf piece step`
- `cf deps update`
- `cf wish`

ACL operations, `cf piece view`, non-watching `cf piece render`,
`cf piece recreate-root`, and `cf piece set-home` are compatible optional scope
but do not drive the design.

### Direct-only commands

Local, offline, test, process-management, and interactive commands remain
direct. This includes the top-level `cf check`, `cf test`, `cf view`, `cf id`,
`cf init`, `cf inspect`, `cf space`, and `cf fuse` commands, daemon-management
commands, and completion script generation.
`cf piece render --watch` and any future watch or subscription form remain
direct. `cf exec` also remains direct; routing a shebang-run mounted callable
through a named daemon requires a separate explicit propagation design.

Every command not listed as supported defaults to unsupported. Passing
`--daemon` to an unsupported command fails before dispatch and names the direct
invocation as the available behavior. New commands do not acquire daemon
support merely by being added to the CLI.

## User interface

### Starting and selecting a daemon

A caller creates a fixed named context:

```console
cf daemon start work \
  --api-url https://example.com \
  --identity ./work.key \
  --space team-space
```

Callers may choose a name directly or derive a stable, shell-safe name without
starting anything:

```console
cf daemon name --scope worktree --prefix dev
```

The generated form combines the prefix with a digest of the canonical
worktree. It prints only the name by default so an agent or script can capture
it. Generation does not reserve the name, select a daemon, or make daemon use
implicit.

The start command reports the name, PID, owning checkout or immutable build,
API, identity DID, primary space, runtime configuration fingerprint, and socket
location. It reports readiness only after the daemon owns its name, listens on
its private endpoint, has installed its source and identity watchers, and can
answer the control protocol.

A routed command names the daemon:

```console
cf --daemon work piece get --piece fid1:abc123 items
```

An absent, stale, degraded, foreign, or incompatible daemon causes the command
to fail before dispatch. The CLI explains the state and the explicit recovery
command. It does not start a replacement or run the operation directly.

Connection options repeated on a routed command must match the daemon context.
A conflicting API, identity, primary space, or runtime option is an error.

### Management and observability

The control surface is:

- `cf daemon name --scope worktree [--prefix <prefix>]`
- `cf daemon ls`
- `cf daemon status <name>`
- `cf daemon logs <name>`
- `cf daemon doctor`
- `cf daemon prune`
- `cf daemon stop <name>`
- `cf daemon restart <name>`

Status includes ownership and compatibility metadata, connection and sync
state, source state, the active request and its origin metadata, bounded origin
summaries for queued requests, queue depth, retained resource counts, and the
last terminal daemon error. Trace mode separates client startup, IPC, queue
wait, request setup, command work, synchronization, cleanup, and total latency.

`daemon doctor` is read-only. It diagnoses runtime-directory permissions,
unreachable endpoints, inconsistent sidecars, source and protocol mismatches,
and owners whose liveness cannot be proven. `daemon prune` removes only records
whose endpoint is unreachable and whose recorded instance is proven dead. It
refuses to remove a reachable or uncertain owner. Neither command stops a live
daemon.

Normal command stdout retains its existing format. The explicit `--daemon`
selection identifies the route without wrapping JSON or adding a banner.

## Namespace and ownership

Daemon names occupy a default namespace per OS user and host. The namespace
lives in a user-private runtime directory and is shared across `cf` processes
and checkouts. A live name is exclusive.

Tests and automation may select a separate namespace with the explicit global
option `--daemon-namespace <name>` or `CF_DAEMON_NAMESPACE`. The option applies
to daemon management and routed commands, contains only a restricted name
rather than a path, and selects a child of the same user-private runtime
directory. Status and diagnostics always report the namespace. A namespace
changes discovery only: it does not weaken ownership checks, alter the daemon's
Fabric context, or cause automatic daemon selection. Production commands use
the shared default when the option and environment variable are absent.

Starting an occupied name reports one of:

- the compatible daemon is already running;
- the name belongs to another checkout or build; or
- the name has a different Fabric or runtime context.

The new process never replaces, stops, or repurposes the owner automatically.

Every connection begins with a compatibility handshake. Source-mode execution
requires the same canonical checkout and source generation. Immutable clients
may share a daemon when their immutable build identity and execution protocol
match. A foreign client can use the stable control protocol to inspect the
daemon but cannot dispatch commands.

## Fixed daemon context

A daemon is fixed to this compatibility tuple:

```text
checkout or immutable build
+ execution protocol version
+ API origin
+ identity fingerprint
+ primary space
+ runtime and experimental configuration fingerprint
```

The runtime may discover and open other spaces while following cross-space
links. Those providers remain subordinate to the fixed primary context and do
not allow later requests to retarget the daemon.

The tuple also makes process-wide runtime state reusable. Pattern environment,
LLM routing, experimental configuration, one-time SES initialization, deferred
compiler state, and sidecar pattern caches cannot be safely retargeted between
unrelated requests merely by constructing another `Runtime`. Fixing API,
identity, and configuration is therefore a correctness boundary, not only a
user-interface convention. Every retained cache must still include all inputs
that can change its result; existing caches whose keys are narrower must be
fixed or kept request-owned.

## Retained and request-owned state

### Retained state

The daemon may retain:

- the deserialized identity and signer;
- the storage manager and its authenticated storage connection identity;
- memory transports and synchronized replicas;
- storage watches and bounded storage-level pull knowledge, including the
  per-document deduplication state that prevents repeated pull registration;
- fixed configuration and server compatibility metadata; and
- caches whose keys fully identify their content and configuration.

### Request-owned state

Every request owns and must release:

- its runtime execution facade;
- started pieces and reactive graphs;
- request subscriptions and scheduler work;
- error and console collectors;
- navigation callbacks and other command effects;
- the caller's Fabric invocation identity: the `--invocation` ID paired with
  the invocation session resolved from `--invocation-session` or
  `CF_INVOCATION_SESSION`; and
- filesystem/compiler state that is not safely content-addressed.

The Fabric invocation identity is caller input, not connection state. The pair
decides where a handling's receipt lands: the same invocation ID under two
invocation sessions names two invocations. Retaining a pair across requests
would place unrelated callers in one deduplication scope, where one caller
could be told that its request settled on another caller's outcome.

The short-lived client resolves the pair under the same rules as direct
execution before daemon admission. `--invocation-session` overrides
`CF_INVOCATION_SESSION`; when neither half is supplied, the client mints both;
and an invocation ID without an invocation session is rejected before dispatch. The normalized pair travels
as an explicit request-envelope field. The daemon process never reads its own
`CF_INVOCATION_SESSION`, never receives it as request environment, never mints
either
half, and never retains the pair after request cleanup.

The next request is not admitted to execution until cleanup has stopped
request-owned work and the previous request has reached the same confirmed
storage boundary as its direct command.

`Runtime.dispose({ closeStorage: false })` is the existing starting seam: it is
intended to tear down a runtime while leaving its caller-owned storage manager
open. It is not sufficient unchanged. `Scheduler` and `Runner` each register a
storage-manager subscription during construction, and runtime disposal does not
currently unregister those subscriptions. Sequential runtimes would therefore
leave disposed schedulers and runners reachable from the retained manager.

The lifecycle work must also classify manager state that outlives a runtime,
including telemetry attachment, document-pull deduplication, registered space
identities, and dynamic host knowledge. It must prove which state is valid for
the fixed daemon tuple, what resets at a request boundary, and what remains
bounded. Reusing the current CLI runtime unchanged is not sufficient: process
exit currently supplies part of that isolation.

Making storage subscription ownership explicit is useful independently of this
daemon: any test or service that constructs sequential runtimes over one
retained manager otherwise risks keeping disposed runtime objects reachable.

## Request scheduling

The daemon accepts multiple client connections and may hold multiple requests,
but one daemon context executes exactly one request at a time. Accepted requests
enter a bounded FIFO queue.

The short-lived client completely materializes any stdin input before queue
admission. It reads through end of stream, performs validation that does not
require Fabric state, and retains the resulting value until the request reaches
the execution lane. Context-free parse errors and interrupted input therefore
fail before daemon dispatch, and a producer that has not closed its stream
keeps only its client waiting rather than occupying the daemon queue. Validation
that depends on synchronized Fabric state, such as interpreting `piece call`
input against a callable schema, occurs inside the serialized execution lane.
Once the request reaches the head, the daemon grants a backpressured transfer
of the explicit value and does not begin command execution until that transfer
is complete.

This serialization protects shared runtime configuration, one authenticated
memory connection, request output attribution, and request cleanup. Observational
commands are not initially parallel even though they do not start execution:
they can establish request-owned subscriptions, pull linked data, and interact
with the retained replica while it synchronizes.

The queue has a request-count bound and stores only bounded request metadata;
queued input values remain in their client processes. A full queue rejects
admission immediately with `DAEMON_BUSY`; callers do not retry automatically. A
queued request is cancellable. Once an effectful request begins, client
disconnection does not cancel or replay it.

Serialization only orders requests through this daemon. Browsers, other
daemons, servers, and direct CLI invocations remain concurrent Fabric actors.
Memory's optimistic commit, precondition, path-conflict, and conflict-retry
semantics remain authoritative. The daemon adds no distributed lock and does
not make separate commands atomic.

## Request identity and effectful outcomes

Every admitted request has an instance-qualified daemon request ID and advances
through explicit states:

```text
queued -> canceled
queued -> executing -> completed
                  -> canceled (reads only)
                  -> failed
                  -> outcome-unknown
```

The daemon request ID is transport identity for queueing, cancellation, and the
in-memory result ledger. It is unrelated to the caller's Fabric invocation
identity and never substitutes for either half of that durable pair.

The request envelope also contains advisory origin metadata: the client
instance nonce, client PID where meaningful, original working directory, and an
optional caller label supplied by `--daemon-caller <label>` or
`CF_DAEMON_CALLER`. Status and diagnostic logs may show this metadata so users
can identify competing agents or scripts. It is not an authentication signal,
does not affect queue ordering, and never substitutes for endpoint ownership or
peer checks. Arguments, stdin payloads, and cell values remain excluded from
default logs.

The daemon retains a bounded, in-memory-only result ledger for reconnecting
clients. It is never persisted and its payloads are excluded from default logs.
A queued request whose client disconnects is removed. A disconnected read may
be canceled or allowed to finish with its output discarded because a read is
observational by definition. An executing effectful request finishes and
records its result while the daemon remains alive.

If the daemon crashes after effectful dispatch without recording a terminal
result, the client reports `outcome-unknown`. Neither side repeats the request.
For Fabric handler calls, the caller's invocation ID and invocation session
form a durable idempotency identity. Reusing the pair for the same stream
provides at-most-once commit and returns the original receipt, although handler
execution and effects outside its transaction may repeat. That Fabric contract
does not make automatic daemon transport replay safe.

## Output and caller context

The execution protocol keeps stdout, stderr, and exit status distinct and
ordered. It applies backpressure rather than accumulating unbounded output.
The daemon never reads or inherits a caller's stdin. The client owns terminal
and pipe detection and converts caller input into an explicit request payload
before admission. Thus piped `piece set`, `piece apply`, and `piece call`
retain their direct behavior without multiplexing ambient stdin through a
long-lived process. Syntax errors that require no Fabric context fail in the
client; schema-dependent errors retain the direct command's diagnostics but are
reported from the execution lane. The daemon command handlers accept an
explicit input value and have no stdin reader available. Client cancellation
and signals are explicit protocol events.

The client sends its original working directory, absolute forms of recognized
file arguments, and an allowlisted command environment. The daemon never
changes process-global cwd to serve a request and never receives the caller's
complete environment. Interactive TTY commands remain direct.

Request-scoped diagnostics return only to their request. Reactive or transport
diagnostics that outlive a request go to the daemon log and cannot contaminate
a later request's stdout or stderr.

## Freshness and connectivity

The retained replica is not an offline result cache. Before executing a
request, the daemon establishes that the required storage connection is active
and synchronized and surfaces permanent authorization failures. If it cannot
establish freshness, the request fails without returning an old cached value.

The storage transport's normal reconnection machinery remains responsible for
connection recovery. On each connection epoch the daemon revalidates server
compatibility before admitting further requests. It does not add a polling
timer or hidden command retry loop.

## Staleness

### Immutable builds

Client and daemon exchange immutable build identity and protocol versions.
Mismatch prevents dispatch. The error identifies both builds and requires the
caller to use the owning client, choose another daemon, or restart it.

### Mutable source checkouts

Git commit identity is insufficient for dirty worktrees. Before announcing
readiness, a source daemon installs filesystem watchers over a conservative
manifest containing its implementation sources, workspace configuration, and
lock inputs. It also records a content fingerprint of that manifest and
revalidates it immediately before request admission. A mismatch, watcher error
or overflow, or relevant watcher event advances the source epoch and
permanently marks the loaded process stale, even if the file is later changed
back. The watcher provides prompt invalidation; admission-time revalidation
catches changes whose event has not yet been delivered.

Mutable filesystems do not provide an atomic transaction spanning fingerprint
validation and command dispatch. A file can change in that interval, so a
request already being admitted may execute the daemon's loaded generation. The
next admission detects the mismatch and fails closed. Callers requiring a
strict guarantee that no request can race a source edit must use an immutable
build identity rather than a source daemon.

Pattern files supplied as command inputs are not daemon implementation. They
are read fresh per request and use content identity for any retained cache.

The daemon also watches its identity key. A key change makes the authenticated
context stale. Server build compatibility is rechecked on transport reconnect.

### Stale transition

Staleness changes the daemon from `running` to `draining-stale`:

1. Stop admitting new requests.
2. Let the active request complete under the code generation with which it
   began.
3. Reject queued requests with `DAEMON_STALE` without direct fallback.
4. Drain confirmed writes and tear down request and retained state.
5. Exit and require an explicit restart.

If staleness is detected during an active effectful request, its actual result
remains authoritative. A successful result is not converted into a generic
failure that would invite replay. The response adds a stderr warning that the
daemon became stale and cannot accept another request.

## Lifecycle and crash recovery

Name acquisition and endpoint publication are atomic. Namespace metadata
contains a daemon instance nonce; PID alone is not proof of ownership because
PIDs are reused. A client removes an abandoned endpoint only after the control
endpoint is unreachable and the recorded owner is proven dead.

Graceful stop rejects new admission, rejects queued work, lets the active
request finish, drains confirmed writes, closes storage connections, and exits.
Forced termination is a separately named explicit operation and warns when an
active effectful request can be left outcome-unknown.

The daemon has no automatic idle shutdown. Resource bounds and explicit
management, rather than a sleep or timeout, govern its lifetime.

## Security

- Runtime directories, metadata, and endpoints are private to the OS user.
- Startup resists symlink and endpoint-replacement races.
- The control endpoint verifies same-user peers where the platform supports
  peer credentials. Endpoint and directory permissions remain the required
  protection on runtimes, including Deno, that cannot expose Unix peer
  credentials.
- Metadata and logs identify the signer by DID or fingerprint and never contain
  private key bytes.
- Request payloads and cell values are excluded from default logs.
- The caller's invocation ID and invocation session are excluded from default
  daemon logs, queue diagnostics, origin metadata, and result-ledger metadata.
  The invocation session is the unguessable component of the receipt address;
  returning it to the requesting client for recovery does not authorize
  recording it in shared daemon diagnostics.
- Holding a deserialized signer for the daemon lifetime is an explicit security
  tradeoff reported by `daemon status`. Any same-user process able to reach the
  endpoint can ask the daemon to act as that identity without reading or
  unlocking the key again. A future passphrase, hardware, or interactive key
  boundary must decide explicitly whether daemon lifetime is allowed to outlive
  that authorization ceremony.

## Protocol separation

A small stable control protocol supports identity, status, compatibility, and
shutdown across execution versions. A separately versioned execution protocol
carries commands, streams, cancellation, and results. Control compatibility
does not imply permission to execute.

Direct and routed commands share one parser that produces a normalized request
envelope. Daemon routing is selected before importing Fabric connection and
runtime implementation modules, so the short-lived client does not pay the
setup cost that it is delegating. The implementation does not duplicate command
parsing or validation rules in a daemon-only client path.

## Implementation stages

1. Use the existing `CF_CLI_TRACE_TIMINGS=1` phase instrumentation and an outer
   process measurement to define representative direct and warm-workload
   baselines. Compare the daemon against the compiled CLI and simpler direct-
   startup optimizations. Measure the routed client's module-loading cost and
   source-manifest revalidation separately. This is a go/no-go gate: do not
   build the daemon when the measured reusable cost does not justify its
   lifecycle and security surface.
2. Start from `Runtime.dispose({ closeStorage: false })` and prove request-
   runtime teardown over a retained storage manager. Add the missing
   scheduler/runner storage unsubscription and demonstrate no live piece,
   scheduler, subscription, collector, process-global cross-contamination, or
   background-work leakage. Separately prove that every observational command
   reaches cleanup without starting execution or waiting for effectful tracked
   work; a command that cannot meet that invariant leaves the read scope.
3. Implement the private namespace, stable control protocol, explicit lifecycle,
   compatibility handshake, generated worktree names, origin metadata,
   read-only diagnostics, proven-dead pruning, and source/identity invalidation.
4. Refactor the MVP inspection commands so their direct and routed forms are
   cold, then implement bounded serialized request transport for those commands.
5. Route explicitly selected Fabric-backed completion through the cold read
   path.
6. Add terminal-result lookup, confirmed completion, and outcome-unknown
   handling for effectful daemon request IDs before enabling mutation commands.
   Refactor stdin-accepting commands so the client materializes their input,
   performs context-free validation, and lets daemon handlers perform schema-
   dependent validation without ambient stdin access. Carry the client-resolved
   Fabric invocation identity as request-owned data without forwarding
   `CF_INVOCATION_SESSION`.
7. Add filesystem and compiler commands only after cwd, input freshness, and
   content-cache boundaries are validated.

## Validation

The implementation must demonstrate:

- exact stdout, stderr, JSON, and exit-status parity with direct commands;
- no observational command or completion request starting a piece, scheduling
  reactive execution, invoking a handler or builtin, or producing a write;
- no request-owned live execution after request cleanup;
- confirmed writes before the next queued request begins;
- no automatic replay under disconnect or daemon crash;
- the same handler call run directly and routed deriving the same receipt
  address from the same invocation ID, invocation session, and stream;
- sequential routed calls through one daemon using the same invocation ID and
  stream but different invocation sessions deriving different receipt
  addresses;
- an invocation ID without an invocation session failing before daemon
  admission;
- the daemon process's environment being unable to supply or override an
  invocation session;
- invocation IDs and invocation sessions remaining absent from default daemon
  logs, queue diagnostics, origin metadata, and result-ledger metadata;
- deterministic rejection of incompatible, foreign, and stale daemons;
- stable generated names without reservation or implicit selection;
- isolation between the default and explicitly named daemon namespaces;
- diagnostic visibility of advisory request origin without payload logging;
- cleanup removing proven-dead records while preserving live or uncertain
  owners;
- detected source and identity changes preventing all later dispatch, with
  admission-time source revalidation and the source-mode race documented above;
- bounded queue, result-ledger, provider, cache, and memory growth;
- no cross-request diagnostic or output contamination;
- piped-input parity with direct commands, including client-side failure before
  dispatch for context-free parse errors and interrupted input;
- no daemon handler access to process stdin;
- fresh-state failure rather than implicit offline reads; and
- a material warm-latency improvement on repeated supported commands.

## Open implementation questions

- What extensions around `Runtime.dispose({ closeStorage: false })` provide
  complete storage unsubscription and correct reset/retention behavior for
  manager and process-global state?
- What conservative source manifest covers the source daemon without watching
  mutable data, logs, and build outputs?
- What queue, input-transfer, output, and result-ledger bounds fit agent and
  completion workloads without imposing a smaller value limit than direct
  commands?
- Which persisted metadata and cold controller seams support `piece ls`,
  `piece verbs`, `piece map`, and completion without starting pieces?
- Which read commands can later prove safe parallel execution without changing
  their Fabric or output semantics?
