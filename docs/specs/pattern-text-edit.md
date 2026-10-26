# Editing live collaborative text from pattern code: `Writable<string>.edit`

**Status:** proposed · **Builds on:**
[Collaborative Operations, Views, and Anchors](memory-v2/07-op-views-and-annotations.md)
and its [implementation plan](../plans/memory-apply-op.md)

## Why

A collaborative text field is a Memory v2 operation field. Edits to it
are CodeMirror change sets, which the server codec rebases over
concurrent edits (`packages/memory/v2/operation-codec.ts`). Today the
only way to submit one is the main-thread
`runtime-client.applyOperation`, and its one caller is
`cf-code-editor`. Pattern code has only `.set()`. While the field has an
active epoch, which it keeps until an explicit release, even after every
editor has closed, the engine refuses an ordinary write that changes it
(`OpFieldWriteConflictError`, `packages/memory/v2/engine.ts`), and the
refusal rolls back the whole transaction.

So **no handler, agent or pattern can put a single character into an
active collaborative field.** Only an editor session can.
That rules out:

- an agent appending action items to shared meeting notes;
- an agent adding an item to a list in the note;
- a summary inserted under a heading;
- resetting a shared note from a handler.

Collaborative documents are effectively read-only to all code except
the editor. That is a strange gap for a system where agents are meant
to be collaborators.

This proposes one primitive, shaped like the one agent harnesses
settled on for editing files.

## Prior art

How agent harnesses edit files:

