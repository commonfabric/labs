# Create, update, and connect Topics

Part of `skills/topics/SKILL.md`, which is the map. This is the detail on every
write: creating a Topic and recovering its address, what a call's answer does
and does not prove, the Topic verbs, references between Topics, and the
editorial conventions every write follows.

## Create and recover the address

Mint one invocation session for the agent run. Replace every angle-bracketed
invocation placeholder below with an id unique to that logical mutation, and
reuse that id only to retry the same mutation. Create through the board and
project the returned Topic to its address:

```bash
export CF_INVOCATION_SESSION="$(deno task cf invocation-session new)"
CREATE="$(deno task cf piece call --cell "$TOPICS_BOARD" \
  --invocation '<unique-topic-create-id>' \
  addTopic \
  '{"title":"<title>","body":"<initial living document>","agentName":"Sol"}' \
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
than from the Topic's own `shortName`, for two reasons: the row IS the created
Topic, so reading a property off a piece filed a moment ago waits for that piece
to materialize, and a Topic publishes no `shortName` at all while
`SHOW_TOPIC_NUMBERS` in `packages/patterns/topics/topic.tsx` is off
(`references/naming.md`). Use JSON encoding or schema-derived flags for
multiline Markdown; do not interpolate unescaped content into JSON.

Current Estuary calls have a known observation asymmetry. `addTopic` has
reported an error after committing and has reported success without committing.
A call can also answer nothing at all: `addTopic` and `addLink` have each hung
past a ten-minute client timeout and committed, and an `addTopic` has hung the
same way and not committed. A timeout therefore settles nothing in either
direction, and none of this is particular to `addTopic` — take it as the
behavior of every authored-content verb.

So treat every call envelope, and every absence of one, as an observation rather
than proof of durable state, and read back after every mutation. For `addTopic`,
use a distinctive title and compare the narrow board index before and after the
call; if the result is uncertain, recover its `$link` there rather than blindly
creating another Topic. Retrying on the strength of a timeout is how one Topic
becomes two.

```bash
deno task cf cell get "$TOPICS_BOARD" index --step --select @,title
deno task cf cell get --cell "$TOPIC" title --input
```

## Warm the topic you just filed

A Topic's scalars divide in two, and a headless filing only writes one half.
`title`, `body` and `createdAt` are durable inputs, written by `addTopic`.
`lastActivityAt` and `commentCount` are DERIVED, and a derivation materializes
only once the piece has RUN. Creating a topic does not run it, so until
something does, the board reads those fields as their declared defaults —
`lastActivityAt` 0, `commentCount` 0. Opening a topic in the shell runs it,
which is why a topic filed through the UI never shows this and one filed here
always does.

Ordering does not depend on this: `activityOrderOf` falls back to `createdAt`,
so a topic that has never run still sorts by when it was filed. Stepping is what
makes its derived fields true, not what puts the card in the right place.

So finish a filing by stepping the new topic, which is the headless equivalent
of opening it:

```bash
deno task cf piece step --cell "$TOPIC"
deno task cf cell get "$TOPICS_BOARD" index --step --select @,title,lastActivityAt,commentCount
```

`shortName` is not in that list on purpose. It is gated on `SHOW_TOPIC_NUMBERS`
in `../../../packages/patterns/topics/topic.tsx`, currently `false`, so a topic
running this checkout's pattern publishes none however often it is stepped. A
board still serving a pattern from before that flag was turned off does publish
one, which is the kind of difference the running piece settles and the checkout
does not.

`piece step` runs one scheduling step — start, idle, synced, stop. It authors no
new content, so it is safe to repeat and safe to run over a topic somebody else
filed — but it is not inert: running a topic whose stored state predates a
version bump performs that migration, and the migration is a durable write. A
bulk filing is worth a pass over every topic it created.

Use one invocation session per agent run and an explicit invocation id per
logical mutation. Retry an uncertain mutation only with that same session/id
pair. The full retry and receipt model is in `skills/cf/SKILL.md` and
`docs/common/verbs/over-the-cli.md`.

## Update through Topic verbs

```bash
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
or `links`). Use `--step` as a second check when the expected change is
computed, such as a count or board-index row.

A cross-Topic connection is a reference, not an address pasted into prose. Pass
the canonical reference in the declared reference position; the CLI turns it
into the live piece link the verb expects. Set `OTHER_TOPIC` to the `$link` from
the index row for the Topic being referenced; the row's `{"$link": …}` object
passes in that position as it was printed, too:

```bash
export OTHER_TOPIC='<canonical /of:... address from another index row>'
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

## Editorial conventions

- Treat the body as the living big-picture document. Replace it whole with the
  current state while preserving meaningful context and decisions. Fabric owns
  revision history; do not duplicate it as an activity log.
- Treat comments as append-only, point-in-time progress records. Record what
  changed, what was learned or decided, and what comes next.
- Add every relevant pull request explicitly with `addLink` and `kind: "pr"`;
  mentioning a PR only in prose is not enough.
- Use references for relationships between Topics. Do not rely on pasted fids or
  prose scanning.
