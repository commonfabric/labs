# Discover the deployed contract

Part of `skills/topics/SKILL.md`, which is the map. This is the detail on what
the running board and its Topics accept.

The running piece is authoritative. Choose discovery by what you need:

- To survey Topics, read the projected board `index` in
  `skills/topics/references/reading.md`.
- To discover a piece's readable fields and operations, use
  `deno task cf piece describe --cell "$TOPICS_BOARD" --json`. It documents
  fields; `deno task cf cell get --cell "$TOPICS_BOARD" <field>` reads their
  values.
- To choose an operation to call, list the deployed verbs:

```bash
deno task cf piece verbs --cell "$TOPICS_BOARD" --json
```

That listing includes the deployed pattern reference, callable prose, and input
and output schemas. `deno task cf piece describe --cell "$TOPICS_BOARD" --json`
returns a superset of it (the same verb rows plus name, purpose, state, and
inputs) for the same bounded discovery load. Neither command starts the piece;
`verbs` has a smaller payload when only callable operations are needed. Its
listing does not describe readable data: a board exposing only `addTopic` can
still hold an index of many Topics. Use
`deno task cf piece call --cell "$TOPICS_BOARD" <verb> --help --json` only after
choosing a verb and when its generated flags or standalone help are useful; help
is served through the dispatch path, which starts the addressed piece, so it is
the most expensive of the three. Each command is an independent cold CLI
process, so do not run all three by default.

Estuary routinely trails the checkout the CLI runs from. The gap is expected;
commit distance alone does not establish incompatibility or explain a failure.
The CLI revision, server revision, and piece's pinned pattern reference are
separate facts. `piece describe` and `piece verbs` read the contract from that
pinned pattern; the server commit does not identify the board's pattern source.
When investigating runtime compatibility, ask which commit the server serves:

```bash
curl -fsS "$CF_API_URL/api/meta" | jq -r .gitSha
```

Resolve that in the repository with `git log --oneline -1 <sha>` when comparing
server behavior against local runtime code. When comparing a verb's contract,
use the piece's pinned pattern instead.

Before calling a Topic's verb, discover that Topic's contract with `describe` or
`verbs`; use per-verb help on demand. `piece verbs` lists contract verbs by
default; `--all` additionally shows UI wrappers and deprecated verbs. The
board's published Topic rows deliberately contain no verbs: take a row's address
and call that Topic directly.

The current declared contract is:

| Piece | Verb            | Input                                           | Declared result                |
| ----- | --------------- | ----------------------------------------------- | ------------------------------ |
| Board | `addTopic`      | `title`, optional `body`, `agentName`           | created `topic`, `name`        |
| Board | `backfillNames` | `agentName`                                     | `assigned`, `named`, `pending` |
| Topic | `addComment`    | `body`, `agentName`                             | appended `comment`             |
| Topic | `addLink`       | `url`, optional `kind` and `label`, `agentName` | appended `link`                |
| Topic | `setBody`       | complete `body`, `agentName`                    | body and attribution           |
| Topic | `setTitle`      | `title`, `agentName`                            | title and attribution          |
| Topic | `mention`       | Topic reference                                 | none                           |
| Topic | `unmention`     | Topic reference                                 | none                           |
| Topic | `editComment`   | comment reference, `body`, `agentName`          | body and `editedAt`            |
| Topic | `removeComment` | comment reference, `agentName`                  | the retraction stamp           |
| Topic | `removeLink`    | link reference **or** `url`, `agentName`        | url and stamp                  |
| Topic | `recordName`    | `name`, the number the board allocated          | `name` and `wrote`             |

A retraction stamps the record rather than deleting it: the comment or link
stays, carrying what it always said, while readers stop showing it and
`commentCount` stops counting it. A retracted link also stops resolving into
`mentions`. Retracting is not a way to make something unsaid — the evidence is
retained deliberately.

`editComment` and `removeComment` name their target by REFERENCE, and a comment
is not a piece: it has no fid to write into an inline JSON event, so these are
reachable from a reader that holds the row, not from a bare
`deno task cf piece call`. `removeLink` is the exception and takes `url` for
exactly that reason, retracting the most recently added link still present with
that URL — so retracting twice retracts two rather than re-stamping one.

If a deployed field or verb differs from this skill, trust `piece describe`,
`piece verbs`, and verb help, then update this skill in the same change that
updates the deployment contract.