- **Anthropic text editor tool, and the SWE-bench agent.** String
  replacement was the most reliable format. An edit lands only on
  exactly one match; zero or several matches return an error, and the
  model retries with more context
  ([SWE-bench write-up](https://www.anthropic.com/research/swe-bench-sonnet),
  [text editor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)).
- **Claude Code's Edit tool.** The same rule, plus `replace_all`. The
  file must have been read first, which is a staleness check.
- **Aider.** Line numbers in hunks fail; models handle them poorly
  ([unified diffs](https://aider.chat/docs/unified-diffs.html),
  [edit formats](https://aider.chat/docs/more/edit-formats.html)).
- **OpenAI `apply_patch`.** Context lines and scope markers, no line
  numbers
  ([GPT-4.1 prompting guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide)).
- **Cursor.** Search/replace hunks, because models are "bad at counting
  line numbers" ([Instant Apply](https://cursor.com/blog/instant-apply)).
- **SWE-agent.** Line-range edits needed a linter to revert bad edits
  ([paper](https://arxiv.org/html/2405.15793v3)). Its default
  configuration now uses `str_replace`.

**The consensus:**

- anchor by content, never by line number;
- require an exact, unique match;
- return failure as feedback, so the caller re-reads and anchors more
  precisely;
- treat whitespace as significant.

Fuzzy fallbacks only exist to forgive a model's sloppy copy of a file
nobody else is writing. A live document is the opposite case.

## Semantics

This builds on §7's model rather than around it. Three of §7's rules
shape everything below:

- the runner-facing collaboration surface is codec-neutral (plan WP6);
- ordinary cell transactions do not learn editor semantics, and
  `apply-op` never goes into `PendingVersion` (plan WP6);
- changing a codec's validation or integration semantics needs a new
  codec id (§7.5).

```ts
type TextEdit =
  | { old: string; new: string }                       // replace by content
  | { append: string }                                 // on its own line, at the end
  | { prepend: string };                               // on its own line, at the start

type EditOutcome =
  | { state: "pending" }
  | { state: "applied" }
  | { state: "refused"; kind: "no-match" | "ambiguous" | "overlap"; edit: number; count?: number }
  | { state: "conflict"; reason: string }; // could not write at all: authority,
                                           // epoch or history, codec too old

interface Writable<string> {
  /** Submits a text edit as its own operation; never part of this handler's transaction. */
  edit(e: TextEdit | readonly TextEdit[]): Reactive<EditOutcome>;
}

/** Pure; the same function the server runs. A handler may call it on its snapshot. */
function matchEdits(value: string, edits: readonly TextEdit[]): MatchVerdict;
```

`TextEdit` is a text-level request, not a CodeMirror type. A codec that
supports text edits resolves them into its own operations. CodeMirror
is the first such codec.

### An edit is its own operation, with an outcome that arrives later

`edit` does not join the handler's transaction. The runner submits it
as a standalone `apply-op` after the handler commits, the way
`applyOperation` does today. That follows plan WP6 and avoids teaching
cell transactions editor semantics. Two consequences:

- A later `.get()` in the same handler sees the old value.
- The handler does not block, and nothing re-runs. The outcome is a
  reactive value that resolves from `pending` to the server's verdict.
  Anything that depends on the verdict, such as the caller re-reading
  after a `no-match`, is derived from it. There is no prediction to keep consistent
  with the server.

A handler that wants to decide *whether* to submit can call
`matchEdits` on its snapshot. That is an ordinary read, with ordinary
conflicts. The server's verdict is still what counts.

### Where `old` is matched: on the server, when the edit lands

`old` is matched against the value at integrate time, after the
intervening operations, not against anything the caller read.

Rebasing a client-side change set would be wrong. Rebasing preserves
positions, not meaning. If someone types inside the span being
replaced, the rebase strands their words next to `new`, corrupting both
edits with no signal to either party. Matching at integrate time means
the edit applies only where the exact text exists at the moment it
lands. The engine serializes integration, so there is no gap between
the check and the write. Typing elsewhere never blocks it.

The server stores the resolved change set as the integrated operation.
Replay uses it as is and never runs matching again (§7.7.3, invariant
4). The submitted row keeps the text-edit intent.

**A text edit needs no client base.** It matches against the head, so
`intervening` is irrelevant to it. That requires either:

- a server-resolved head base for text-edit payloads (a §7.7 wire
  amendment); or
- the runner fetching the epoch and cursor with `op.query` at send time.

The first is simpler, and it removes a race. Epoch and history errors
(`OpCursorMismatchError`, `OpHistoryUnavailableError`) map to
`conflict`.

### Matching rules

- Compare exact code units, with no normalization.
- `old` must be non-empty. The one exception: `old: ""` matches once
  when the whole value is empty.
- Exactly one occurrence is required: zero is `no-match`, and two or
  more is `ambiguous`, with the count (overlaps included).
- There is no replace-all. Nothing in the agent-harness precedent needs
  it, and it is a broad change made by one call. A caller that wants
  several replacements lists them.

### Append and prepend are line-oriented

The field's start and end always exist and are always unique, so
`append` and `prepend` never fail with `no-match` or `ambiguous`. They
are for the empty field and for logging at the bottom of a document.
Anchoring an append on "the current last line" would fail every time
someone typed at the bottom.

They mean "add this as its own line", so there is no newline for a
caller to forget:

- `append` inserts `"\n"` first, unless the value is empty or ends with
  `"\n"`.
- `prepend` inserts `"\n"` after the text, unless the value is empty or
  the text ends with `"\n"`.

Nothing else is normalized, and an explicitly requested blank line is
kept. Inserting after a known passage, or continuing the last line, is
a replacement instead. Two concurrent appends land in the order they
are integrated.

### Several edits

- **Matching.** Every replacement matches against the same starting
  value.
- **Overlap.** Matched spans must not overlap. Overlap depends on the
  value at integrate time, so it is a refusal (`overlap`), not a throw.
- **Ordering at a boundary.** Inserts at the same boundary land in list
  order. Each append's separator is resolved against the value as it
  stands after the edits before it in the list.
- **Atomicity.** The list applies all or nothing.

### Duplicates: the runtime's receipts, not a new mechanism

The runtime already makes handling exactly-once. Every handling derives
a create-only receipt from the durable event id, so a redelivered event
collides on its receipt and is rejected, not handled a second time
(`docs/specs/scheduler-v2/README.md`, "Receipts"). `edit` adds no
mechanism of its own:

- **The operation's submission id derives from the handling's event
  id.** A resend after a reconnect reuses it, and §7's durable
  submission ids already make that idempotent.
- **One runtime handles an event.** Client-side, it is the runtime the
  event was sent to. Server-side, it is the server, and the client's
  local speculative run is not replicated. So there is no "every
  participant runs it" case to guard against.
- **A request that must not be sent twice needs an event id derived
  from its inputs.** For an agent calling `edit` through a harness tool,
  the trusted environment (the harness) supplies the timestamp the id
  is derived from. Agents never invent ids or timestamps. This is open
  work shared with other callers, not something `edit` defines.
- **A lost turn followed by a fresh request is just another request.**
  If the first edit landed, the text it replaced is gone, so the second
  fails with `no-match`. No protocol can do better, and none is needed.

### Inactive fields

On a field with no active epoch, `edit` compiles to an ordinary patch,
with a confirmed read and the normal conflict path. It does not
activate the field. Activating it would make every existing `.set()`
writer of that field start throwing.

## What it must not do

- **No fuzzy matching.** No whitespace trimming, no Unicode folding, no
  first match wins. In a live document, a near match is usually text a
  person just changed on purpose. A failure costs one re-read; landing
  in the wrong place overwrites someone's words.
- **No line numbers or offsets** in the API. Start and end are the only
  positional anchors, because they are the only positions that mean the
  same thing after anyone's edit.
- **No partial application, no `.set()` fallback, and no retry inside
  `edit`.**

## CFC

- **`edit` needs READ as well as WRITE.** §7.13 requires only WRITE for
  `apply-op`, but the outcome (`no-match`, `ambiguous` and its count)
  reveals content. A write-only principal would gain a read
  oracle. Without READ, a refusal collapses to `conflict`.
- **The outcome is labeled with the field's confidentiality**, attached
  where the runner resolves it rather than through a recorded read.
- **`new` is checked against the field's label**, like any write, at
  integrate time, for the submitting principal.
- **No label side data.** Range-oriented CFC stays deferred (plan WP9),
  so labels stay whole-field.

## What labs would add

1. **A new codec id, `codemirror-changeset@2`,** accepting `changes` or
   `replace`. The codec id is fixed for an epoch's life (§7.6), so
   `cf-code-editor` moves to `@2` for new epochs. Detection is through
   the codec handshake (§7.5), not unknown-key rejection.
2. **A server-resolved head base** for text-edit payloads (§7.7), or
   the runner fetching the cursor with `op.query`.
3. **Structured refusals** in place of a generic codec error.
4. **`Writable<string>.edit` in the runner**: a standalone operation
   after the handler commits, with a reactive outcome and a submission
   id derived from the handling's event id. It is not in
   `PendingVersion`.
5. **One exported pure `matchEdits`**, shared by the codec and the
   runner.
6. **The outcome returned unchanged** through any command or agent tool
   surface.

## Open questions

These need Bernhard's call, since §7 and its plan are his:

1. **Head base or `op.query`?** A server-resolved head base for
   text-edit payloads, or the runner fetches the cursor? (This proposal
   prefers the head base.)
2. **What about fields still active under `@1`?** Should `edit` on such
   a field return `conflict` until it is released and reopened, or is
   there a sanctioned way to move a live epoch to `@2`?
3. **Is a standalone operation with a reactive outcome the right
   runner shape**, or would he rather amend WP6 to allow `apply-op` in a
   handler's commit?
4. **READ as well as WRITE** for text-edit payloads: an amendment to
   §7.13?
5. **Positional fallback.** An anchor can be unique at submit time and
   become ambiguous only because someone pasted a copy elsewhere.
   Should the server then map a submit-time position through the
   intervening operations? This proposal says no, until evidence says
   otherwise.
