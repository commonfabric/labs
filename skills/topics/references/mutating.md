# Create, update, and connect Topics

Part of `skills/topics/SKILL.md`, which is the map. This is the detail on every
write: the run's invocation session, creating a Topic and recovering its
address, what a call's answer does and does not prove, the Topic verbs,
references between Topics, and where each part of a Topic goes.

## One invocation session per run

Every write below passes `--invocation`, the caller's own id for that one
mutation. An id is replayable only within the invocation session it was chosen
in, so `cf` refuses an id when no session is in scope (`CF_INVOCATION_SESSION`
or `--invocation-session`). The session has to outlive any one shell, because a
retry may come from a later tool call. Mint it once, at the start of the run,
into a file at a path private to this run:

```bash
(umask 077 && set -C && s="$(deno task cf invocation-session new)" && echo "$s" > '<run session file>')
```

The file is written only once the mint succeeds. `set -C` makes a second mint
fail rather than replace the session. A run that minted a fresh session per
command would make every retry a new invocation, and a retried write would land
twice. Treat the file as a credential: `umask 077` makes it readable only by
you. Never print its contents.

Every write command below starts by reading the session back into the
environment. Replace every angle-bracketed invocation placeholder with an id
unique to that logical mutation, and reuse that id only to retry the same
mutation.

## Create and recover the address

Create through the board and project the returned Topic to its address:

```bash
export CF_INVOCATION_SESSION="$(cat '<run session file>')"
CREATE="$(deno task cf piece call --cell "$TOPICS_BOARD" \
  --invocation '<unique-topic-create-id>' \
  addTopic \
  '{"title":"<title>","body":"<the core issue>","agentName":"Sol"}' \
  -- --schema '{"properties":{"topic":{"$link":true},"name":{"type":"string"}}}')"
TOPIC="$(printf '%s\n' "$CREATE" | jq -r '.result.topic["$link"] // empty')"
NAME="$(printf '%s\n' "$CREATE" | jq -r '.result.name // empty')"
```

The projection names BOTH results, and that is load-bearing: a schema listing
only `topic` drops `name` from the envelope, so `NAME` comes back empty and the
allocated number is lost. Dropping the projection entirely returns the name and
the whole created topic with it — a rendered view included, two orders of
magnitude more payload — which is what the projection exists to avoid.

When the result is present, carry `TOPIC` into the next command. `NAME` is the
member name the board allocated and passed into the Topic — read it here rather
than from the Topic's own `shortName`, because the row IS the created Topic, so
reading a property off a piece filed a moment ago waits for that piece to
materialize. Use JSON encoding or schema-derived flags for multiline Markdown;
do not interpolate unescaped content into JSON.

Current Estuary calls have a known observation asymmetry. `addTopic` has
reported an error after committing and has reported success without committing.
A call can also answer nothing at all: `addTopic` and `addLink` have each hung
past a ten-minute client timeout and committed, and an `addTopic` has hung the
same way and not committed. A timeout therefore settles nothing in either
direction, and none of this is particular to `addTopic` — take it as the
behavior of every authored-content verb.

So treat every call envelope, and every absence of one, as an observation rather
than proof of durable state, and read back after every mutation. For `addTopic`,
use a distinctive title and search for it before and after the call; if the
result is uncertain, recover the Topic's address from `show` rather than blindly
creating another Topic. Retrying under a new id on the strength of a timeout is
how one Topic becomes two.

```bash
deno task -q topics search '<distinctive title>'
TOPIC="$(deno task -q topics show top/<number> | sed -n 's/^Address: //p')"
deno task cf cell get --cell "$TOPIC" title --input
```

## Step the topic after every write

A Topic's scalars divide in two, and a headless write only settles one half.
`title`, `body`, `createdAt`, the comments and the links are durable inputs,
written by the verbs. `lastActivityAt` and `commentCount` are DERIVED from them,
and a derivation is stored only once a run of the piece completes. The board's
index reads the stored values. `cf piece call` starts the topic and runs the
verb, but it returns as soon as the verb's own write commits and does not wait
for the derivations that write sets off, so they are never stored. Until
something runs the topic to completion, the board reads the values from before
the write: a new topic reads as `commentCount` 0 and `lastActivityAt` 0, and a
topic you commented on keeps its old count and activity time. Opening a topic in
the shell runs it, which is why a write made through the UI never shows this and
one made here always does.

Ordering is only partly at stake: `activityOrderOf` falls back to `createdAt`
for a topic that has never run, but a topic that has run keeps sorting by the
activity time it last stored, so a stale one sinks below topics with less recent
activity.

