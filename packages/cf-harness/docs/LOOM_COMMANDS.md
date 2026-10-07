# Host commands

Status: current implementation reference

## Why

A run that acts on the person's data — making a loom, writing a page — needs to
reach the operations the host offers without the harness naming any of them. The
host already describes those operations in its command manifest and already
narrows them per run with a broker. Two generic tools put that in front of the
model: `list_commands` shows the commands the host lets this run run, each as a
typed signature, and `run_command` runs one or a batch of them, as the agent.
Which commands those are is the host's decision alone; nothing in cf-harness
names a command.

## Host configuration

The batch CLI accepts `--loom-commands-config /absolute/host-config.json` or
`CF_HARNESS_LOOM_COMMANDS_CONFIG`. The file is supplied by the operator, read on
the host, and never passed into the sandbox. Without it both tools are absent,
including when `--allow-tool` names one: naming one without the configuration is
refused at argument parsing.

```json
{
  "cliPath": "/opt/loom/src/bin/loom",
  "jobIdEnvVar": "LOOM_COMMAND_JOB_ID",
  "transport": {
    "kind": "broker",
    "queuePath": "/private/loom/run/command-queue"
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

The optional `jobIdEnvVar` names the variable that carries the current host job
id. The embedder supplies that id through
`RunCfHarnessCliDependencies.commandJobId`, independently for each invocation; a
`jobId` in the configuration file is ignored. Both discovery and execution
receive the id in their cleared host environment when the variable and id are
present. Without a supplied id the variable is omitted; the broker decides
whether such a request is valid. The variable name must use uppercase letters,
digits, and underscores, starting with a letter or underscore, and cannot
replace `PATH` or `LOOM_PAGE_RPC_QUEUE`. Neither the model's arguments nor
ambient process environment select the id.

| Tool            | Host command                                                     |
| --------------- | ---------------------------------------------------------------- |
| `list_commands` | `loom command list --json`                                       |
| `run_command`   | `loom command run <id> --args-json - --json [--loom] [--expect]` |

`list_commands`, and the first `run_command` of a run, read the listing;
`run_command` runs the CLI once for each call it sends.

## The run's catalog

Both tools read one catalog, held for the run: the host's listing is read the
first time either tool needs it and kept for the rest of the run, so a run that
calls many commands lists once. An explicit `list_commands` reads the host
afresh and holds what it read. A read that fails is not held; the next call asks
the host again.

## `list_commands`

Takes an optional `detail`, naming up to sixteen commands. Returns:

```json
{
  "outputId": "…",
  "status": "ok",
  "notice": "A command's effect is shown only where the host declares it; …",
  "entries": [
    {
      "name": "people-discovery.dossier",
      "signature": "people-discovery.dossier(entity_id: string, limit?: integer = 50) -> {messages, records}  [read, global]",
      "title": "Gather what is known about a person.",
      "description": "…"
    }
  ],
  "hidden": 1
}
```

Each entry's `signature` is one line read from the command's argument schema
(`src/loom-command-signature.ts`):

- the parameters, required ones first and without `?`, optional ones with `?`,
  each group in the schema's order; a default follows `=`;
- an enum reads `a|b|c`, an array `T[]`, an object with declared properties
  `{...}` and one without `object`, a `$ref` the name it ends in; `(...)` is a
  schema that leaves its arguments open;
- `-> {a, b}` names the fields the command's answer declares among its
  `outputs`, and is left out when it declares none;
- the bracket holds the command's effect where the host declares one, then its
  target: `global`, or `loom` for one that takes a `loomId`.

A line is cut to 400 characters, its trailing parameters replaced by `…`. A
command named in `detail` also carries its full `inputSchema`. Every schema the
model sees, and every schema a call is checked against, has its `x-*` extension
keywords removed. A listing larger than the model bound keeps its first entries
whole and the rest without description; a command named in `detail` is always
kept whole. `omitted` counts rows that could not be read or fell past the
catalog limit, and `compacted` the entries shown without description.

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

Takes one call:

```json
{
  "command": "people-discovery.dossier",
  "args": { "entity_id": "e-1" },
  "loomId": "loom-0123456789abcdef",
  "expectedVersion": 3
}
```

or a batch of independent calls, each of the same shape:

```json
{ "calls": [{ "command": "…", "args": {} }, { "command": "…", "args": {} }] }
```

A batch carries one to sixteen calls, and one that names `command` as well as
`calls` is refused. Each call's arguments are bounded at 16 KiB of JSON. Before
anything is sent, each call is checked against the run's catalog: a command the
catalog does not show is refused, so what a run can call is what it can see, and
the call's `args` are validated against the command's `inputSchema` with the
runtime's JSON Schema validator. The check reads the schema as the host's
command layer does, so it refuses no call the host would run:

- an optional input passed as `null` is read as left out, and the host gives it
  its default; a required input passed as `null` is checked as given;
- `oneOf` accepts a value any of its branches accepts;
- a required input the host fills from the call's context — one marked
  `x-source` in the manifest row — may be left out, though the schema the model
  sees still lists it as required.

A schema that validator cannot itself read is left to the host's command layer,
which validates every call it is sent. The broker refuses a command the host has
withdrawn since the catalog was read.

A batch's calls run concurrently, at most four in flight to the host at once,
and one call's failure does not stop the others.

### A call's result

Each call, alone or in a batch, comes back as one of:

- `executed`: the command layer answered. `outcome` holds `ok`, `id`, `code`,
  `mayHaveLanded`, `completed`, and `bodyBytes`, each text cut to an
  identifier's length and `completed` to its first 32 operation ids, so the
  summary stays small beside the answer's measured `entry`. A refusal by the
  broker (`forbidden`) or by the command layer (`refused`) reads as
  `code: "not_granted"`, with the host's code beside it as `hostCode` and a
  `hint` telling the model to offer the command to the person in its result
  rather than retry it. An answer the command layer refused as `bad-args`
  carries the command's `signature`.
- `invalid_args`: the args do not match the command's schema, and nothing was
  sent:

  ```json
  {
    "outputId": "…",
    "status": "invalid_args",
    "command": "people-discovery.dossier",
    "path": "args.limit",
    "expected": "integer",
    "given": "\"ten\"",
    "problem": "value does not match type integer",
    "signature": "people-discovery.dossier(entity_id: string, limit?: integer = 50) -> {messages, records}  [read, global]"
  }
  ```

  `given` is `absent` for a required field the call left out, and `expected` is
  `no such parameter` for a field a closed schema does not declare.
- `unknown_command`: the catalog shows no command by that name, and nothing was
  sent. `suggestions` names up to three listed commands nearest the one called —
  names containing it first, then by edit distance — and `hint` points the model
  back to `list_commands`.
- `failed_to_deliver` with `landed: "no"`: nothing was sent — `not_configured`,
  `invalid_input` (a malformed call), `batch_too_large` (more than sixteen
  calls), `cancelled`, or the catalog could not be read (`command_failed`,
  `malformed_payload`). In a batch, a malformed call, and a call reached after
  the turn was cancelled, come back as that call's result; the rest stop the
  whole tool call and come back in place of the batch.
- `failed_to_deliver` with `landed: "unknown"`: the answer was lost after the
  command was sent, and the command may have taken effect.

### A batch's result

```json
{
  "outputId": "…",
  "status": "batch",
  "results": [{ "status": "executed", "…": "…" }, { "status": "invalid_args" }],
  "truncated": false
}
```

`results` holds one result per call, in the calls' order, each in the shape the
call alone would have returned, with its own `outputId`, minted in the calls'
order. Two things differ from sending the calls one at a time. The answers are
measured in order against one output bound for the whole batch, so a batch shows
the model no more than one call may: an answer that would have fit alone can be
left out of its result, which is then marked truncated, and `truncated` says
whether any was. And an answer without a label of its own takes the label of the
batch's input as a whole, which covers every call's arguments: for a call whose
own arguments carried less, that is the conservative choice.

### Authorization

The tool's effect class is `write` for every call, a batch included, because the
host does not say which commands only read. Policy judges a tool call, so a
batch is authorized or refused whole, as one write. Policy treats it as any
other write: under `enforce-explicit` and `enforce-strict` a call runs only when
the run's task is bound as a `direct-command` prompt slot, so a task that
arrived as `context` — a request a pattern submitted, say — can list commands
but not run one, a read command included.

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
- A withheld answer shows none of its content: the model reads the `outcome`
  summary and the entry's `status` and `reasonCode`.
- An answer that alone passes the output bound is left out and the result is
  marked truncated.

The admitted answer's label is recorded as the run's model-context observation
over the output channel; the label itself stays on the artifact. A batch records
one observation, the join of its admitted answers' labels.
