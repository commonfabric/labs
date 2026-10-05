# Host commands

Status: current implementation reference

## Why

A run that acts on the person's data — making a loom, writing a page — needs to
reach the operations the host offers without the harness naming any of them. The
host already describes those operations in its command manifest and already
narrows them per run with a broker. Two generic tools put that in front of the
model: `list_commands` shows the commands the host lets this run run, and
`run_command` runs one, as the agent. Which commands those are is the host's
decision alone; nothing in cf-harness names a command.

## Host configuration

The batch CLI accepts `--loom-commands-config /absolute/host-config.json` or
`CF_HARNESS_LOOM_COMMANDS_CONFIG`. The file is supplied by the operator, read on
the host, and never passed into the sandbox. Without it both tools are absent,
including when `--allow-tool` names one: naming one without the configuration is
refused at argument parsing.

```json
{
  "cliPath": "/opt/loom/src/bin/loom",
  "transport": {
    "kind": "broker",
    "queuePath": "/private/loom/agent-runner/broker"
  }
}
```

Only the broker transport is accepted. The broker is what makes the grant mean
something: it lists only the commands its scope admits, refuses every other
command it is asked to run, and replaces whatever actor a request names with the
`agent:` actor and run it was started for. A direct transport would leave the
attribution to the configuration, so it is refused when the file is read.

Each call runs the host's CLI over a cleared environment with
`LOOM_PAGE_RPC_QUEUE` set to the queue, the same way the
[authoring tools](LOOM_AUTHORING.md) and the
[retrieval tools](LOOM_RETRIEVAL.md) reach the host:

| Tool            | Host command                                                     |
| --------------- | ---------------------------------------------------------------- |
| `list_commands` | `loom command list --json`                                       |
| `run_command`   | `loom command run <id> --args-json - --json [--loom] [--expect]` |

## `list_commands`

Returns the commands the broker listed, each as a callable descriptor
(`src/contracts/callable.ts`): `name`, `title`, `description`, `inputSchema`,
and `effect` where the host declares one, plus the command's `target` (`global`,
or `loom` for one that takes a `loomId`) and the field names its answer declares
among its `outputs`. A catalog larger than the model bound keeps its first
entries whole and the rest without schema and description; `detail` names up to
sixteen commands to keep whole.

A manifest row is left out, and counted as `hidden`, when its own declarations
say an agent may not run it:

- `origin: "pattern"` — a piece's verb, which an agent reaches through the piece
  it holds;
- `developer: true`;
- `actors` naming people only;
- `origins_refused` holding `session`, or `origins_required` not holding it — a
  broker-stamped run reaches the command layer with origin `session`;
- a `grant` — the command runs only over a person's consent grant.

The filter is presentation. The broker's scope is what decides; a row the host
declares nothing about is shown.

The host's manifest declares no effect today, so entries normally carry none.
The listing's `notice` says to assume such a command may change the person's
data.

## `run_command`

Takes `command`, `args`, an optional `loomId`, and an optional
`expectedVersion`. The arguments are bounded at 16 KiB of JSON before anything
is sent. The host's listing is read before each command, and a command it does
not show is refused before it reaches the host, so what a run can call is what
it can see — a command the host withdrew mid-run included. That read is one more
host call per command.

Its answer has three shapes:

- `executed`: the command layer answered. `outcome` holds `ok`, `id`, `code`,
  `mayHaveLanded`, `completed`, and `bodyBytes`. A refusal by the broker
  (`forbidden`) or by the command layer (`refused`) reads as
  `code: "not_granted"`, with the host's code beside it as `hostCode` and a
  `hint` telling the model to offer the command to the person in its result
  rather than retry it.
- `failed_to_deliver` with `landed: "no"`: nothing was sent — no configuration,
  malformed input, a cancelled turn, an unreadable listing, or a command the
  listing does not show.
- `failed_to_deliver` with `landed: "unknown"`: the answer was lost after the
  command was sent, and the command may have taken effect.

The tool's effect class is `write` for every call, because the host does not say
which commands only read.

## The answer is Loom data

The command's whole answer is measured the way a [retrieval](LOOM_RETRIEVAL.md)
row is, as one row and through the same function: its own `ifc` label where it
carries one, else the query's label (`labelForUnlabeledLoomRow`, published as
deviation 10 in the [implementation profile](IMPLEMENTATION_PROFILE.md)),
measured against the run's observation ceiling.

- An admitted answer is shown to the model as the `entry`, its strings bounded,
  and held as a `document` referent with label source `command` and provenance
  naming the command, the agent actor, the loom, and the version the outputs
  report. A structured result that names the handle links a document minted from
  it.
- A withheld answer shows nothing of itself; the `outcome` summary is all the
  model reads.
- An answer that alone passes the output bound is left out and the result is
  marked truncated.

The admitted answer's label is recorded as the run's model-context observation
over the output channel; the label itself stays on the artifact.
