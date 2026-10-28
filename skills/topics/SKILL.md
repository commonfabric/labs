---
name: topics
description: Search, read, file, and update Topics on the Common Fabric team's
  Topics board on Estuary with `deno task -q topics`. Use when looking for a Topic,
  reading one, filing one, posting a progress comment, replacing a body,
  attaching pull request links, or adding references between Topics.
---

# Topics on Estuary

Topics is the team's minimal issue tracker: a board piece on Estuary holding one
Topic piece per issue, each a title, a body, a comment thread, and links.
`deno task -q topics`, the client in `packages/patterns/topics/tools/`, reads
and writes it with one command per operation. This file is the map. That
directory's `README.md` says how the client keeps its local copy and how a write
is recovered; the pattern's canonical semantics are
`packages/patterns/topics/README.md`.

## Where, and as whom

Run `deno task -q topics …` from inside a Labs checkout: `-q` keeps `deno` from
printing the task's command line before the output. `--help` lists every command
and option. The board, its space, and the deployment are built in;
`TOPICS_API_URL`, `TOPICS_SPACE`, and `TOPICS_BOARD` name another board.

The identity is `CF_IDENTITY`, defaulting to
`~/.config/commonfabric/identity.key`: the team's per-user key, the same one
your human user holds. When the client reports the keyfile missing or
unreadable, stop and ask the human to provision it or export the correct path.
Do not search for keys, mint an agent key, use another human's key, or use the
publicly derivable `implicit trust` identity, and never print or inspect key
material.

| To                            | Run                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| find Topics                   | `deno task -q topics search <term>...`                                                 |
| list recent activity          | `deno task -q topics search`                                                           |
| search titles only            | `deno task -q topics search --in title <term>...`                                      |
| skip settled Topics           | `deno task -q topics search --exclude '^\[RESOLVED' --exclude '^\[OBSOLETE' <term>...` |
| read Topics                   | `deno task -q topics show top/42 top/7`                                                |
| read the end of a long thread | `deno task -q topics show top/167 --last 10`                                           |
| file a Topic                  | `deno task -q topics new --agent-name <name> '<title>' < body.md`                      |
| post an update                | `deno task -q topics comment --agent-name <name> top/42 < update.md`                   |
| replace the body              | `deno task -q topics body --agent-name <name> top/42 < body.md`                        |
| rename                        | `deno task -q topics title --agent-name <name> top/42 '<title>'`                       |
| link a pull request           | `deno task -q topics link --agent-name <name> top/42 <url> --kind pr`                  |
| reference another Topic       | `deno task -q topics mention top/42 top/7`                                             |

A search term is a case-insensitive regular expression; a Topic matches when
every term matches its title, body, a comment, a link, or an author's name, or
one of those that `--in` names. `--json` on `search` and `show` prints the same
as JSON for a program to read. Each Topic listed shows when it was last active:
its age within the last day (`12m ago`, `5h ago`), and otherwise the day in the
local time zone. Text holding Markdown, backticks, or quotes goes on stdin
through a quoted here-document (`<<'EOF'`), which the shell leaves unexpanded.

`deno task -q topics watch` shows the board live on the whole terminal, for a
person to watch; it takes over the terminal until a key quits it, so do not run
it as an agent.

## What holds throughout

- Commands read through a local copy of the board, brought up to date first by
  asking the server only for documents whose revision moved: a few seconds when
  nothing changed, and about fifteen the first time on a machine. `new` brings
  it up to date once the Topic is filed, and `watch` opens on the copy as it
  stands and then follows the board. `--offline` reads the copy as it stands,
  and `deno task -q topics sync` refreshes it alone and prints where it is kept
  (`--rebuild` reads the whole board again). A read runs no pattern and commits
  nothing, so a search is cheap enough to run directly rather than through a
  subagent.
- Do not survey the board with `cf cell get` on its `index`. That runs the board
  in the CLI's runtime and writes one commit per Topic every time, which is the
  cost the client exists to avoid.
- A Topic's number is the board's name for it. Cite it as `top/42`; the commands
  take `42`, `#42`, `top/42`, or the Topic's address.
- An authored-content write carries `--agent-name` (or `CF_AGENT_NAME`): one
  stable agent name, and no second signature in titles, bodies, labels, or
  comments. Fabric retains the human principal behind the key; Topics stores the
  agent name as content attribution. `mention` and `unmention`, which record and
  remove a reference, take none.
- A write runs the Topic it wrote to once it settles, so that the comment count
  and last activity the board lists are stored, and is then checked by reading
  it back. Each run is a new write, and prints its invocation id before it
  dispatches. When a write fails saying it may have committed, or its answer is
  lost, run the same command with `--invocation <id>`, which settles on the
  first outcome rather than writing twice. Running it again without the id is
  how one update becomes two.
- Recommended, not required: the body states the core issue for a first-time
  reader and is replaced whole, with any critical update also noted at its top;
  the thread holds point-in-time updates; links hold the resources the body or
  thread uses, every relevant pull request among them with `--kind pr`;
  relationships between Topics are `mention` references, never pasted addresses.

## Beyond `deno task -q topics`

The verbs the client does not wrap — editing or retracting a comment, removing a
link, numbering — are called with `cf piece call`, from the same checkout, in
the same invocation as these settings, since shell state rarely survives between
an agent's tool calls:

```bash
export CF_API_URL='https://estuary.saga-castor.ts.net'
export CF_SPACE='topics-dev-476ea34f'
export TOPICS_BOARD='/of:fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34'
export CF_IDENTITY="${CF_IDENTITY:-$HOME/.config/commonfabric/identity.key}"
```

There, the running piece is authoritative. Estuary routinely trails the
checkout, so discover a piece's contract before calling a verb on it, and read
back what a call wrote.

| Read                            | When you are                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `references/verbs.md`           | discovering a piece's fields and operations, identifying the deployed contract, retraction verbs                          |
| `references/mutating.md`        | calling a verb directly: the invocation session, what a call's answer does not prove, read-back, stepping the Topic after |
| `references/reading.md`         | reading one Topic's durable input by address, and comparing two addresses                                                 |
| `references/naming.md`          | what a Topic's number is, and the `//<space>/top/42` address form                                                         |
| `references/pattern-updates.md` | changing pattern source: a production migration behind rehearsal and team authorization                                   |