So after every authored write to a topic, `addTopic` and each Topic verb below
alike, step that topic, which is the headless equivalent of opening it. Several
writes to one topic in a row need one step after the last:

```bash
deno task cf piece step --cell "$TOPIC"
deno task cf cell get --cell "$TOPIC" --step --select lastActivityAt,commentCount
```

`shortName` is left out of that projection because it is not a derived scalar
and stepping does not settle it: a topic running this checkout's pattern
publishes the number its durable input holds, so it reads the same before and
after a step. Select it when the number is what you want; `references/naming.md`
says what the deployment carries.

`piece step` runs one scheduling step — start, idle, synced, stop. It authors no
new content, so it is safe to repeat and safe to run over a topic somebody else
filed — but it is not inert: running a topic whose stored state predates a
version bump performs that migration, and the migration is a durable write. A
bulk filing, or a run that writes to many topics, is worth a pass over every
topic it touched.

Retry an uncertain mutation only with the same session and id. The full retry
and receipt model is in `skills/cf/SKILL.md` and
`docs/common/verbs/over-the-cli.md`.

## Update through Topic verbs

```bash
export CF_INVOCATION_SESSION="$(cat '<run session file>')"
deno task cf piece call --cell "$TOPIC" --invocation '<unique-set-title-id>' setTitle \
  '{"title":"<complete new title>","agentName":"Sol"}'
deno task cf piece call --cell "$TOPIC" --invocation '<unique-set-body-id>' setBody \
  '{"body":"<complete revised body>","agentName":"Sol"}'
deno task cf piece call --cell "$TOPIC" --invocation '<unique-add-comment-id>' addComment \
  '{"body":"<point-in-time update>","agentName":"Sol"}'
deno task cf piece call --cell "$TOPIC" --invocation '<unique-add-link-id>' addLink \
  '{"url":"<PR URL>","kind":"pr","label":"<label>","agentName":"Sol"}'
```

`kind` defaults to `web`; a blank or omitted `label` defaults to the URL.
Current authored-content verbs reject blank required content or attribution
instead of reporting apparent success.

Verify the relevant durable input after each call (`title`, `body`, `comments`,
or `links`), then step the topic as "Step the topic after every write" above
says, so that its count and activity time reach the board's index.

A cross-Topic connection is a reference, not an address pasted into prose. Pass
the canonical reference in the declared reference position; the CLI turns it
into the live piece link the verb expects. Set `OTHER_TOPIC` to the address
`deno task -q topics show` prints for the Topic being referenced; a
`{"$link": …}` object a read printed passes in that position as it was printed,
too:

```bash
export CF_INVOCATION_SESSION="$(cat '<run session file>')"
export OTHER_TOPIC='<canonical /of:... address of the other Topic>'
deno task cf piece call --cell "$TOPIC" --invocation '<unique-mention-id>' mention \
  "{\"topic\":\"$OTHER_TOPIC\"}"
deno task cf piece call --cell "$TOPIC" --invocation '<unique-unmention-id>' unmention \
  "{\"topic\":\"$OTHER_TOPIC\"}"
```

Use inline JSON for these reference events. The schema-derived `--topic` flag
parses its declared object before reference resolution and therefore rejects a
bare canonical address.

`unmention` removes every `mention`-made edge to that Topic. References created
inside the body are removed by editing the body. An `addLink` URL that resolves
to a piece also contributes to the reference graph.

## Where each part of a Topic goes

A Topic has three places to write, shown in the UI as Body, Thread, and Links.
What follows is recommended practice, not a requirement: the pattern accepts any
content in any of them, and nothing breaks if a write lands elsewhere. Keeping
each to its own job means a reader knows where to look, and later tooling can
build on the distinction.

- **Body** (`addTopic`'s `body`, then `setBody`): the core issue. What the Topic
  is about, why it matters, and the current state of understanding and
  decisions, written so that someone arriving for the first time can read the
  body alone and know where things stand. Replace it whole when the picture
  changes, preserving meaningful context and decisions. When an update is
  critical for that first-time reader (a decision reversed, the work blocked or
  superseded), put a short note about it at the top of the body as well as in
  the thread. Fabric owns revision history, so the body does not need to record
  how it got to its current state.
- **Thread** (`addComment`): updates. Each comment is an append-only,
  point-in-time record of progress: what changed, what was learned or decided,
  and what comes next.
- **Links** (`addLink`): references to resources the body or thread uses or
  refers to, such as pull requests, documents, dashboards, and agent sessions.
  The label names the resource. Add every relevant pull request with
  `kind: "pr"`; mentioning a PR only in prose is not enough.
- Use references for relationships between Topics. Do not rely on pasted fids or
  prose scanning.
