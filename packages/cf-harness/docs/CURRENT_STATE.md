# cf-harness Current State

Status: current implementation reference\
Last verified: 2026-10-06\
Revision: `698601e13c`

The [system map](system-map/README.md) moves in lockstep with this current-state
reference.

`cf-harness` is an experimental but product-integrated Common Fabric agent
runtime. Loom is its first product adapter and Pattern Factory is its first
multi-phase orchestration adapter.

## Architecture

The runtime has four main boundaries:

1. The caller supplies prompt-slot roles, model and gateway configuration,
   tools, child profiles, mounts, resource bounds, skills, policy mode, and
   optional structured-result schemas. A run configured with one offers
   `submit_result`, a host-side tool that validates the value and writes the
   structured-result file, so a run whose prompt-slot role admits no sandbox
   write can still return one. The schema and host path persist with root run
   state and are restored on resume.
2. The prompt loop performs bounded turns through the selected model provider
   and invokes only the configured tool/profile surface.
3. Most tool execution runs in a gVisor sandbox through one of two drivers: one
   drives Docker with a configurable Docker-registered runtime, normally
   `runsc-cfc`, and the other invokes a `runsc` binary directly, with no Docker.
   A run names one. Where it names none, macOS takes the direct driver and every
   other platform takes Docker, except that the Loom local host, and a console
   launched for a Loom instance, refuse. [Sandbox runtimes](#sandbox-runtimes)
   describes both. The browser child is a constrained host-adjacent profile
   whose typed `browser` tool the harness sends to a browser host attached to
   the run, such as the Weaver, or else binds to a leased local CDP endpoint
   itself. The optional `run_pattern` tool is a distinct trusted-host path whose
   Fabric identity stays outside the sandbox. It runs pieces in the configured
   space and admits input references from that space or foreign DIDs the
   operator lists with their hosts. The agent result writer is a second such
   path, invoked by a host caller rather than by the model, writing a run's
   structured result into the configured space.
4. The artifact store records run state, the model-facing transcript, a sibling
   record of the omission rules and full-artifact locations applied to each tool
   result, reports, capability and policy snapshots, tool outputs, child
   references, skills provenance, and optional product run manifests. The
   omission record carries no withheld values and is read only for retrospective
   display and audit accounting. The store also records the per-cell CFC labels
   the run's space holds for the cells the run touched — the one artifact a run
   does not write out of its own knowledge, read back from the space so a reader
   working from the tree alone can see what a cell is labelled.

The Common Fabric runner or another trusted mediator owns authoritative CFC
meaning. The harness transports prompt-slot and invocation evidence, applies the
selected exposure/side-effect policy, and records its decisions. It does not ask
the model to make policy decisions.

## Sandbox runtimes

Sandboxed tools execute through one of two drivers. A command has a trusted CFC
result only where the driver's CFC transport is configured: a result directory
under the Docker driver, a CFC policy under the direct driver. Both drivers read
that result through one shared parser, which marks the command's output
`observed`, `opaque`, or `denied`. The parser reads one shape differently for
the two: a result whose structured label is empty beside a non-blank label
string that is not `runsc`'s spelling of the empty label. The Docker driver
reads that output as `observed`, and the direct driver withholds it. A blank
label string beside an empty structured label is withheld under both.

- The **Docker driver** shells out to Docker and names a Docker-registered
  runtime, normally `runsc-cfc`. Where they are configured, the CFC invocation
  context and the result travel through two host sidecar directories that the
  runtime's registration names.
- The **direct driver** writes an OCI bundle and invokes a `runsc` binary
  itself, with the same command line on Linux and on macOS. On Linux that binary
  is expected to be gVisor's `runsc`. On macOS it is expected to be the darwin
  build from the sibling `gvisor` repository, which is expected to forward the
  command line into one VM that every run on the machine shares; the forwarding
  and the VM are that build's behavior and not the harness's. Where a CFC policy
  is configured, the invocation context goes in, and the result comes out, on
  descriptors the driver opens for each call, so no directory is registered
  anywhere. With no policy, `runsc` is run without `--cfc`, it is passed no
  invocation context, and the call has no result.

### Selection

`CF_HARNESS_SANDBOX_RUNTIME` selects the driver, `docker` or `runsc`. On the
batch CLI `--sandbox-runtime <docker|runsc>` selects it too, and the flag wins
over the environment. Any other value is refused. A named driver is taken as
named on every platform: `docker` is Docker whatever the machine holds, and
`runsc` is the direct driver with the settings named beside it.

Where neither names a driver, the entrypoint decides, and nothing falls back
from one driver to the other:

- The Loom local host takes no default, on any platform. Loom names the driver
  of every run it starts, so a `batch` or `interactive` run that names none is
  refused, saying that Loom must name `docker` or `runsc`.
- A console launched for a Loom instance takes none either. `console:launch`
  given `--instance` is that launch: `scripts/start-local-dev.sh` passes the
  flag exactly where `LOOM_INSTANCE_ID` is set. Loom chooses the driver of each
  instance, and a console put on a default could be on another than the
  instance's runs, so the launch is refused the same way, and it tells the
  console it serves to refuse an unnamed driver too. A launch with no
  `--instance` is a person at a shell, and takes the platform's default.
- Every other entrypoint takes its platform's default. On macOS that is the
  direct driver with the **native runtime**: the `runsc` shim, rootfs image and
  VM of the cfc-vm store that gVisor's macOS installer writes. The store is the
  directory `CFC_VM_HOME` names, which must be an absolute path, and otherwise
  `Library/Application Support/cfc-vm` under the home. Where the store cannot
  provide the runtime the entrypoint is refused before it runs, serves, or
  launches anything.
- On every other platform that default is Docker. The native runtime is the
  macOS `runsc`, which runs in a VM only macOS has, so the platform alone
  decides this; no other platform has a default direct driver.

The store provides the runtime when it holds each of these, and the refusal
lists every one that is not there:

| In the store            | What has to be there | Not needed where                                                |
| ----------------------- | -------------------- | --------------------------------------------------------------- |
| `bin/runsc`             | an executable file   | `CF_HARNESS_RUNSC_BINARY` names one                             |
| `bin/cfc-vm`            | an executable file   | `CF_HARNESS_RUNSC_BINARY` names one                             |
| `config.json`           | a file               | never                                                           |
| `images/kitchensink`    | a directory          | a rootfs is named                                               |
| `ext4/kitchensink.ext4` | a file               | a rootfs is named                                               |
| a CFC policy            | a file, see below    | a policy is named, the empty one too, or the home policy exists |

The shim is what the driver executes, and it starts the daemon from beside
itself. The shim reads `config.json` to start the VM. The driver names
`images/kitchensink` as each container's rootfs, and the shim runs that from
`ext4/kitchensink.ext4`. A piece that cannot be examined counts as not there,
and the refusal carries the reason. A file this process cannot open to read is
refused as one that could not be read, and the shim or the daemon where this
process cannot execute it as not executable, each apart from a piece that is
missing. So does a piece that is a symbolic link, or that is reached through a
directory of the store that is one, such as `bin`, `images` or `ext4`, whatever
it leads to, and the refusal names the link and its target: the driver hands the
macOS `runsc` the rootfs and the binary by the paths their links resolve to,
while that `runsc` knows its store's pieces by their paths in the store, and
none of gVisor's installer scripts makes a link. The policy is looked at through
links, as a file anywhere would be.

The macOS default is refused for three more things, each checked before the
pieces above:

- **A setting of the Docker driver.** Each of `--sandbox-image`,
  `--sandbox-docker-runtime`, `--cfc-result-dir` and
  `--cfc-invocation-context-dir`, and each of `CF_HARNESS_SANDBOX_IMAGE`,
  `CF_HARNESS_SANDBOX_DOCKER_RUNTIME`, `CF_HARNESS_RUNSC_CFC_RESULT_DIR` and
  `CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` set to anything but white space,
  refuses the default, before the store is looked for. The refusal names every
  one given and no value. The selection does not refuse a named `runsc` for
  them, since it reads none of them, and neither does it refuse the Docker
  default of another platform. `console:launch` refuses its own two sidecar
  directory flags, `--cfc-result-dir` and `--cfc-invocation-context-dir`, under
  every direct driver, a named `runsc` included, as below.
- **A store given by another path than the one it is at.** The store's path is
  resolved through every symbolic link, as the driver resolves the rootfs it
  hands `runsc`. Where the result differs from the path as given, with `.`, `..`
  and repeated or trailing slashes removed, the default is refused, naming the
  resolved path as what to set `CFC_VM_HOME` to. The macOS `runsc` compares a
  container's rootfs, as written, with `images/` under its store as given, and
  runs one that does not match from the directory itself, which is empty. That
  is read from its source and has not been run. A path that cannot be resolved,
  a link to nothing or a loop of links among them, is refused with the reason.
- **A default CFC policy that could not be read.** A policy that is not there
  reads as absent, and so does one whose path runs through a file, such as a
  home that is not a directory, since nothing can be at such a path. A policy
  that is there is opened before it is taken, so one this process cannot read is
  refused here, by name, rather than failing inside `runsc`. Any other failure
  to look or to open refuses the default, naming the file and the failure, so
  that the store's own policy never stands in for one under the home that might
  be there. A named `runsc` is refused the same way, without the way to Docker,
  since nothing about it is a default.

Each refusal is a `HarnessControlError` with the code `invalid-request`. The
message of a refused default says that no runtime is named and the default on
macOS is the native runtime, says what is in the way, and says how Docker is
selected: by `--sandbox-runtime docker` or `CF_HARNESS_SANDBOX_RUNTIME=docker`
on the batch CLI, and by the variable alone on the entrypoints that take no
selection flag. `cf agent` runs the batch CLI with an argument list it writes
itself, so its operator can pass no flag, and it asks for the variable alone
too, from either of its lanes. `cf agent runner` derives the selection once as
it starts, through `selectCfHarnessCliSandboxRuntime()`, before either lane
serves, and exits with the refusal where each of its jobs would get it. The Loom
local host's own refusal names the flag and the variable on its batch lane and
the variable alone on its interactive lane. Through the batch lane a refusal is
a host failure carrying the message, and through the interactive lane a
chat-protocol `internal_error` carrying it.

`--sandbox-runtime`, `--sandbox-rootfs`, and `--sandbox-cfc-policy` are flags of
the batch CLI, which the batch lane of the Loom local host also hands its
arguments to. The interactive stdio entrypoint, the interactive lane of the Loom
local host, and the console take the selection from the environment alone, and
refuse each of the three flags. All five derive the selection through one
function, so runs started from one environment execute on the same driver.

The console's launcher, `console:launch`, derives the selection from the same
environment the console serves under, and refuses the three selection flags as
the console does. It takes the two sidecar directory flags, `--cfc-result-dir`
and `--cfc-invocation-context-dir`, on the Docker driver only. Under the direct
driver it reads no Docker runtime table, sites no CFC sidecar directory, and
refuses those two flags; the console's operator snapshot reports the direct
driver's configuration, `runsc` binary, and CFC policy in place of Docker's
registration, with its rootfs and whether its CFC policy reads and parses as a
JSON object. The console takes no enforcement mode, so its turns run at
`enforce-strict`; with no CFC policy the snapshot reports the runtime failed,
since the engine refuses each turn before any tool runs, and the launcher and
the server both print that every turn is refused. That is a console on a named
`runsc`: one on the native runtime macOS defaulted to has a policy or does not
start. The console's `bash` takes no `session`, as on Docker.

Both say how the driver was selected. The launcher's report has a `sandbox` row
on either driver, whose source is the variable that named it or the harness
default with its platform and, for the native runtime, its store; on the direct
driver each of the `runsc`, `rootfs` and `cfc policy` rows names the variable,
the native store, or the harness default it came from. The console's startup
banner opens its sandbox lines with the driver and the same account, its
`config.sandbox` row carries the account as its detail, and its
`sandbox.runtime` row ends its detail with it, on the direct driver once the
driver's configuration has resolved. A sidecar directory flag given to the
launcher on the direct driver is refused with the way to Docker, which is to set
`CF_HARNESS_SANDBOX_RUNTIME=docker`.

The selection belongs to a run. The direct driver registers nothing with Docker
and keeps its `runsc` state under the run's own scratch directory, so runs on
either driver coexist on one machine.

A run stays on the driver it started on. Each driver's `runsc` decides where the
CFC labels of a run's files are kept, and the two need not agree. Under Docker
Desktop on macOS they are in a directory the Docker runtime's registration
names, because Docker's file share takes no extended attribute, and the native
runtime keeps them as extended attributes of the host's files; a file one
labelled reads as unlabelled under the other. The harness does not know which
hosts agree, so on every platform:

- **A resumed run** that selects the other driver, by name or by default, is
  refused before anything runs. The driver the run started on is
  `sandboxRuntime` in its state, `docker` or `runsc`, which the engine writes as
  it is built, before it probes the sandbox, so a run whose first probe failed
  records it too. Beside it the state records how the driver was chosen when the
  run started, as `sandboxRuntimeChoice`, in the shape of the runtime
  description's `selection`, so that a run refused before its sandbox is
  described still says whether its driver was named or the default. A record
  written before runs recorded the choice takes the one of the engine that
  resumes it. The batch CLI refuses first, and an engine built to resume refuses
  whatever built it. The message names the recorded driver and how to name it:
  `--sandbox-runtime <driver>` or `CF_HARNESS_SANDBOX_RUNTIME=<driver>` from the
  batch CLI, and the variable alone from the engine, and from the batch CLI
  where its embedder's operator can pass no flag.
- **An interactive session** records the driver of the host that started it, as
  `sandboxRuntime` in its status, `docker` or `runsc`. A turn of that session on
  a host running the other is refused, saying to restart the host with
  `CF_HARNESS_SANDBOX_RUNTIME` naming the recorded driver or to start a new
  session. This covers the interactive stdio entrypoint, the interactive lane of
  the Loom local host, and the console.

Both refusals carry the code `provider-mismatch`. A record written before its
driver was recorded is read by what it holds, and bound from its next use:

- A run state with no `sandboxRuntime` is held to the `kind` of the runtime
  description in its capability snapshot, where it has one. Either way the
  engine that resumes it writes `sandboxRuntime`. A state with neither is
  resumed on whichever driver the resume selects, and is bound to that one from
  then on.
- A session with no `sandboxRuntime` is bound to the driver of the host that
  starts its next turn, in the same write that records the turn. Until then it
  is not refused, so such a session is bound to whichever driver first runs a
  turn of it, which need not be the one it started on.

A record that names a driver this build does not know, or describes a kind of
one it does not know, is refused as such with `provider-mismatch`: the resume,
or the turn, cannot be told to be on the same driver. Nothing reads an unknown
name as Docker.

The settings below describe the direct driver and are read only when it is
selected, by name or by the macOS default. A setting that is named means the
same under both; what an unnamed one falls to differs:

| Setting        | Batch CLI flag         | Environment                      | Unnamed, for a named `runsc`                                                                                                     | Unnamed, for the macOS default                                                                                       |
| -------------- | ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Rootfs         | `--sandbox-rootfs`     | `CF_HARNESS_SANDBOX_ROOTFS`      | On macOS, the kitchen-sink image in the store `CFC_VM_HOME` names, else in the one under the home. On Linux, the run is refused. | `images/kitchensink` in the store.                                                                                   |
| CFC policy     | `--sandbox-cfc-policy` | `CF_HARNESS_RUNSC_CFC_POLICY`    | `$HOME/.local/share/runsc-cfc/cfc-policy.json` where that file exists, otherwise none.                                           | That file where it exists, otherwise `policy.json` in the store where that exists, otherwise the default is refused. |
| `runsc` binary | none                   | `CF_HARNESS_RUNSC_BINARY`        | `runsc`, looked for on `PATH` when the configuration is resolved; the run is refused when no entry holds it.                     | `bin/runsc` in the store.                                                                                            |
| Network mode   | none                   | `CF_HARNESS_DOCKER_NETWORK_MODE` | `sandbox`.                                                                                                                       | `sandbox`.                                                                                                           |

The macOS default requires a policy because a run enforces CFC unless told
otherwise, and an enforcing run with none is refused as it starts. The selection
refuses a missing policy without looking at the enforcement mode, so a run on
the default without one names the policy as empty and a mode that does not
enforce, both; a non-enforcing mode alone does not get past it. The store's own
`policy.json` is what gVisor's release installer writes, so a store installed
from a release is usable with nothing else on the machine; a store built from
source holds one only where someone put it there. The file under the home is
taken first so that both drivers label the same files the same way.

The harness writes the rootfs path into the bundle as the container's root. On
Linux `runsc` is expected to find a directory there. On macOS the path is a
marker, and mapping it to a block image is the darwin `runsc`'s part. `runsc` is
passed `--cfc` exactly when a CFC policy is configured. An empty
`--sandbox-cfc-policy` means none; an empty `CF_HARNESS_RUNSC_CFC_POLICY` names
nothing, so the default applies. An enforcing run with no policy is refused as
it starts, before any command executes in the sandbox and before the first model
turn. A runtime built outside an engine has no such check in front of it, and
refuses each enforcing call instead. Under the macOS default, an empty
`--sandbox-cfc-policy` is a policy that was named, so the default is not refused
for want of one and the run starts only in a mode that does not enforce. An
empty `--sandbox-rootfs` names no rootfs, and the macOS default, which runs only
from one, is refused for it rather than taking the store's image; a named
`runsc` given one is left to its driver's own rootfs default. An empty
`CF_HARNESS_SANDBOX_ROOTFS` names nothing, so the default applies.

`--sandbox-image`, `--sandbox-docker-runtime`, `--cfc-result-dir`, and
`--cfc-invocation-context-dir` configure the Docker driver. The direct driver
reads none of them.

### Runtime description

Each driver describes itself, and the description is recorded in
`capabilities.json` under `cfc.sandbox` and in `policy-snapshot.json` under
`substrate.sandbox`. It is recorded once, when the run first starts.

| Field                                     | Docker driver                                           | Direct driver                                  |
| ----------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| `kind`                                    | `docker-runsc-cfc`                                      | `runsc-cfc`                                    |
| `sessions`                                | absent                                                  | `true`                                         |
| `cfc.runtimeRequested`                    | `true`                                                  | `true` exactly when a CFC policy is configured |
| `cfc.runtimeName`                         | the Docker runtime's name, normally `runsc-cfc`         | absent                                         |
| `cfc.image`                               | the Docker image                                        | the rootfs path                                |
| `cfc.networkMode`                         | `none`, `bridge`, or `host`                             | `none`, `sandbox`, or `host`                   |
| `cfc.extraDockerArgsCount`                | the count of extra Docker arguments                     | absent                                         |
| `cfc.invocationContextTransport`          | `sidecar`, where an invocation-context directory is set | `fd`                                           |
| `cfc.invocationContextTransportReadiness` | the registration reading, or `unverified` before one    | `intrinsic`                                    |
| `selection`                               | how an entrypoint selected the driver; see below        | the same                                       |

`selection` is not the driver's own account of itself: the engine adds it from
the selection its entrypoint derived, and a child run carries its parent's. It
holds `runtime`, `docker` or `runsc`, and `source`, which is `flag`,
`environment`, or `default`. A default also holds the `platform` whose default
applied, and the native runtime macOS defaulted to holds `nativeStore`, its
store. It is absent for an engine a caller built without a selection. The batch
CLI prints the same account on the `sandbox` line of its operator summary, as
`runsc (default on macOS: the native store at <store>)`,
`docker (default on linux: the native runtime is macOS only)`, or the runtime
followed by `(named by --sandbox-runtime)` or
`(named by CF_HARNESS_SANDBOX_RUNTIME)`.

`runsc-cfc` therefore names two different things, and the field it appears in
says which. As a `kind` it is the direct driver. As a `cfc.runtimeName` it is
the Docker-registered runtime, and the `kind` beside it is `docker-runsc-cfc`.

`sandbox` is a network mode only the direct driver reports. It is `runsc`'s own
network stack, the direct driver's default and the counterpart of Docker's
`bridge`. `CF_HARNESS_DOCKER_NETWORK_MODE` is shared by both drivers and is
written in Docker's vocabulary, which maps onto the direct driver's as follows:

| `CF_HARNESS_DOCKER_NETWORK_MODE` | Docker driver | Direct driver |
| -------------------------------- | ------------- | ------------- |
| unset                            | `bridge`      | `sandbox`     |
| `none`                           | `none`        | `none`        |
| `bridge`                         | `bridge`      | `sandbox`     |
| `host`                           | `host`        | `host`        |

A value outside that vocabulary is refused on either driver. The two differ over
white space around a value. The direct driver's selection trims it, so `bridge`
written with a space on either side selects `sandbox`. The Docker driver
compares the value as written, and refuses that one.

`--describe-capabilities` lists `--sandbox-runtime`, `--sandbox-rootfs`, and
`--sandbox-cfc-policy` among its CLI flags, which is how an adapter learns that
a build carries the direct driver. The probe does not report which driver a run
will use, and it does not establish that a `runsc` binary, a rootfs, or the
macOS VM is present.

### The `bash` descriptor and sessions

The model-facing descriptor of `bash` depends on the runtime and on the run's
CFC enforcement mode. Before each model request the prompt loop reads the
sandbox's description and the run's mode, and offers the descriptor that fits
them:

- where the description reports `sessions`, which is the direct driver, and the
  mode allows a session, which is `disabled` or `observe`, `bash` takes an
  optional `session` argument;
- otherwise `bash` takes `command`, `cwd`, and `timeoutMs` and no `session`: the
  Docker driver in every mode, and the direct driver in the enforcing modes,
  which refuse every session. `enforce-strict`, the default, is one of them, so
  a run on the direct driver is offered a `session` only where it is started at
  a weaker mode.

A session is a long-lived container. The first call that names a session starts
it, and each later call that names it executes inside it, so what a command
leaves behind is there for the next one: files outside the mounts, background
processes, installed packages. A call that names no session runs in a fresh
container of its own, as every call does under Docker.

- A session name is 1 to 32 characters drawn from letters, digits, `_`, `.`, and
  `-`, starting with a letter or a digit.
- A session belongs to the runtime that started it, and an engine builds one
  runtime for each run. Two runs that name the same session therefore never
  share a container, and neither do two sessions of one run.
- A session lasts until its run ends, which in an interactive chat is one turn.
  A resumed run starts with none. A session ends earlier when a command in it
  overruns its timeout or cannot be run; when its container exits; and when the
  harness process exits. The command that overran returns the ordinary timeout
  result, exit code 124, and takes the whole session down with it, because the
  driver holds no handle on the one process.
- A runtime holds at most eight sessions at a time.
- The harness asks for every container's `/tmp` as a `tmpfs` of at most 512 MiB,
  which is `size=512m` in the bundle, and for a rootfs overlay held in memory,
  which is `--overlay2=root:memory` on the command line. Holding a container to
  both is `runsc`'s part.

Sessions are refused in the enforcing CFC modes, `enforce-explicit` and
`enforce-strict`, because a flow-control result taken for one `exec` is not a
sound basis for enforcement. The three reasons below describe how `runsc` is
expected to compute that result and to track taint inside one container. They
are `runsc`'s behavior, and the harness refuses without observing any of them:

- the result is a snapshot taken when the executed process exits, while the
  call's output keeps draining and the session's background processes keep
  running, so labeled data can reach the output after the result was computed;
- processes in one container share its process namespace and its memory-backed
  file systems, and taint does not travel through metadata such as another
  process's environment or a directory's name, so one call can read what another
  learned;
- once a tainted write reaches a sink in the container, every later result in
  that session carries the taint.

In an enforcing mode a call without a session still runs, in a container of its
own with a result of its own. In `observe` a call in a session has a result only
where a CFC policy is configured, and that result is reported as the observation
it is.

A refusal over `session` is recoverable. The tool returns exit code 125 with
empty standard output, and the working directory is unchanged. No command has
run, except where the session ended while the call was in it: there the command
may have run in whole or in part, and its output is not kept. The first two
refusals below are the tool's own. They are made before the call's CFC
invocation context is created, so the run holds no invocation context for them.
The other five are raised by the runtime, after the call's invocation context
was recorded. Each of the seven is recorded as the call's tool output, as every
tool output is. The refusal states its reason and the next step open to the
model. Its text is the tool's own, chosen by the reason the runtime gives: the
runtime's message, which can name host paths and carry the text of an underlying
error, goes to the operator's log and is not shown to the model.

| Reason                            | What the model is told                                                                                                                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The runtime has no sessions       | To rerun the command without `session`.                                                                                                                                                                                                                   |
| The name is not a session name    | The rule for a name, and to rerun with a name that satisfies it or with none. The rejected name is not repeated.                                                                                                                                          |
| The run is in an enforcing mode   | That sessions are unavailable in that mode, and to run the command without one.                                                                                                                                                                           |
| The session was lost              | That the session ended and its state is gone, and that the command did not run. This is reported once, on the next call that names the session; naming it again starts an empty one.                                                                      |
| The session ended during the call | That the session ended while the call was in it and its state is gone, that the command may have run in whole or in part and its output was not kept, and to check what it changed before running it again. Naming the session again starts an empty one. |
| The session cap is reached        | That the run holds as many sessions as it may, and to reuse one of them or run without a session.                                                                                                                                                         |
| The session failed to start       | That it could not start, to run the command without a session, and not to retry the session in a loop. A failed start is not retained, so a later call that names it starts it again.                                                                     |

### Process lifecycle

`ProcessRunner.spawn()` starts a process and returns a `ProcessHandle` for it
instead of waiting for it to exit. The handle carries the process id, a promise
that resolves with the exit code, and `kill()`. The direct driver holds one
handle per session, for that session's attached `runsc run`. `spawn()` is
optional on a process runner, and a runner without it cannot keep a session
alive: the session fails to start and the call is refused as above.

A session's process is spawned with its standard input held. The harness keeps
the write end of that pipe open and never writes to it, and the first process it
asks for in the container is a shell loop that does nothing but read standard
input. The pipe closes when the harness process exits, however it exits, even
when the harness is killed outright, and the session's process then reads the
end of its input. Ending the session from there is `runsc`'s part: it is
expected to pass the end of input on to the container's first process, and to
take the container down when that process exits. `kill()` closes the pipe as
well.

The engine closes a runtime it built on every terminal transition — completed,
failed, canceled, and interrupted — before it writes the run's outcome. Closing
the direct driver's runtime takes down every session and every container of a
call still in flight, removes the run's scratch tree where nothing is left in
it, and leaves the runtime refusing further calls. The engine closes its runtime
once. A close that throws is logged and does not change the outcome. A runtime
handed to the engine is closed only where the caller also handed over its
ownership.

A container is taken down by deleting it and then asking `runsc` whether it is
still there, killing and deleting once more where it is. Each of those control
commands is bounded at 15 seconds, and a session has 30 seconds to report that
it is running.

Every child of a run whose engine built the direct driver's runtime is given a
runtime of its own, built from the parent's configuration. A child therefore
cannot execute in its parent's sessions, holds a session cap of its own, and
closes its own runtime when it ends. Under the Docker driver a child shares its
parent's runtime unless it mounts an acquired skill. On either driver, a child
of a run whose runtime was handed in shares that runtime, its sessions and
session cap included, and leaves it open when it ends.

### Trust

Three files decide how the direct driver's sandbox is built and labeled: the CFC
policy, the rootfs, and the `runsc` binary. Each is refused when it lies inside
a writable mount of the run, where the sandbox could rewrite it. For the native
runtime macOS defaulted to, whose three files nobody named, the refusal adds
that no runtime is named, where the store is, and that Docker is selected with
`CF_HARNESS_SANDBOX_RUNTIME=docker`. A run whose workspace is the home directory
gets it, since the default store is under the home.

Each of the three is resolved once, when the configuration is resolved, to the
path the filesystem leads to, and that path is both what is compared with the
mounts and what is used from then on: it is the command that is executed, the
`--cfc-policy` argument, the root in the bundle, and what a child run's runtime
is built from. The path is walked one name at a time, so a `..` leaves the
directory the names before it led to and not the one their spelling suggests.
The comparison ignores case on macOS. A `runsc` binary given as a bare name, the
default `runsc` included, is looked for on `PATH` in order; one given as a
relative path, or found through an empty or relative `PATH` entry, is taken
against the working directory. The policy and the rootfs have to be absolute
when they reach the driver.

A configuration is refused where any of the three opens with `~`, leads through
a symbolic link whose target is missing, leads through a name that cannot be
examined for any reason other than not existing, or has a `.` or `..` after a
name that does not exist, and where a bare binary name is found on no `PATH`
entry. A path that does not exist yet is accepted, as the real path of its
nearest existing ancestor followed by the names that are missing. A hard link
outside the mounts to a file inside one is not detected.

The scratch directory holds the bundle, the invocation context, and the result
of each call, so whoever can write there can swap a bundle or a result under the
run. It has to be out of reach of the sandbox and of every other user of the
host. The first is checked for every scratch directory: one that lies inside any
mount of the run, read-only or writable, is refused, by the same real-path
comparison.

The second is checked for the default scratch directory only. That directory is
made for the run with mode 0700, under a parent named `cf-harness-runsc` in the
temporary directory. The parent is created 0700 when it is absent. Created or
found, it has to be a real directory with no access for group or others, and it
has to belong to whoever owns what this process makes: the runtime makes an
empty entry in the parent, compares its owner with the parent's, and removes it.
Otherwise no command can run. The comparison needs no permission beyond reading
and writing, and it follows the effective user, which is the one whose files
these are. A scratch directory named by the caller is not verified, and the
Docker driver does not verify the directories it reads results from.

A parent that fails the check does not refuse the run as it starts. The runtime
makes the check once, the first time it is about to write under the scratch
directory, and keeps the outcome. Where the check failed, the runtime writes
nothing under the scratch directory, runs no `runsc` command and starts no
container, and every command it is given fails on the check's error. In a run
the first such command is the capability probe. Its failure is recorded as a
`capability_snapshot` failure record and does not stop the run, which goes on to
its first model turn. A `bash` call that names a session is then refused as a
session that failed to start, and a `bash` call that names none throws, which
ends the run. An enforcing run with no CFC policy differs: it is refused before
the capability probe.

With no container user configured the direct driver runs every command as uid 0
and gid 0, on Linux and on macOS. The Docker driver defaults to the host user on
Linux and sets no user on macOS.

A scratch directory named by the caller and a container user are options of
`resolveRunscSandboxConfig` alone, the user written as a numeric uid or uid:gid.
No flag, environment variable, or engine option carries either. A run whose
engine built the direct driver's runtime therefore uses the default scratch
directory and runs every command as uid 0.

## Supported surfaces

The current package provides:

- a console operator snapshot at `GET /api/health/detail`, retaining launch
  decisions for all connector grants and refusals alongside independently cached
  observations of the selected sandbox driver — on macOS, of the direct driver's
  VM too, holding any answer its daemon gave for the idle timeout and 30 s so
  that watching the row does not on its own keep the VM up, and asking sooner
  only where it holds none because the last question went unanswered, the
  daemon's socket has changed, or a connection between questions failed — and
  the index, with deciding records, timestamps, causes, and remedies; unknown
  observations remain distinct from failures, and reading the route never waits
  for a live probe;
- owner retraction through console `POST /api/index/retract`, signed by the
  configured identity and requiring an active same-owner direct successor; the
  generic index proxy stays read-only and standalone deletion is unsupported;
- durable Loom composition, exact inspection, and bounded receipt recovery over
  an explicitly configured host command transport; current-turn console results
  include verified authored Loom receipts and the submitted origin. See
  [Durable Loom authoring](LOOM_AUTHORING.md) for authority, custody, and retry
  contracts;
- read-only Loom retrieval — search, page discovery, inspection, and reads,
  person resolution, calendar events, ambient context, and the profile — over
  the same kind of host command transport, every row measured against the run's
  observation ceiling before it enters model context. A row loom returns without
  a label is given the query's label, an assumption the implementation profile
  publishes as a deviation. See [Read-only Loom retrieval](LOOM_RETRIEVAL.md);
- the commands a host admits, listed and run as the agent through the host's
  scoped broker, which decides what is listed and what runs; each answer is
  measured against the run's observation ceiling like a retrieval row. See
  [Host commands](LOOM_COMMANDS.md);
- batch CLI execution with bounded model turns and optional streamed events;
- machine-readable capability discovery with `--describe-capabilities`;
- refusal of any flag an entrypoint does not declare — the batch CLI and its
  control commands, the interactive stdio entrypoint, the local Loom host's
  modes over them, the console and `console:launch` — naming the flag and the
  nearest declared one, so a misspelled restriction stops a run rather than
  going unapplied; and, on the batch CLI, the interactive stdio entrypoint, the
  console and `console:launch`, of a flag given no value, which is what the
  parser leaves of a value starting with `-` written as a separate word;
- persistent provider configuration and structured config/auth control, with
  durable bounded Codex refresh health;
- workspace, Fabric, and explicit host mounts with path containment;
- sandboxed shell, file, image, web-fetch, skills, edit/write, and delegation
  tools, over the Docker driver or the direct `runsc` driver as a run names or
  its platform defaults, with named `bash` sessions on the direct driver; see
  [Sandbox runtimes](#sandbox-runtimes);
- children through `default`, `browser`, `web_fetch`, `web_search`, and
  `pattern-author` profiles, of which the ones a turn starts together run
  together, beside a bounded private `research` loop that no delegation may
  name;
- Common Fabric implementation research over the operator-provisioned docs and
  skills corpus, published pattern metadata and complete multi-file source,
  dependencies, and safe handle shapes. Fresh CLI root tasks and interactive
  sessions without retained research start with an `orient` pass before the
  first parent model turn, subject to the ordinary tool policy. Later chat turns
  reuse the findings and let the parent request targeted follow-ups. A durable
  checkpoint retains its host-supplied handoff immediately before the task and
  recovers it without another private call on resume. The handoff carries the
  research result identity, so the sibling omission record retains a proven
  `/researchRecord` join to the raw artifact while recording no location for a
  source-free error; no private record enters parent context. Delegated children
  consume the inherited findings and start no opening pass. `orient` establishes
  a useful approach from available data and composable pieces; `answer` resolves
  a follow-up question in the context of the current user goal. Both can inspect
  indexed source and return optional examples within eight model turns,
  twenty-four calls, and 96,000 read characters. Private tools return matching
  passages, paginated document outlines, and batch section reads with exact
  continuation. They cannot execute, write, browse, delegate, or mutate Fabric.
  The host verifies indexed source identities, admits citations and successfully
  described handle bindings, and returns a structured complete or incomplete kit
  with a full invocation or source recipe when one is required. Docs retain
  document titles and ancestor headings; search supports a path prefix to focus
  on the relevant guide. Section selectors and citation ids are distinct; a
  current-read catalog supports synthesis and at most one tool-free citation
  repair within the existing model-turn budget. Unread ids remain inadmissible.
  Invocation objects are host-serialized to JSON, match the shared `run_pattern`
  input contract, and select an inspected identity. Rule and example citations
  close over the kit's exact source catalog. Every metadata or source read
  respects the 32,000-character read limit; oversized metadata is refused before
  pattern admission. Complete pattern-source examples receive a host-side
  syntax-only parser check; exact parser diagnostics keep a claimed-complete kit
  incomplete while preserving its full source and citations for local
  correction. Parser success does not establish imports, types, compilation, or
  runtime behavior. Each result separately carries a CFC projection: its full
  known source label, a confidentiality-only output label for later model
  context, and explicit missing-label coverage for unclassified pattern-index
  metadata/source, unavailable handle-label metadata, or legacy research
  summaries. Documentation search accounts for unselected leads that influenced
  ranking. Publication never promotes private indexed source to public, and
  retained source integrity does not endorse a model rewrite. Opening handoff,
  resume, and delegated-child paths preserve the confidentiality influence and
  diagnostic projection. Exact handle-label acquisition returns availability
  independently of its fail-closed restriction. Model projection has one owner
  across tool, reconstructed opening, and child handoffs: free text is scrubbed,
  raw schemas stay in artifacts, and exact import identities and source/CFC
  records remain usable. The audit and omission writer share the same
  tool-or-host result provenance reader. Exact reads and the complete private
  transcript remain in the tool artifact; the caller receives the derived kit
  plus explicit incomplete-kit guidance. Partial evidence survives malformed
  output, provider failure, budget exhaustion, and cancellation, with private
  usage and failure counts included in the parent record. A private follow-up
  names one research handle and receives its findings without the recipe; the
  handle's still-held bindings count as described and its sources as cited where
  they read back with the same digest, a changed source being reported stale and
  reopened under a new id. Interactive sessions persist that context, the
  original user goal, and full CFC influence with completed history. Follow-ups
  retain that goal alongside the current request; bindings from earlier tasks
  remain historical, except those a follow-up's named handle carries in and this
  run still holds. An admitted kit is minted as a research handle; a child
  receives findings only through a research handle its brief names, with the
  entries that kit binds, and its inherited CFC context retains the full parent
  influence either way. Local authored-source artifacts record the research ids
  that shaped them. `query_docs` is accepted only as a legacy CLI or
  persisted-policy alias and is normalized without rewriting old transcript or
  run-state evidence;
- shared parent and opening-research guidance that distinguishes given inputs,
  discovery within the granted scope, and unavailable actions before asking or
  giving up. Private research identifies applicable space-search patterns for
  the parent to execute under existing targeting and release rules. The agent
  offers the closest achievable outcome, checks a send path before asking for a
  recipient, and never asks for a nonexistent release permission. Targeted
  research answers keep their focused question guidance;
- caller and profile return-schema definitions checked before child creation,
  with bounded argument errors for malformed contracts and unresolved
  references; valid child results remain schema-validated and sanitized, with
  raw evidence retained outside the ordinary parent return channel;
- image inputs and structured top-level batch results;
- a skills registry over `--skills-root`, defaulting for a run out of a labs
  checkout to that checkout's own `skills/` tree, with the resolved tree and its
  source recorded in run state and printed in operator output; skill preload by
  name, indexed reads of `SKILL.md` and supporting resources, and Deno/Bash
  skill scripts run in the sandbox where the operator allows them —
  `--allow-skill-scripts` for every skill the run holds, registry and acquired
  alike, or an exact entry for one. The same execution path takes an acquired
  skill's script, checked against the digest taken at acquisition; the tool
  output and the execution record carry that acquisition in place of the
  registry digest fields, and the invocation is labeled with confidentiality
  alone, because a non-empty `integrity` array in `cfcInputLabels` makes the
  sandbox fail to start (CT-2302);
- recoverable rejection of a malformed tool call: a name no tool answers to,
  arguments that are not a JSON object, or a `delegate_task` argument of the
  wrong shape comes back as a `cf-harness.invalid-tool-call` tool result naming
  the field and the shape expected of it — never the value it rejected — and the
  run carries on; the call is recorded as a policy decision with the outcome
  `invalid` rather than `denied` — nothing about policy refused it — plus a
  `not-run` tool activity and an `invalid_tool_call` failure record. Only what
  the model cannot correct — transport, engine invariants, artifact persistence,
  cancellation, the turn cap — ends the run. A run-owned cancellation is
  recorded as `canceled` in parent and active-child artifacts, with its reason
  and without adding a failure record;
- a release a confidentiality boundary refused is recorded as a policy decision
  with the outcome `withheld` rather than `denied`: the call ran and answered
  with the reference to the result whose values were held back, so the trace
  counts it in its own bucket, and the console renders the step as the success
  its answer states with a withheld marker beside the CFC line. `denied` names a
  call that did not run;
- transcript-based resume and durable run artifacts, with retrospective omission
  joins kept outside the transcript and provider context;
- server-side Responses context compaction with a default threshold derived from
  the model's input budget, an explicit override/disable control, retained
  compaction evidence, and tool-call/result-safe transcript pruning;
- per-turn and aggregate token/cache usage in run reports, operator output,
  batch metadata, and interactive turn-completion events;
- stable interactive prompt-cache affinity, configurable reasoning effort, and
  opt-in GPT-5.6/GPT-6.1 Sol gateway cache controls; the subscription backend
  uses implicit caching because it rejects the API `prompt_cache_options` field;
- interactive NDJSON stdio sessions with optional SQLite session, turn, event,
  replay, cancellation, and restore state; a session's durable transcript
  normally advances at a completed turn. On failure, the Loom host can retain
  the last resumable checkpoint (a validated complete batch or opening handoff),
  atomically with its matching research/CFC state and omission provenance. A
  canceled turn advances it to the turn's request and last complete batch,
  followed by a host notice that the person stopped the turn. Unpaired work and
  interrupted activity stay on the audit trail; turn-local budget notices stay
  in audit artifacts and are excluded from resumable history; a completed turn's
  history is checked before it is promoted, and promotion commits with the
  completion or not at all; and a restored session whose recorded history does
  not pair its tool calls with tool results preserves that history and adds
  explicit unknown-outcome results for missing results, while orphan results and
  duplicate call IDs refuse the session locally rather than sending malformed
  history to a provider; and a listener that cannot take an event is reported to
  the host as a delivery failure and does not change the outcome of the turn
  that produced it;
- CFC modes `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`,
  plus prompt-slot, invocation-context, policy-event, and model-influence
  evidence;
- parent-only, host-opt-in `weaver_action`, which asks the person's Weaver
  mid-turn to invoke a typed command, list its command catalog, or open a loom
  or web address, and waits for each settlement (idle timeout of five minutes
  reset by each settlement; a cancel settles the rest), settled through the
  `resolve_client_action` request or the console's `POST /api/client-actions`,
  both read by one reader and handed to the session's one client-action
  coordinator (`src/client-actions/coordinator.ts`). An executed command's JSON
  body, when retained, is held as a `document` handle with label source
  `command` if the run supplies a holder and its provenance can be derived. The
  model gets outcome metadata and a token when available. A settlement is final,
  so a catalog entry marked `startsRun` (a service command that answers once its
  work is accepted, sent only to a console serving the `starts_run` feature)
  tells the model to follow the run named in `outputs.run_id` with the service's
  `command.run-outcome` before reporting it;
- parent-only `finish_task` for a completed answer, a question, or a give-up
  reason, admitted through ordinary policy and artifacts as the sole call in a
  model turn. A completed answer satisfies the Fabric piece contract and may
  carry validated client actions (`open_loom`, `command`, `open_url`). It ends
  the loop without another provider request, retaining the completed lifecycle
  and reusable conversation. Reports carry the canonical task outcome;
  interactive `turn_completed` events, console polling and SSE carry the same
  outcome with its answer and actions, session identity, and current
  continuation availability. The live pane renders the answer, question, or
  reason. A return referent's string reaches the console's pages, in a turn's
  answer or beside a call in the live pane, only when its label fits the
  console's display ceiling: the shared default ceiling for the identity the
  console's fabric session signs as. `/api/runs/<runId>` returns the fitting
  strings as `revealed`, their sites as `sites`, and the other tokens as
  `hidden`, and its run state carries no return referents. Children report
  blockers to the parent. Missing-input discovery distinguishes released
  evidence, absence within an enumerated granted scope, and unknown reads; it
  stops for input rather than repeating author delegation. Shared
  target-selection guidance asks for an unnamed, unattached piece without a
  registry read and preserves established conversation targets. The parent
  resolves a user-supplied slug with `resolve_piece` before author delegation,
  using the input-cell path's exact-address resolver and space restriction. Only
  an opaque handle returns; source remains child-only. An unheld slug or a
  readable target that is not a usable piece returns recoverable `not-found`. A
  failed read returns `unavailable` and does not establish absence. A display
  name without a slug permits at most one registry lookup; only a unique
  released match allows work to proceed;
- a session-local address handle table: deterministic `cfh:a:` tokens minted per
  run for cell addresses, recorded in `run-state.json`, carried across resume,
  and committed with an interactive session's checkpoint so each turn's run
  starts from the table the session kept; the prompt loop swaps addresses to
  tokens in model-bound tool output and resolves tokens in model-authored tool
  arguments before policy evaluation and dispatch, `delegate_task` arguments
  excepted;
- cross-agent handles: a delegation seeds the child's own table with a verbatim
  copy of every parent address entry or non-cell referent whose token the `goal`
  or `context` names or a selected current research kit declares as an input,
  and nothing else, so a child resolves exactly the references the delegation
  handed it while the tokens stay identical across the hierarchy; a reference
  the child produces is resolved through the child's table and minted through
  the parent's boundary, reaching the parent as a parent-resolvable token, and
  any token-shaped text still standing after that resolution is scrubbed to
  fixed inert text so it cannot resolve later in the parent's own table;
- skill by handle: `delegate_task` takes an optional `skillHandle` naming a cell
  whose string value is skill text for the child, materialized trusted-side at
  child spawn under `resolveHandleValue`'s contract (table membership,
  string-only, same-space-only, structured refusal before any child exists) and
  injected as a `<skill_context source="handle:<token>">` block beside the
  profile preload; it bypasses the registry — no resource index, name-based
  selection retired for the delegated path — and the child's activation records
  `source: "skill-handle"` with the token and the digest of the injected text.
  Where the handle came from an acquisition, the context header carries its
  `pin="owner/repo/slug@<commit sha>"` for `run_skill_script`, and the child
  mounts that one skill's acquired scripts read-only at `/acquired-skill` and no
  other skill's, in a sandbox of its own built from the parent's configuration
  plus that mount. Under the Docker driver that is what separates it from the
  children that share the parent's runtime; under the direct driver every child
  has a sandbox of its own, and this one differs only by the mount;
- pattern references by trusted record: `delegate_task` takes up to eight
  optional `{ patternId, note? }` entries and resolves each id only from the
  records that run already holds — successful `search_patterns` results retained
  by that parent run and restored from its persisted transcript on resume,
  together with the patterns the task itself attached. A known id contributes a
  neutral child-context block containing the trusted record's kind and quality
  where the record carries them, its description, match evidence, import hint,
  argument shape, result shape, and the parent note verbatim; an unknown id is
  omitted and named in `patternRefRefusals` as `not-searched-by-parent`.
  Delegation does not refetch the index;
- pattern references attached to a task: a run may be configured with up to
  eight published pattern ids, which it resolves through the index's
  `getPattern` before its first model turn and seeds as searched hits, so the
  run names them with no search. The id is the whole of the reference — the
  content-addressed identity of published source — and a value outside that
  grammar is refused by the surface it arrives at, while an id the index does
  not hold fails the run, naming the id, rather than running without what the
  caller attached. The seeded record carries what the index answers for the id
  and nothing else: a reference grants what a search hit grants, which is to
  compose that source by identifier;
- shape captured where it is free and read back by token: a handle entry may
  carry the schema of its referent — a `run_pattern` result reference records
  the compiled pattern's result schema, marked `schemaSource: "harness"` — while
  no mint takes a schema off the reference it is handed or reads a cell to fill
  one in, so an entry without one is one whose shape was never free to capture
  and is answered from the fabric instead;
- a `describe_handle` tool, available in any run that has handles: given a token
  it reports the shape of the referent and its path segments, never the value —
  except for a research handle, whose findings it returns under the kit's label,
  marking each described binding the reader does not hold — and reports an
  unknown token as unknown rather than as an error. The shape is what the
  referent declares in the session's fabric when the run has one — a piece's
  document schema is the result schema of the pattern behind it, which is what
  an agent building over that piece needs — and otherwise the harness-derived
  schema the mint recorded. Whatever the source, the reported schema is rebuilt
  from an allowlist of structural keywords at every depth, so `const`, `enum`,
  `default`, `examples`, and free-text annotations never leave the tool.
  Property names do cross, since code cannot be written over data without them,
  so they are bounded in count and length and the model-facing reply is scrubbed
  of bare fabric identifiers at every depth, keys included. A referent that
  declares no schema and whose value is a SQLite database handle reports
  `database` instead: its tables, one property per table whose own properties
  are that table's columns with their types, reduced by the same allowlist, and
  one label entry per column that declares an `ifc`, addressed by table name and
  column name. Beside those it reports `fill`: per table the rows it holds, and
  per disclosed column how many of those rows are non-NULL there, so a column
  filled on no row is visible before a query filters on it and comes back empty.
  A table that could not be counted reports `unread` rather than zero, and a run
  whose storage provider offers no query reports no `fill` at all. That is the
  one place the tool reads a value, and it is conditional on nothing being
  declared — a database's tables are the contract it was created under, its rows
  are in the database file, and nothing here opens one; a count is taken of a
  whole table and of whole columns, never under a caller's own predicate.
  Disclosure admits addresses in the session's own space and foreign DIDs the
  operator lists with their host in `--fabric-foreign-spaces`; that bound is on
  the handle's own address rather than on everything the document reaches from
  it. Answering from the fabric establishes the run's fabric session despite the
  tool's `read` effect class;
- bounded request-attribution headers on OpenAI-compatible gateway traffic,
  using persisted operational provenance rather than request content or personal
  identifiers;
- content-addressed snapshots for in-run `view_image` observations, while
  run-start images remain source-integrity-locked;
- a host-side agent result writer (`writeAgentResult`, exported from the package
  root) over the same fabric session, for a caller that runs the harness on
  behalf of a pattern's agent request: it validates a run's structured result
  against its schema, writes it as one document in the session's space, and
  returns a link to it. Every handle the result names at a value position
  becomes a link, `asCell` position or not; a property name is held to the same
  ownership rule and stays text, since a name cannot hold a link — a cell handle
  to its cell, a non-cell referent the run observed (a Loom row, a SQLite row)
  to a document minted under the label the tool reported — and a handle the run
  does not hold fails the write before any document is written. Inline
  model-authored text carries the join the writing transaction derives from
  reading every observed cell and cited referent document. An uncited referent
  passes the same runtime admission in an isolated aborted transaction, then
  contributes to the result through an opaque CONTENT-observation receipt
  without becoming durable. The write is attributed to the `agent` builtin, so
  the result carries `LlmDerived`; the run's observation ceiling is declared as
  the result's store policy, so a join that does not fit is refused by the
  runner's commit boundary and surfaces as a typed `cfc_commit_refused` failure
  whose message names no label. A handle at a position whose schema declares a
  `maxConfidentiality` the referent's label exceeds is sealed rather than
  linked. The Loom retrieval tools register each admitted row in the run's
  handle table as a held referent under a `cfh:v:` token, and
  `agentObservedHandlesOfTable` hands the writer the table's cells and referents
  together ([Read-only Loom retrieval](LOOM_RETRIEVAL.md));
- opt-in fabric-session tools — `run_pattern` and `assign_slug`
  (`--fabric-api-url`, `--fabric-identity`, and `--fabric-space` configured
  together, or their `CF_HARNESS_FABRIC_*` environment fallbacks).

  `run_pattern`: compiles and runs an inline `sourceText` pattern (capped at 256
  KiB) against a deployed Fabric space from the trusted host side over a lazy
  per-run session that caches only a healthy, authorized construction; passes
  whole-string LLM-friendly link inputs as live cells, refusing links into an
  unadmitted foreign space, inputs the compiled pattern declares no argument
  for, input values that carry a sealed opaque link anywhere within them, and
  values that mismatch the compiled argument schema whether a live cell or plain
  JSON supplies them, all before any piece exists; honors the run's abort signal
  by stopping the created piece and returning a structured `cancelled` error;
  scrubs bare fabric identifiers from model-facing diagnostics; reports a result
  that settles to empty or schema-failing as an error when the invocation's
  settle window observed a cause — an action error attributed to the piece, or a
  convergence-budget episode whose deferred actions name this pattern — and
  otherwise still reports ok, since an empty result with no observed cause is
  not evidence of failure; discloses beside a successful result, as
  `outputConcerns`, declared top-level outputs of the patterns the run
  materialized — composed ones included, so a reader whose failure the composing
  source passed on nowhere is still named — that report a failure, declare a
  pending read, or hold no rows on a settled result declaring a read. Pending
  zeros and empty lists are placeholders, not data; the root's returned snapshot
  is checked even if a later observation has settled. Only a read without a
  policy refusal carries pending concerns asking to reread the same piece.
  Concerns name the output and the pattern under the identity a `cf:pattern:`
  import addresses while the failure's own text stays in the artifact. Reporting
  is best-effort wherever it cannot read: an output reached through a `$ref` or
  a combinator, a nested one, an instance the recorder's bounded buffer evicted,
  and an instance that will not read back are each passed over. `run_pattern`
  returns the result cell's canonical reference plus an optionally
  schema-sanitized value, and leaves the piece detached (no recorded origin) and
  out of the space's registered piece list, with run→piece provenance carried by
  the run's persisted artifacts. `assign_slug` names a piece afterwards, from
  any handle token referring to one: it validates the slug, fails closed on an
  availability question the space cannot answer, appends a counter to a slug
  already naming another piece and returns the name assigned in the receipt (one
  already naming the same piece answers ok), refuses a token that names a
  position inside a piece, another space, or a document with no pattern
  identity, and refuses a declared top-level pending read or an unestablished
  UI. Otherwise it registers the piece in the space's piece list and points the
  slug at it, returning the slug and, when composable without a bare fabric
  identifier, an openable URL. Successful naming records a host-only reference.
  Completed interactive turns retain those references atomically with history
  for bare follow-ups, including after restart, and remint them through the
  existing input-cell path. Explicit attachments, including an empty list, take
  precedence and clear the retained targets when that turn completes without
  naming a piece; failed turns leave them unchanged. Without the session
  configuration both tools are absent from the tool surface, for a `default`- or
  `pattern-author`-profile subagent as much as for the parent — a child shares
  the one session the parent built; `--fabric-cfc-enforcement-mode` (the
  enforcing rungs: `enforce-explicit` or `enforce-strict`) and
  `--fabric-cfc-flow-labels` (`off`/`observe`/`persist`) set the session
  runtime's CFC dials, so with labels persisted a confidentiality-tainted
  pattern write is refused at commit under strict, and
  `--fabric-cfc-posture max-enforcement` opts the session runtime into the
  runner's named posture bundle (every staged enforcement dial on, the standard
  prompt-caveat policy loaded, public-only ceilings on the network-fetch sinks),
  with the two per-dial flags applying over it — these are the fabric session's
  dials, independent of the harness's own `--cfc-enforcement-mode` up to one tie
  — under a session raised to `enforce-strict` a harness dial nobody set follows
  the session, and one stated weaker refuses startup naming both flags — and the
  resolved posture (each dial's value and whether the operator, the named
  bundle, or the default supplied it) is recorded as `fabricSessionCfc` in run
  state and the run report, and printed in the operator summary — the whole
  posture record with it, which a delegated child carries from its parent
  stamped `inherited` because it runs on that parent's session; the session
  runtime can further run under a read ceiling — the `--max-confidentiality`
  flag, or `cfc.maxConfidentiality` (with `cfc.onExceed`) in the run manifest,
  met when both are given — that bounds every `db.query` the run issues, a
  query's own declaration met with it rather than replacing it; the ceiling
  governs only query results declared per session (`PerSession<>`,
  `scope: "session"`, `.asScope("session")`, or a session-scoped db) and the
  runtime refuses any other query under it, so a pattern authored for a bounded
  run declares its results per session; it bounds the session on either
  server-execution arm (under server execution the session declares it to the
  space server, whose runtime reads under it); it is refused without a fabric
  session, recorded with its source as `readMaxConfidentiality` in
  `fabricSessionCfc`, printed in the operator summary, and inherited unchanged
  by a delegated child;
