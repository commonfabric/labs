# Host commands

Status: current implementation reference

## Why

A run that acts on the person's data — making a loom, writing a page — needs to
reach the operations the host offers without the harness naming any of them. The
host already describes those operations in its command manifest and serves them
from one endpoint. Two generic tools put that in front of the model:
`list_commands` shows the commands the host offers, each as a typed signature,
and `run_command` runs one or a batch of them, as the agent, with write-class
authority. Which commands those are is the host's decision alone; nothing in
cf-harness names a command.

## Host configuration

The batch CLI takes the endpoint as three flags that go together:

| Flag                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--commands-url`    | Base URL of the host's command endpoint, `http:` or `https:`, with no query or fragment.                     |
| `--commands-actor`  | The actor every command runs as, sent in each `POST` body as the host wrote it; cf-harness does not read it. |
| `--commands-run-id` | The host's id for this run, sent on every request as the `X-Loom-Agent-Run-Id` header.                       |

The host that starts the run supplies all three; neither the model's arguments
nor the process environment select any of them. Without them the command tools
are absent, including when `--allow-tool` names one: naming one without
`--commands-url` is refused at argument parsing. The agent runner passes them
from a local-job profile's `commands` entry, with the job's own id as the run
id, and for a Fabric run from `cf agent runner --commands-url` and
`--commands-actor`, with an id of the run's own.

| Tool            | Request                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `list_commands` | `GET <url>/commands`                                                       |
| `run_command`   | `POST <url>/command` with `{id, args, context?, actor}` for each call sent |

A call's `loomId` and `expectedVersion` travel in `context` as `loom_id` and
`expected_version`, and `context` is left out when the call names neither. The
host answers with its manifest and with each command's result unchanged. The
host decides what a run may list and run: it filters its listing for the caller,
each command's `actors`, `origins_required`, and `origins_refused` apply to this
caller as to any other, and the run-id header marks the call as an agent's
session. cf-harness filters nothing itself.

The host may also name the commands relevant to a run: `--commands-relevant`,
repeatable, or `relevant` in a local-job profile's `commands` entry. A hint
only, it neither adds a command to the listing nor takes one away:
`list_commands` shows those commands first and marks them `relevant: true`, so a
listing past the model bound keeps them whole.

`list_commands` and the first `run_command` of a run read the listing. Each call
`run_command` sends to the host, a lone call or one call of a batch, is one
`POST`; a call refused before it is sent sends nothing.

## The run's catalog

The tools read one catalog, held for the run: the host's listing is read the
first time a tool needs it and kept for the rest of the run, so a run that calls
many commands lists once. An explicit `list_commands` reads the host afresh and
holds what it read. A read that fails is not held; the next call asks the host
again.

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
      "description": "…",
      "relevant": true
    }
  ]
}
```

Each entry's `signature` is one line read from the command's argument schema
(`src/loom-command-signature.ts`):

- the parameters, required ones first and without `?`, optional ones with `?`,
  each group in the schema's order; a default follows `=`; a required input the
  host fills from the call's context (`x-source` in the manifest row) reads as
  optional, since a call may leave it out;
- an enum reads `a|b|c`, a member that is empty or holds whitespace, `|`, a
  quote, a backslash, or a control character quoted and escaped as JSON; an
  array reads `T[]`, an object with declared properties `{...}` and one without
  `object`, a `$ref` the name it ends in, and a position nothing can satisfy
  (`false`, or an empty `enum`, `anyOf`, or `oneOf`) `never`; `(...)` is a
  schema that leaves its arguments open;
- `-> {a, b}` names the fields the command's answer declares among its
  `outputs`, and is left out when it declares none;
- the bracket holds the command's effect where the host declares one, then its
  target: the `scope` the host declares for it, as the host writes it (`global`
  where it declares none). A command whose target is `loom` takes a `loomId`;
  `run_command` passes the one a call names and infers none from the target.

A line is cut to 400 characters, its trailing parameters replaced by `…`. A
command named in `detail` also carries its `inputSchema`: the host's schema with
its `x-*` extension keywords removed, which every schema the model sees is, or
`true`, open, where the host's is not an object or is larger than 16 KiB once
those keywords are removed. A listing larger than the model bound keeps its
first entries whole and the rest without description; a command named in
`detail` is always kept whole. Every row the host lists is kept, however many;
`omitted` counts rows that could not be read as a command, and `compacted` the
entries shown without description.

The listing's `notice` says to assume a command with an absent or unknown effect
may change the person's data.

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
catalog does not show is refused, so what a run can call is what it can see. The
host's command layer checks each call's `args` against the command's schema, and
refuses a command the host has withdrawn since the catalog was read.

A batch's calls run concurrently, at most four in flight to the host at once,
and one call's failure does not stop the others.

### A call's result

Each call, alone or in a batch, comes back as one of:

- `executed`: the command layer answered. `outcome` holds `ok`, `id`, `code`,
  `mayHaveLanded`, `completed`, and `bodyBytes`, each text cut to an
  identifier's length and `completed` to its first 32 operation ids, so the
  summary stays small beside the answer's measured `entry`. A refusal by the
  host (`forbidden`) or by the command layer (`refused`) reads as
  `code: "not_granted"`, with the host's code beside it as `hostCode` and a
  `hint` telling the model to offer the command to the person in its result
  rather than retry it. An answer the command layer refused as `bad-args` — the
  args do not match the command's schema — carries the command's `signature`,
  the line `list_commands` showed, so the model can correct the call.
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
  "results": [
    { "status": "executed", "…": "…" },
    { "status": "unknown_command" }
  ],
  "truncated": false
}
```

`results` holds one result per call, in the calls' order, each in the shape the
call alone would have returned, with its own `outputId`, minted in the calls'
order. Three things differ from sending the calls one at a time. An executed
call's summary is compact: `completed` is replaced by its count,
`outcome.completedOmitted`, and `hint` is left out; the `signature` a `bad-args`
refusal carries is kept. The summaries are charged against one output bound for
the whole batch at their serialized size, in the calls' order, each beside the
smallest form of every call after it; one that does not fit drops its
`signature`, and then keeps only the outcome's `ok`, `code`, and `bodyBytes`,
marked `summaryOmitted: true`, so later calls shrink first. The answers are
measured in the calls' order against what the summaries leave: an answer that
would have fit alone can be left out of its result, which is then marked
truncated, and `truncated` says whether any was. And an answer without a label
of its own takes the label of the batch's input as a whole, which covers every
call's arguments: for a call whose own arguments carried less, that is the
conservative choice.

### Authorization

The tool's effect class is `write` for every call, a batch included, even when
the host declares the command a read. Policy judges a tool call, so a batch is
authorized or refused whole, as one write. Policy treats it as any other write:
under `enforce-explicit` and `enforce-strict` a call runs only when the run's
task is bound as a `direct-command` prompt slot, so a task that arrived as
`context` — a request a pattern submitted through the `agent` built-in, say —
can list commands but cannot invoke this tool.

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
