# Host commands

Status: current implementation reference

## Why

A run that acts on the person's data — making a loom, writing a page — needs to
reach the operations the host offers without the harness naming any of them. The
host already describes those operations in its command manifest and serves them
from one endpoint. Two generic tools put that in front of the model:
`list_commands` shows the commands the host offers, each as a typed signature,
and `run_command` runs one or a batch of them, as the agent, using the
host-declared effect. Which commands those are is the host's decision alone;
nothing in cf-harness names a command.

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

| Tool            | Request                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `list_commands` | `GET <url>/commands`                                                                    |
| `run_command`   | `POST <url>/command` with `{id, args, context?, actor, reads: true}` for each call sent |

A call's `loomId` and `expectedVersion` travel in `context` as `loom_id` and
`expected_version`, and `context` is left out when the call names neither.
`reads: true` asks the host to say what each answer read of the person's data
(see [Declared reads](#declared-reads)). The host answers with its manifest and
with each command's result unchanged. The host decides what a run may list and
run: it filters its listing for the caller, each command's `actors`,
`origins_required`, and `origins_refused` apply to this caller as to any other,
and the run-id header marks the call as an agent's session. cf-harness applies
no additional command-selection filter to the host's catalog. The run's tool
grants and CFC policy still apply.

The host may also name the commands relevant to a run: `--commands-relevant`,
repeatable, or `relevant` in a local-job profile's `commands` entry. A hint
only, it neither adds a command to the listing nor takes one away:
`list_commands` shows those commands first and marks them `relevant: true`.
Relevance does not add detail: only commands named in `detail` carry their
description and input schema.

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
command named in `detail` also carries its description and `inputSchema`: the
host's schema with its `x-*` extension keywords removed, which every schema the
model sees is, or `true`, open, where the host's is not an object or is larger
than 16 KiB once those keywords are removed. Descriptions and schemas are absent
for commands not named in `detail`. Every row the host lists is kept, however
many; `omitted` counts rows that could not be read as a command.

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
`calls` is refused. Each call's arguments are bounded at 2 MiB of serialized
UTF-8 JSON. The host decides admission, including for names absent from the
catalog, and checks each call's arguments against its schema.

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
    { "status": "executed", "outcome": { "ok": false, "code": "not_granted" } }
  ],
  "truncated": false
}
```

`results` holds one result per call, in the calls' order, each in the shape the
call alone would have returned, with its own `outputId`, minted in the calls'
order. Three things differ from sending the calls one at a time. An executed
call's summary is compact: `completed` is replaced by its count,
`outcome.completedOmitted`; the refusal `hint` and the `signature` a `bad-args`
refusal carries are kept. The summaries are charged against one output bound for
the whole batch at their serialized size, in the calls' order, each beside the
smallest form of every call after it; one that does not fit drops its
`signature`, and then keeps only the outcome's `ok`, `code`, and `bodyBytes`,
marked `summaryOmitted: true`, so later calls shrink first. The answers are
measured smallest-first by body size against what the summaries leave: an answer
that would have fit alone can be left out of its result, which is then marked
truncated, with a `hint` explaining that no requested values are shown and
asking for a smaller range, fewer results, or a smaller batch. An existing
refusal hint takes precedence over this omission guidance. The batch `truncated`
says whether any result was cut. And an answer without a label of its own takes
the label of the batch's input as a whole, which covers every call's arguments:
for a call whose own arguments carried less, that is the conservative choice.

### Authorization

The host's `read` effect is a read, `external` is a side effect, and a write,
missing or unknown effect is a write. A batch uses its most consequential
effect. Under `enforce-explicit`, declared reads may run from context or unbound
prompt slots; every other effect requires a `direct-command` binding. Under
`enforce-strict`, every call requires that binding, including reads.

## The answer is Loom data

The command's whole answer is measured the way a [retrieval](LOOM_RETRIEVAL.md)
row is, as one row and through the same function, against the run's observation
ceiling. An answer that declares its reads is labeled by them (below). One that
does not, because its command has not declared yet, is labeled by its own `ifc`
label where it carries one, else by the query's label
(`labelForUnlabeledLoomRow`, published as deviation 10 in the
[implementation profile](IMPLEMENTATION_PROFILE.md)).

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

### Declared reads

The host answers a request that asks with `reads: true` with a `reads` list
beside the answer: one entry per row of the person's data the answer shows,
`{ref, revision, coverage, ifc, author?, title?, at?}`. `ref` names the source,
`revision` the revision it was read at (`null` for a source with none, with
`coverage.revisionScope: "none"`), `coverage` how much of it was read (its
`kind` is `query`, `search-snippet` or `body`), and `ifc` the row's own label. A
command that shows nothing of the person's stores beyond its arguments answers
`reads: []`. A command that has not declared what it reads answers with no
`reads` key, which says nothing about what it read.

- `run_command` takes `reads` out of the answer before anything else reads it:
  the model is shown the answer without it, the outcome's `bodyBytes` is the
  size of the answer without it, and it does not count against the output bound.
  Nothing a model sees changes for an answer that declares no reads.
- An answer with `reads` is labeled with the confidentiality of its call's
  arguments and of every read's `ifc` together, joined with its own top-level
  `ifc` where it carries one, and with no integrity: it combines rows with the
  arguments the model wrote, and CFC §3.1.6.2 keeps of a combination only the
  hereditary integrity every input carries. Its entry's `labelSource` is `row`,
  or `query` for `reads: []`, which takes the arguments' label alone.
- A `reads` that is not a list of reads, each with a reference, a revision or
  `null`, a coverage naming its kind, and a readable label, withholds the answer
  (`cfc_label_read_failed`), as an unreadable `ifc` does.
- The reads of an admitted answer are recorded, as declared and in order, on the
  run's model-context observation (`reads`), whatever the answer's label: an
  answer that is public and declares a read leaves an observation. An answer
  that is withheld or left out records none, since the model saw none of it. A
  batch's observation carries its answers' reads in the calls' order.
- One observation records at most 512 reads. An answer whose reads would take
  its observation past that is left out of the result, with the omission hint,
  like an answer past the output bound, so the model is never shown a read the
  record leaves out. A batch shares the bound across its answers, in the order
  their bodies are measured.
- A host refusal with code `unlabelled-read` is an executed result: the host
  would not send what the command read because a row came from a store that
  carries no label, and the answer names those stores under `stores`. The result
  carries a `hint` telling the model not to retry and to read through another
  command or name the stores in its result.

The run's report carries the observations that declare reads, with their
sequence, tool call, output, label and reads
([agent runner](../../agent-runner/src/agent-runner.ts), `AgentRunReport.reads`;
`harnessCfcModelContextReads` in `src/contracts/cfc-model-context.ts`). Once
every command a host grants a run declares its reads, an answer with no `reads`
key is to be refused, naming the command, and `labelForUnlabeledLoomRow`
deleted; the place is marked in `src/tools/loom-commands.ts`.