- an opt-in pattern index (`--pattern-index-url`, or its
  `CF_HARNESS_PATTERN_INDEX_URL` environment fallback), which needs the fabric
  session configuration: index requests are signed with the session identity
  under the CF1 first-party scheme, and an indexed pattern runs in the session's
  space. It adds the `search_patterns` tool, which finds published patterns by
  hashtag or free text and reports each hit's kind, evidence quality,
  description, hashtags, usage signals, declared argument and result shapes, and
  the `cf:pattern:<patternId>` import specifier that composes it. The shared
  client resolves same-owner `priorPatternId` chains from the discoverable
  catalog and places the final generation once at the earliest matching rank,
  including replacements outside the original result limit. Penalized final
  generations are withheld; branches or cycles fail the affected search.
  Exact-ID reads and existing imports keep their requested generation. Every
  nonempty search refreshes catalog membership; immutable metadata is cached per
  client. Index-supplied inherited signals retain their predecessor, publication
  cutoff, counts, and score, so a proven tier need not mean that the current
  generation has run. See
  [Pattern generations in search](../README.md#pattern-generations-in-search).
  Free-text search removes stopwords, matches whole words plus light suffix
  variants, and is disjunctive: one content term may return a hit, so extra
  terms can admit generic matches. `matchedTerms` and `queryTerms` count the
  stopword-free terms. It also extends `run_pattern`, which takes exactly one of
  `sourceText` and `patternId`: with a `patternId` the published program is
  fetched host-side and compiled down the same path, and neither its source nor
  a compile diagnostic quoting it reaches model context — the diagnostic is
  retained in the run artifact instead. The run reports `instantiated` and then
  `run_succeeded` or `run_failed` back to the index through the session's
  pattern-index ledger: each write is sent behind the one before it, no tool
  call waits for it, and the session flushes the whole chain before the process
  exits, so a reporting failure never bears on the tool result and a write is
  never cut off in flight. It adds the `record_feedback` tool, which votes a
  pattern up or down with an optional note, so the index learns which of the
  patterns it holds were worth offering. Event payloads carry the signing
  client's DID as author; a run sharing the console's key also shares its DID,
  so author attribution alone does not certify human review. And it closes the
  loop the other way: source the model authored and ran successfully with a
  non-empty `description` and a durable content-addressed identity is queued
  under that identity, carrying the `description` and `hashtags` the call named,
  the run's own task as the request the pattern answers, the compiled argument
  and result schemas, and the published patterns the source imports. The tool's
  `patternPublication.status` is `queued`: the index has not confirmed
  publication at tool return. `patternPublication.patternId` retains the exact
  identity queued by that `run_pattern` attempt. The `assign_slug` artifact's
  `pieceId` joins its slug to the attempt's piece and publication across the run
  family. Revisions publish nothing and leave that record intact; a separate
  probe records a separate piece. Saved tool results remain snapshots of what
  was known at return. The session's final ledger flush sends retained
  contributions; index refusals and other publication failures are logged
  without failing the pattern run. Automatic publication requests a record
  without search visibility; discoverability is earned from later evidence.
  Curated seeding may request immediate search visibility for a passing run by
  setting `CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE=1`, while a render-gate
  failure requests a non-discoverable record with the gate's reason. Neither
  request confirms that the index accepted the entry. A run with an empty
  description or no durable identity queues nothing.
  `--no-pattern-index-publish`, or `CF_HARNESS_PATTERN_INDEX_PUBLISH=0`, makes
  the run a reader and voter only. Without the index configuration
  `search_patterns` and `record_feedback` are absent from the tool surface, for
  a `pattern-author`-profile subagent as much as for the parent — a child
  searches through the one client the parent built — and `run_pattern` refuses a
  `patternId`;
- composition over that index: source the model authors may import a published
  pattern by the specifier a search reported,
  `import Sub from "cf:pattern:<patternId>"`, and `run_pattern` makes it
  compile. Before it compiles the source it was given, it reads the imported ids
  off it, fetches each one's program from the index host-side, and compiles it
  into the session's space, so the closure a `cf:pattern:` import resolves from
  is durable by the time the importer asks for it. Materialization recurses
  through what each fetched pattern imports and through the dependencies the
  index recorded for it, deepest first, and a pattern the space already holds is
  left alone. The same happens for a `patternId` the run names directly, so an
  indexed pattern that composes others runs. A composition is refused, with
  nothing of any fetched source in the message, if the run has no index, if the
  runtime has CFC enforcement disabled (an imported pattern resolves from the
  content-addressed source cache, which only an enforcing runtime writes and
  trusts), if the index holds no program for an imported id, if the recorded
  dependencies form a cycle, or if the graph draws in more than sixteen
  patterns. A composed pattern publishes like any other, carrying the ids it
  imports as its dependencies and stored under the identity its compile recorded
  — which is the identity the imported patterns are folded into, and not one the
  source alone determines;
- a `pattern-author` child profile that authors and runs Common Fabric pattern
  source: `run_pattern` under the same fabric-session gate, plus `read_file`,
  `bash`, and `read_skill_resource`, and no workspace writes, so its deliverable
  is a result reference rather than a file. It preloads whichever of
  `pattern-dev`, `pattern-schema`, and `pattern-ui` the run's skill registry
  carries — a run without them still gets the same child, without the guidance —
  and it is told that the references its delegation hands it are addresses to
  wire in as pattern inputs, that it owns the write/compile-error/fix loop, and
  that it returns the result reference plus an inert description rather than
  data. It is told to build in atoms — the smallest thing that does one job,
  run, then the next piece built against the reference that run produced — and
  to treat a `search_patterns` hit as a `cf:pattern:` import to wire rather than
  a specification to rebuild. It is also told to refuse source: a task asking
  for pattern source in any encoding is answered with the `unsupported-request`
  failure code, because reuse travels through the index rather than through the
  parent. This is the division of labour a data question wants: the root
  orchestrates and never pays for pattern syntax or reads the data, and the
  child computes over references it cannot read out. It runs on its own turn
  budget of 24 rather than the default subagent cap of 8, since each
  compile-error iteration costs a turn, and it carries a return contract — a
  discriminated union of
  `{ ok: true, resultRef, describes, hashtags?, verificationRef?, verification?: "not-checked" }`
  and `{ ok: false, code, detail?, verificationRef? }` — which is the profile's
  own rather than a default: a `pattern-author` delegation that declares a
  `returnSchema` of its own is refused, naming the field, because a channel this
  narrow cannot be left caller-writable. A failure and a success are different
  shapes, and only the success branch carries a piece result reference; there is
  no field on it for source under any name. The failure `code` comes from a
  fixed inert vocabulary, so a parent learns why without declassifying anything,
  and any child return saying `ok: false` reaches the parent as a coded failure
  rather than as a schema complaint.
- revision verification guidance uses `read_piece_source.inputRef` for the
  piece's bound arguments and ordinary `run_pattern` for an old/new rule check
  over one bounded sample. The child's separate `verificationRef` carries no
  values into the parent; a minimal reader preserves readiness, comparison
  counts, and pending/error fields through the existing release path. Pending
  evidence is reread once through the same reference, never interpreted as
  settled-empty data. Query failures remain failures; policy refusals are not
  retried. A released, ready comparison with zero effect or an empty sample
  calls for a question. Unavailable inspection allows a requested create or
  revision to be applied: a successful receipt returns the piece with the fixed
  `verification: "not-checked"` marker. The parent's final text states the
  inspection limitation, describes only the build or change, and points to the
  piece without claiming unseen results or asking for a nonexistent release
  permission. Styling without a computed-surface observation is explicitly
  reported as not checked. This is guidance, not a host proof of arbitrary rule
  semantics.

Run the capability probe instead of copying this list into adapters:

```bash
deno task run -- --describe-capabilities
```

## Product integrations

### Loom

Loom's batch adapter dynamically probes capabilities, constructs a run manifest,
creates a narrow temporary workspace, supplies explicit mounts and skills,
requests structured capture results, and retains reviewable run artifacts.
Autonomous wish dispatch currently routes through `cf-harness` when Loom's Page
authority prerequisites are considered available.

Local batch and interactive entrypoints use a dedicated single-user host
binding. That host takes no default sandbox driver: Loom names `docker` or
`runsc` for every run it starts there, and a run that names neither is refused
on every platform ([Selection](#selection)). It resolves the persisted provider
from a canonical `CF_HARNESS_HOME`, binds Codex credentials to the fixed local
owner, records the provider, model, authentication source, owner, and home
identity, and requires that exact snapshot on resume before any provider
traffic. Hosted multi-user integrations must supply an owner-bound credential
resolver rather than reuse this local host.

Loom also has an opt-in adapter for the interactive NDJSON protocol. It is not
the default interactive harness, and browser automation is not yet wired into
that interactive product path. The console's interactive path does browse: on a
console launched with `--allow-browser-host`, a task that declares a browser
host has its browser children drive the page that host shows the owner, under
the confinements the [browser host section](../README.md#a-browser-host)
describes. Only such a console lists `browser_host` among the client protocol
features its `GET /api/status` publishes, so a host learns before a task whether
to declare itself; the stdio transport never lists it. What a host shows, a
screenshot included, enters the model's context under the unscreened
prompt-injection caveat, sourced to the page's origin, and joined with the
labels of every value a handle sent the session; it is withheld from a run whose
read ceiling does not admit it. A child's return brings the child's
model-context label into its parent's, for every child, so the caveat reaches
the parent with whatever crosses.

Loom currently forces autonomous `cf-harness` runs to `observe` mode while
trusted `runsc-cfc` observation metadata is not wired through every local tool
path. This is a product-integration deviation, not the package default.

### Pattern Factory

Pattern Factory runs each supported phase as a separate batch invocation. The
launcher owns phase ordering, validation, bounded critic/manual-test repair
passes, and finalization; `cf-harness` owns the phase-local model/tool loop and
evidence. All default Pattern Factory phase profiles currently use CFC `observe`
mode.

## Known limitations

- End-to-end runner-owned CFC mediation is incomplete in the current product
  integrations; enforcing modes therefore cannot yet replace their `observe`
  bridges.
- The pattern index exposes no CFC labels for either result metadata or private
  indexed source. Research records each observation as missing label coverage;
  downstream enforcement can carry known confidentiality, while the coverage gap
  remains diagnostic rather than becoming a clean classification.
- Capability discovery does not prove that Docker, `runsc-cfc`, a directly
  invoked `runsc` and its rootfs, a browser lease, or another external
  dependency is healthy. Callers must perform dependency preflight for workflows
  that require them.
- Package-default sandbox networking is a provisional bridge-oriented posture on
  both drivers, `bridge` under Docker and `sandbox` under the direct driver, not
  the final destination policy model. Product adapters may narrow it.
- Sandbox sessions are unavailable in the enforcing CFC modes, because a
  session's flow-control result cannot vouch for everything that reaches a
  call's output. An enforcing run on the direct driver runs every command in a
  container of its own.
- A resumed run does not take its sandbox driver from the run it resumes. It
  uses the driver that the flags, the environment and the platform's default
  select when it resumes, and is refused where that is not the driver the run
  started on. A run started on Docker and resumed on macOS with no runtime named
  is therefore refused until `docker` is named.
- A resume keeps the runtime description recorded when the run first started, in
  `capabilities.json` and in `policy-snapshot.json`. Its `kind` is the resume's
  too. Its `selection`, its image or rootfs, its network mode and its transport
  fields are the first start's, and a resume that was selected another way, or
  that names another image, rootfs or policy, is neither refused nor recorded.
- Only a resume, and a later turn of a session, is held to a driver. Nothing
  records a driver per directory or mount: not for a workspace, a host mount, or
  the console's shared workspace. So a fresh run or session over files the other
  driver labelled does not see their labels. It reads those files as its own
  driver's `runsc` finds them, which under Docker Desktop on macOS and the
  native runtime is without the other's labels, and nothing refuses it. A run
  state written before its driver was recorded that holds no runtime description
  either, and an interactive session stored before sessions recorded a driver,
  are held to none until their next resume or turn binds them, to whichever
  driver that runs on.
- A signal that interrupts a batch CLI run closes the root run's sandbox runtime
  and not the runtimes of its children. A child's sessions still end, because
  they end with the harness process; nothing takes down a container of a child's
  call that is still in flight.
- A turn's tool calls run in the order written, and a delegation does not hold
  the calls after it, so the children one turn starts run together while its
  other calls run in turn against the session's one working directory; a
  `browser` delegation holds the calls after it, since browser children share
  one page. Across turns nothing schedules, budgets, or cancels children, and a
  child cannot delegate.
- The retained-pattern preflight returns before Fabric access or compilation
  when it refuses a `run_pattern` request, so it persists nothing. A created
  piece persists in the configured space and joins its registered piece list
  only when `assign_slug` names it. An aborted run stops its piece, but no piece
  is ever deleted, and each piece's source-history revision is a
  storage-retention root the piece list does not reveal. Tooling that enumerates
  a space's contents from the piece list must not assume the list is exhaustive;
  there is no garbage collection for these pieces yet.
- Model-driven dynamic skill activation is not implemented. Skills are
  explicitly preloaded by the caller; child skills are profile-controlled.
- Resume is transcript-oriented and does not recover an arbitrary partially
  executed tool or orchestration state machine. An interrupted turn is never
  replayed automatically: new turns retain their last provider-safe durable
  checkpoint, while restore and the next-turn boundary normalize legacy
  incomplete tool-call batches by adding an explicit unknown-outcome result for
  each missing result. This preserves legacy calls and later history without
  claiming or replaying an interrupted side effect. A tool result with no
  pending call or a duplicate call ID anywhere in the transcript fails closed
  before provider traffic because the harness cannot honestly invent or delete
  the missing history.
- Raw operator artifacts use filesystem paths. Parent-visible child returns are
  sanitized, and the prompt loop swaps model-bound tool output and
  model-authored tool arguments through the address handle table; denial-path
  tool messages are not swapped, and interactive restore does not persist the
  handle table.
- The session-local handle table covers cell addresses and three kinds of held
  referent under `cfh:v:` tokens: documents, research kits, and strings a
  child's structured return sealed. A document is a row Loom retrieval admits or
  the retained result of a Weaver command. A retrieved row's referent is
  consumed when the agent result writer links or observes the row, and
  `describe_handle` reports a command result's label but never its content. A
  research referent is read through `describe_handle`. A return referent is
  dereferenced by the `browser` tool's `urlHandle` and `valueHandle` on a
  browser host, which sends the string to the page. There is no general-purpose
  value-handle dereference or release mechanism.
- `estimatedCostUsd` is available for GPT-6.1 Sol, GPT-6 Luna, and GPT-5.6
  gateway models when the response includes cache reads and writes. It uses
  [public OpenAI pricing](https://developers.openai.com/api/docs/pricing);
  gateway markup, subscription quota accounting, and provider invoices remain
  outside the harness. `estimateWithheldReason` distinguishes missing provider
  detail, unknown models, invalid counters, subscription pricing, and incomplete
  aggregate estimates. Aggregate dollar costs are omitted unless every included
  usage record reports one, so a partial cost is never presented as the whole
  run's.

## Verification

Package behavior is covered by the unit suite:

```bash
deno task test
```

Product adapters maintain their own contract and cancellation tests; package
tests alone are not evidence that Docker, a directly invoked `runsc`, Browser
Access, or a live product instance is healthy.
