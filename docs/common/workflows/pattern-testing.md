# Pattern Testing

Write automated tests for patterns using the same reactive system.

## Prerequisites

Before writing tests, ensure your pattern:

1. **Uses `pattern<Input, Output>()`** - Single-type patterns can't be properly tested
2. **Exports actions as `Stream<T>`** - Required for `instance.action.send()` to work

```typescript
// Shown at module scope.
// Pattern must have explicit Output type with Stream<T> for testable actions
interface MyOutput {
  count: number;
  increment: Stream<void>;  // ← Enables testing via .send()
}

export default pattern<MyInput, MyOutput>(({ count }) => {
  const increment = incrementHandler({ count });
  return { count, increment };  // ← Must return bound handler
});
```

If your pattern uses `pattern<State>()`, fix the pattern first. See [Pattern Types](../concepts/pattern.md#always-use-dual-type-parameters). A pattern that doesn't export its actions can still be driven through its UI — see [Firing a handler the pattern does not export](#firing-a-handler-the-pattern-does-not-export).

## Overview

Test patterns are patterns that test other patterns. They:
- Import and instantiate the pattern under test
- Define test actions using `action()`
- Define assertions using `assert(() => boolean)`
- Return a `[TESTS]` array that the runner executes sequentially

Test files end in `.test.tsx` and are run with `deno task cf test`.

## Quick Example

```tsx
// Shown at module scope.
import { action, assert, pattern } from "commonfabric";
import Counter from "./counter.tsx";

export default pattern(() => {
  // 1. Instantiate pattern under test with plain values
  const counter = Counter({ value: 0 });

  // 2. Define actions (trigger events on the pattern)
  const action_increment = action(() => {
    counter.increment.send();
  });

  // 3. Define assertions (reactive conditions that report their operands)
  const assert_is_zero = assert(() => counter.value === 0);
  const assert_is_one = assert(() => counter.value === 1);

  // 4. Return the test steps under the [TESTS] key
  return {
    [TESTS]: [
      { assertion: assert_is_zero },
      { action: action_increment },
      { assertion: assert_is_one },
    ],
  };
});
```

**Note:** Pass plain values when instantiating patterns in tests. The runtime creates independent writable cells automatically. Use `new Writable()` only when you need to test shared state behavior. See [Writable](../concepts/types-and-schemas/writable.md#passing-values-to-pattern-inputs) for details.

## Running Tests

```bash
# Run a specific test
deno task cf test patterns/my-pattern/main.test.tsx

# Run with verbose output
deno task cf test patterns/my-pattern/main.test.tsx --verbose

# Run all tests in a directory
deno task cf test patterns/my-pattern/
```

### Testing labeled data

Use `cf test <file> --cfc-shell-posture --verbose --stats-threshold 0` to run
with `enforce-explicit` enforcement and `persist` flow labels, which is laxer
than the shell's current `enforce-strict` posture.
Individual dials are `--cfc-enforcement-mode` and `--cfc-flow-labels`; the latter
accepts `off`, `derive` (the runtime's `observe`), `observe`, and `persist`.
The run prints the resolved posture. When CFC denies something — a write,
including one the pattern's own setup makes — `--cfc-denials` prints each
denial with the reasons behind it. The
[CLI guide](../../../runtime/cli/README.md#pattern-test-cfc-posture-and-labeled-fixtures)
shows how a test declares a local SQLite store with per-column `ifc` labels and
explains the per-step CFC preparation timings.

### Import roots

A test pattern's imports resolve within its root directory. Without `--root`,
`cf test` anchors at the nearest ancestor whose `deno.json(c)` declares a
package name — `patterns` for this repository's patterns — so imports
that span the package (shared helpers such as
`tools/test-support/vnode-helpers.ts`, sibling patterns, `cfc/` modules) resolve
without a flag. A config file with no `name`, such as a workspace member stub
that only defines tasks, does not anchor the root. Pass `--root` to anchor
somewhere else; an import that climbs above the root fails naming the import and
the importing file. CI's `pattern-unit` suite (the `pattern-tests` target in
`tasks/integration.ts`) passes `--root patterns` explicitly, so a bare local run
resolves imports the same way CI does.

### The test's space and its access list

A single-user test runs in its identity's home space, on an in-process store.
Before the test pattern runs, `cf test` gives that space the access list a home
space is born with, naming the test's identity as its only OWNER. So
`spaceAccess()`, asked about any cell in the test's space, returns `"OWNER"`,
in a handler and in a computed alike.

A multi-user test's participants share one space, which is created with an
access list. The first participant's user is its OWNER. Every other user holds
the level one of its participants declares with `access`, or `"WRITE"` when
none of them declares one; `"none"` leaves the user out of the list, and
`spaceAccess()` then returns `"none"` for it. Participants that share a `user`
share its level, so they cannot declare two different ones, and the first
participant's user cannot declare anything but `"OWNER"`.

```tsx
// Shown for illustration only.
export default multiUserTest({
  setup,
  participants: {
    host, // OWNER, as the first participant
    guest, // WRITE, since it declares no level
    viewer: { pattern: viewer, access: "READ" },
    stranger: { pattern: stranger, access: "none" }, // not in the list
  },
});
```

Neither space's storage enforces the list. A participant at `"READ"`, or left
out at `"none"`, still reads and writes the shared space like any other, so the
list is what `spaceAccess()` reports and nothing more. A pattern test can check
what a pattern decides from the level it is given, such as a control only an
OWNER is offered. What the memory server refuses a principal is a question for
a test against a server that enforces access lists.

## Test Step Format

Tests use a **discriminated union** format:

```tsx
// Shown inside a pattern body.
return {
  [TESTS]: [
    { action: action_do_something },     // Runner calls .send()
    { assertion: assert_something },     // Runner reads the assert() record
  ],
};
```

Each step is most often `{ action: Stream<void> }` or `{ assertion }`, where the
assertion is the record `assert()` produces — see
[Write assertions with `assert()`](#write-assertions-with-assert) below. A
`{ press, control, within?, modifiers? }` step clicks a control the view renders, as
[Firing a handler the pattern does not export](#firing-a-handler-the-pattern-does-not-export)
describes, and `docs/specs/PATTERN_TESTING_SPEC.md` lists every kind of step.

## Walking the Rendered Tree

Both actions and assertions often need to reach into what a pattern rendered.
`patterns/tools/test-support/vnode-helpers.ts` is the one place those helpers
live; import from it rather than writing a private copy in a test file. Each
helper resolves cells as it walks, so a test does not have to unwrap reactive
values by hand.

Reading a single node:

- `readValue(value)` — resolves a cell to the value it holds, and passes
  anything else through unchanged.
- `propsOf(node)` — the node's props, or `undefined` when the node has none.
- `propValue(node, prop)` — one resolved prop off a node.
- `childNodes(node)` — the node's rendered children.
- `textContent(node)` — every text child in the subtree, concatenated. This
  reads text children only. Text a component carries in a prop, such as the
  `label` on a `cf-chip`, is not part of it — search for that prop instead.
- `hasText(node, expected)` — whether the subtree's text contains `expected`.
- `hasExactText(node, expected)` — whether the subtree's text, trimmed, equals
  `expected`.
- `isElement(node, name)` — whether the node is an element with that tag name.
- `styleOf(node, key)` — one resolved entry of the node's `style` prop.
- `viewShows(root, present, absent)` — whether the subtree's text contains
  every string in `present` and none in `absent`, read in one walk.
- `pickerLabels(picker)` — the labels of the `items` a picker such as
  `cf-autocomplete` offers, in order.
- `inOrder(text, parts)` — whether `parts` appear in `text` in that order, each
  one starting after the end of the one before it.

Searching for a node:

- `findNode(root, predicate)` — the first node in the subtree the predicate
  accepts.
- `findNodeByProp(root, prop, expected)` — the first node whose `prop` resolves
  to `expected`. This is the way to assert on text a component carries in a
  prop.
- `findNodeById(root, id)` — the first node with that `id` prop.
- `findNodeByText(root, expected)` — the first node whose text contains
  `expected`.
- `findElement(root, name)` — the first element with that tag name, such as
  `"cf-image"`.
- `findElementByText(root, name, expected)` and
  `findElementByExactText(root, name, expected)` — the same search narrowed to
  a tag name.
- `findNodes(root, predicate)` and `findElements(root, name)` — every node the
  predicate accepts, or every element with that tag name, in document order.
- `countElements(root, name)` — how many elements with that tag name the
  subtree holds, nested ones included.
- `innermostNode(root, accept)` — the first node `accept` admits that has no
  admitted node inside it, such as the row itself rather than every container
  that also carries its text.
- `isButton(label)` — a predicate for a clickable node whose whole text is
  `label`.
- `rowWith(root, text, label)` — the row that shows `text` and holds a button
  labeled `label`: the innermost node holding both.
  `buttonInRow(root, text, label)` is that button.

Pressing a control:

- `fireEvent(node, prop, event)` and `fireClick(node)` — send an event to the
  handler a node binds, as described under
  [Firing a handler the pattern does not export](#firing-a-handler-the-pattern-does-not-export).
- `clickButton(root, label)` — clicks the first button whose whole text is
  `label`.
- `sendMessage(root, message)` — sends `message` from the view's
  `cf-message-input`, as a person pressing send does.
- `clickInRow(root, text, label)` — clicks the button `buttonInRow` finds.

Typing into a control:

- `setBound(node, prop, value)` — writes `value` through the cell the node
  binds under `prop`, such as `$value`, `$checked` or `$result`, as the control
  does when the user types or picks in it. It works in an `action` and in a
  handler that receives the view as a `Cell<VNode>`, and fails when the node is
  missing or binds no cell under `prop`.
- `typeInto(root, placeholder, value)` — the `$value` case, for the input with
  that placeholder.
- `answerOwnerCheck(root, isOwner)` — answers a `cf-owner-view` the way the
  shell does, through its `$result`.

Writing through a binding:

A value read resolves a `$`-prop such as `$checked` or `$value` to the plain
value its binding holds, so a test that acts as the bound control walks the
view as cells instead. A handler declares the view as a `Writable<VNode>` in
its state and is bound with `subject[UI]`; `viewCell(ui)` makes that cell
walkable by key.

- `findViewCell(cell, predicate)` — the cell holding the first node the
  predicate accepts, searched in the order `findNode` searches.
- `boundViewCell(view, predicate, prop)` — the cell the first accepted node
  binds as `prop`. Setting it writes whatever the binding links to, as the
  control does, and it throws when no such node binds `prop`.

`patterns/dev/gideon-tests/test-checkbox-computed.test.tsx` checks boxes this
way.

## Writing Actions

Use `action()` to create void streams that trigger events on the pattern:

```tsx
// Shown inside a pattern body.
// Trigger a void handler
const action_reset = action(() => {
  game.reset.send();  // No argument needed for Stream<void>
});

// Trigger a handler with data
const action_add_item = action(() => {
  list.addItem.send({ name: "Test Item", quantity: 5 });
});

// Multiple operations in one action
const action_setup_game = action(() => {
  game.playerReady.send();
  game.startGame.send();
});
```

### Firing a handler the pattern does not export

A handler bound only in JSX can still be fired, so a pattern that keeps its
behavior behind a button does not have to change to be tested.

The way that holds wherever the test's actions run is a press step, which
clicks the control in the rendered view as a person does:

```tsx
// Shown for illustration only.
// `room` is the pattern under test, and `listed` reads its attachment rows.
return {
  [TESTS]: [
    // The "Remove" in the row that shows "slow.txt".
    { press: room[UI], control: "Remove", within: "slow.txt" },
    { assertion: assert(() => listed(room[UI]).length === 0) },
  ],
};
```

The runner renders the view as a browser does, finds the one element whose text
is `control`, and clicks it, so the handler bound there receives the click with
the provenance the control's rendered markers give it; a reviewed control needs
no `trustedUi`. `within` picks one row out of several that show the same
control; `patterns/system/fabrichat/composer-attach.test.tsx` removes an
attachment this way. `modifiers` holds keys down during the click, so
`{ press: list[UI], control: "Telegram", modifiers: ["meta"] }` Cmd-clicks the
control; `runtime/cli/test/fixtures/press/press-modifiers.test.tsx` presses
with and without them.

Prefer it to walking the tree in an `action`, below, when the control is bound
per row or per session. With server execution on, an `action` runs on the
serving loop, whose rendering of the view lacks what only the test's session
shows, such as the rows of that session's own draft, so the walk there finds no
control. A press finds the control in the test's own rendering.

The tree walk reads the control's stream in an `action` and sends to it. The prop carries
a stream whether the handler was written inline or bound from module scope. Walk
the rendered tree to the node, read the prop, and send it an event:

```tsx
// Shown at module scope.
import { action, pattern, UI } from "commonfabric";
import { clickButton } from "../../tools/test-support/vnode-helpers.ts";
import MapDemo from "./map-demo.tsx";

export default pattern(() => {
  const subject = MapDemo({ areasOfInterest: [] });

  const action_add_area = action(() => clickButton(subject[UI], "+ Add Area"));

  return { [TESTS]: [{ action: action_add_area }], subject };
});
```

`patterns/examples/map-demo/map-demo.test.tsx` drives both an inline arrow and a
bound handler this way. `fireEvent(node, prop, event)` in the vnode helpers
sends an event to any event prop, and fails when the node binds nothing under
it; `fireClick(node)` is its `onClick` case, with an empty event, and
`clickButton(root, label)` clicks the first button whose whole text is
`label`.
`sendMessage(root, message)` sends from the view's `cf-message-input` as a
person pressing send does. `setBound(node, prop, value)` writes through the cell
a control binds under a `$` prop, such as `$value` or `$checked`, as the control
does when a person edits it.
`patterns/examples/scoped-group-chat/submit-on-enter.test.tsx` presses Enter in
a `cf-input` by firing its `oncf-submit`.

Prefer an exported `Stream<T>` when you own the pattern: it states the entry
point in the output type. Use the tree walk when the handler belongs to the UI
and exporting it would only serve the test.

### Putting a cell link in an event

A step's `event` may carry a link to a cell, such as one element of a stored
list. The steps are part of the test pattern's own result, and that result's
schema comes from the types of what the test returns. So where the linked
cell's type carries a write policy — a `TrustedActionWrite` or a
`writeAuthorizedBy` naming the pattern's own handler — the test pattern's
setup has to satisfy that policy just to store the step, and CFC refuses it:

```
CFC denied (write-policy-gate): a policy check refused the commit
  - writeAuthorizedBy requires a trusted verified binding identity at /$TESTS/*/event/note
```

Give the link the type the handler's event declares, in a local with a type
annotation, and put that in the event. The annotation is what sets the schema,
and the event's type names no policy. A cast is refused by the transformer.

```tsx
// Shown for illustration only.
// `Notes` stores `StoredNote`s, a `TrustedActionWrite` naming its `add`
// handler; `pick` takes `{ note: Cell<NoteRecord> }`.
const board = Notes({
  notes: Writable.of<StoredNote[]>([]),
  picked: Writable.of<string>(""),
});
const first: Cell<NoteRecord> = board.notes.key(0);

return {
  [TESTS]: [
    {
      action: board.add,
      event: { text: "hello" },
      trustedUi: { surface: SURFACE, action: ADD },
    },
    { action: board.pick, event: { note: first } },
    { assertion: assert(() => board.picked === "hello") },
  ],
};
```

`runtime/cli/test/fixtures/action-event/policy-link-typed.test.tsx` is this
example whole, and `policy-link-inferred.test.tsx` beside it is the refused
form.

Take the link from a cell the test reaches some other way as well: an output
of the pattern under test, as `board.notes` is here, or a cell the test also
passes to that pattern or returns. A `.key()` link into a cell the test uses
nowhere else fails the build with `Cell not found in pattern aliases`.

`cf test --cfc-denials` prints a setup refusal like this one with its reason.

Before dispatching an action step, both test runners demand the reads needed
to construct its event. A trusted UI wrapper copies the payload's top-level
fields, so links supplied there by another pattern or a computation are ready
without an earlier assertion or render. Nested objects and arrays keep their
references for event serialization and the handler's reads.

Copying a field can read the immediate linked record's shape or value. The
runner does not recursively read the records reachable from that field; those
reads belong to the handler. An action step can therefore exercise cold linked
descendants, but does not guarantee that every immediate target is unread.

## Writing Assertions

Use `assert()` to state each condition a test checks:

```tsx
// Shown for illustration only.
// Simple equality
const assert_count_is_5 = assert(() => counter.value === 5);

// Complex conditions
const assert_all_items_valid = assert(() => {
  return list.items.every(item => item.quantity > 0);
});

// Multiple conditions
const assert_game_ready = assert(() => {
  return game.phase === "ready" && game.players.length === 2;
});
```

### Write assertions with `assert()`

A test step's `assertion` is the record `assert()` produces; a bare
`Reactive<boolean>` — a `computed()` or a plain cell — is a compile error.
This is what `assert()` buys. A bare boolean could only ever report the value
it produced, because the comparison ran inside a closure and its operands were
gone before the runner saw anything:

```
✗ assertion_1
    Expected true, got false
```

`assert()` records those operands as the assertion runs and reports them on
failure:

```
✗ assertion_1
    total <= budget
      total  = 45
      budget = 30
```

Each operand is labeled with the source text you wrote. `assert()` reports:

- the operands of the top-level operator — `total` and `budget` above
- the arguments of a call — `assert(() => inRange(value, low, high))` reports
  `value`, `low` and `high`
- for `&&`, `||`, `??` and `?:`, which side failed and the values behind it —
  `assert(() => x > 0 && y < 10)` reports `x > 0 = false` along with `x`

Short-circuiting is preserved, so an operand the assertion never evaluated is
never reported: if `x > 0` is false, `&&` never reads `y`, and nothing about
`y` appears. Literal operands are left out, since a literal renders to the text
you already wrote.

Values render the same way the rest of the runner renders them, so a mismatched
object or array shows its contents rather than `[object Object]`.

When a call's arguments say nothing — `items.every((i) => i.ok)`, whose only
argument is a function, or `items.includes("x")`, whose only argument is a
literal — the value reported is the receiver, `items`.

An assertion that recorded no operands at all has nothing to explain itself
with, so it reports the verdict alongside what you wrote:

```
✗ assertion_1
    Expected true, got false: ready
```

That usually means the assertion was a bare value. Compare it against what you
expect — `assert(() => ready === true)` — and the operands appear.

### Use `assert()` only for assertions

`assert()` carries a record of what it recorded, not a bare boolean, and a
record is always truthy. An `assert()` used as a *condition* would always take
the true branch:

```tsx
// Shown for illustration only.
const ready = assert(() => count.value === 5);
// Wrong: `ready` is a record, so this is always "yes".
const label = ifElse(ready, "yes", "no");
```

Reach for `computed()` for a reactive boolean you intend to read as a value,
and keep `assert()` for a test step's `assertion`.

Keep assertions deterministic. Do not call `Date.now()` or `Math.random()`
inside the assertion itself (they are gated and throw in a `computed()`
anyway). If the pattern stamps a timestamp or random ID, assert that the value
exists or changed in the expected place.

## Answering Fetches and Model Requests

A test states what a fetch or a language model answers in a module-scope
export, which the runner reads after it compiles the test and before anything
runs.

### Fetches

`fetchMocks` answers the HTTP requests `fetchJson` and the other fetch
builtins make. The first entry whose `urlIncludes` is part of a request's URL
answers it, with `body` (or `base64Body`, for bytes), `status`, and
`contentType`; `delayMs` holds the answer back for that long. A request no
entry matches goes to the network.

```tsx
// Shown at module scope.
export const fetchMocks = [
  { urlIncludes: "/api/weather", body: '{"forecast":"sunny"}' },
];
```

`patterns/examples/fetch-json/fetch-mock.test.tsx` is a worked example.

### Model requests

`llmMocks` answers the requests `generateText`, `generateObject`, `llm`, and
each turn of `llmDialog` make. Every request is answered from it, whether or
not the test exports it, so a test that makes a request without stating an
answer fails rather than reaching a model.

```tsx
// Shown at module scope.
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  hasText,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import LLMTest from "./llm.tsx";

export const llmMocks = [
  {
    when: {
      systemContains: "helpful assistant",
      lastMessageContains: "What is the capital of France?",
    },
    text: "Paris.",
  },
];

export default pattern(() => {
  const subject = LLMTest({ title: "LLM Test" });
  const action_ask = action(() =>
    sendMessage(subject[UI], "What is the capital of France?")
  );
  return {
    [TESTS]: [
      { action: action_ask },
      { assertion: assert(() => subject.response === "Paris.") },
      { assertion: assert(() => hasText(subject[UI], "LLM Response:")) },
    ],
  };
});
```

Each entry carries one kind of answer:

- `text`, `toolCalls`, or both answer a text request, which is what
  `generateText`, `llm`, and `llmDialog` make. Each tool call is
  `{ name, input }`, with an optional `id`. A streamed request, such as each
  turn of a dialog, receives the text as its partial result before the reply
  completes.
- `object` answers a `generateObject` request. A `generateObject` given tools
  is sent as a text request offering a `presentResult` tool, and an `object`
  entry answers it with a call to that tool carrying the object. An entry with
  only `text` does not answer such a request; one with `toolCalls` does, which
  is how a test has the model call other tools before it returns the object.
- `error` fails the request with that message, whichever kind it is. This is
  how a test reaches a pattern's handling of a failed request. A failed
  request usually logs a warning, which fails the test unless it also sets
  `allowConsoleWarnings: true`.

`when` narrows which requests an entry answers, with the conditions
`systemContains`, `lastMessageContains`, `messagesContain` (a list of strings,
each in some message), `hasTools` (a list of tool names the request offers),
and `messageCount`. The text conditions search a message's text parts only, so
a tool result does not match them. An entry that calls tools answers only a
request that offers each tool it calls.

A request is answered by the first entry, in the order the test lists them,
that no earlier request used up, whose kind fits, and whose conditions the
request meets. That entry is then used up, unless it says `repeat: true`, in
which case it answers every request it fits. So entries without conditions
answer requests in turn, and the conditions pick an entry out when the order of
the requests is not fixed, as when a pattern starts two requests at once. An
entry that repeats suits a request a pattern makes a varying number of times,
such as one for each item of a list it keeps. An entry with `toolCalls` cannot
repeat, since it would answer every turn of a dialog with another tool call;
the runner refuses such an entry before the test runs.

A dialog's tools run when the model calls them, so a test states every turn of
the model's side of the conversation. After a tool call, the next request
carries the call and the tool's result, so `messageCount` tells the turns
apart:

```tsx
// Shown at module scope.
export const llmMocks = [
  {
    when: { messageCount: 1 },
    toolCalls: [{ name: "readRawBriefing", input: {} }],
  },
  {
    when: { messageCount: 3 },
    toolCalls: [{
      name: "sendMail",
      input: { recipient: "bob@example.org", subject: "approved", body: "…" },
    }],
  },
  { when: { messageCount: 5 }, text: "I could not send the email." },
];
```

`patterns/examples/cfc-agent-prompt-injection-demo/model-turns.test.tsx` drives
two dialogs this way and asserts what each tool did, and
`patterns/examples/llm/llm.test.tsx` states both an answer and a failed
request.

The runner fails the test with a result named `llmMocks` for a request no entry
answered, saying what the request held and why each remaining entry of its kind
did not fit it; when the run fails for another reason, these join its error.
An entry no request uses is not a failure, because a test can make some
requests only when server execution is on. An export
the runner cannot read, such as an entry with an unknown key or two kinds of
answer, fails the run before anything runs.

A multi-user test has one list of entries for all its participants: each
request is answered by the first entry that fits and is not used up, whichever
participant makes it.

## Test Organization

### Naming Conventions

Use descriptive names that explain what the test verifies:

```tsx
// Shown for illustration only.
// Actions: action_<what_it_does>
const action_add_first_item = action(() => { ... });
const action_remove_all_items = action(() => { ... });

// Assertions: assert_<expected_state>
const assert_list_empty = assert(() => list.items.length === 0);
const assert_total_is_100 = assert(() => cart.total === 100);
```

### Logical Ordering

Put actions before the assertions that depend on them:

```tsx
// Shown inside a pattern body.
return {
  [TESTS]: [
    // Initial state
    { assertion: assert_starts_empty },

    // Add items
    { action: action_add_item },
    { assertion: assert_has_one_item },

    // Modify items
    { action: action_update_item },
    { assertion: assert_item_updated },

    // Remove items
    { action: action_remove_item },
    { assertion: assert_empty_again },
  ],
};
```

## Debugging Failed Tests

When a test fails, use the CLI to inspect pattern state:

### 1. Run with Verbose Mode

```bash
deno task cf test ./main.test.tsx --verbose
```

This shows which action ran before each assertion failure. An `assert()`
failure already names its operands and their values, which is usually enough to
see what went wrong without deploying anything.

### 2. Deploy and Inspect

Deploy the test pattern and use CLI commands to inspect state:

```bash
# Deploy the test pattern
deno task cf piece new ./main.test.tsx

# Get the piece ID from the output, then inspect
deno task cf piece inspect --cell <PIECE_ID>

# Get specific values
deno task cf cell get subject/items --cell <PIECE_ID>

# Step through manually (the reserved key is the literal `$TESTS`, quoted so
# the shell does not expand it)
deno task cf piece call --cell <PIECE_ID> '$TESTS/0/action'
deno task cf piece step --cell <PIECE_ID>
deno task cf cell get '$TESTS/1/assertion' --cell <PIECE_ID>
```

This diagnostic command deliberately deploys the test pattern as the executable
entry so its action and assertion cells can be inspected. A normal deployment
uses the subject pattern as the executable entry and attaches this test with
`--test ./main.test.tsx`.

### 3. Expose Debug Data

Add extra fields to your test pattern for debugging:

```tsx
// Shown for illustration only.
return {
  [TESTS]: [...],
  // Expose internals for debugging
  subject,
  debugState: computed(() => ({
    phase: game.phase,
    turn: game.currentTurn,
    scores: game.scores,
  })),
};
```

## Common Patterns

### Seeding Stored State

A scenario that needs the pattern under test to start with data already in it
passes that data as an argument. A literal is fine. A `computed()` is not, for
any input the pattern writes: an argument is a link, so the pattern's own state
would live in the derivation's output cell, and the next run of the derivation
replaces everything the pattern has written since. The rule and its read-only
counterpart are in
[Pattern Composition](../patterns/composition.md#an-input-the-sub-pattern-writes-takes-a-cell).

Timestamps are where this bites, because a test cannot read the ambient clock
from a pattern body and reaches for a `#now` wish instead. The interval form
advances on a wall-clock boundary partway through a long run, so a seed derived
from it re-runs then, and the pattern's state goes with it — which shows up as
a test that passes on a fast machine and loses one step's worth of writes on a
loaded one.

Give such an input a cell of its own and fill it from an action. An action is a
handler, so it can read the clock's current value and write a fixed number:

```tsx
// Shown inside a pattern body.
const nowCell = wish<number>({ query: "#now/300" });
const now = resultOf(nowCell.result);
const glazes = Writable.of<{ name: string; bakedAt: number }[]>([]);
const tray = DonutTray({ glazes });

const action_seed_glazes = action(() => {
  glazes.set([{ name: "maple", bakedAt: now - 86_400_000 }]);
});
```

Run that action as the first step, and assert the seed landed before anything
depends on it — reading the seeded value back, rather than only its absence
from a filtered view, so an unresolved wish fails the test instead of passing
it for the wrong reason.

`resultOf()` is a zero-node projection of the current clock channel, not a
stored seed. A pending or syncing channel parks the action before dispatch;
the action resumes when that input becomes usable. Terminal error or obsolete
inputs settle without dispatch and do not resume automatically. After dispatch, later clock ticks
do not rerun the action or replace the values it wrote into `glazes`. Passing a
computed clock-derived array directly as writable state has different behavior:
each recomputation replaces that array.

### Testing Initial State

```tsx
// Shown inside a pattern body.
// Verify pattern initializes correctly
const assert_initial_count = assert(() => counter.value === 0);
const assert_initial_empty = assert(() => list.items.length === 0);

return {
  [TESTS]: [
    { assertion: assert_initial_count },
    { assertion: assert_initial_empty },
    // ... actions and more assertions
  ],
};
```

### Testing State Transitions

```tsx
// Shown inside a pattern body.
const action_start = action(() => game.start.send());
const action_pause = action(() => game.pause.send());
const action_resume = action(() => game.resume.send());

const assert_playing = assert(() => game.phase === "playing");
const assert_paused = assert(() => game.phase === "paused");

return {
  [TESTS]: [
    { action: action_start },
    { assertion: assert_playing },
    { action: action_pause },
    { assertion: assert_paused },
    { action: action_resume },
    { assertion: assert_playing },
  ],
};
```

### Testing Computed Values

```tsx
// Shown inside a pattern body.
const action_add_items = action(() => {
  cart.addItem.send({ price: 10, quantity: 2 });
  cart.addItem.send({ price: 5, quantity: 4 });
});

const assert_total_correct = assert(() => {
  // 10*2 + 5*4 = 40
  return cart.total === 40;
});
```

## Best Practices

1. **Self-contained test data**: Keep test data inside actions, not external variables
2. **One thing per assertion**: Each assertion should verify one specific condition
3. **Meaningful names**: Names should describe expected state, not implementation
4. **Test edge cases**: Include actions for empty states, boundaries, error conditions
5. **Expose subject**: Return the pattern under test for CLI debugging

## See Also

- [Testing Handlers via CLI](./handlers-cli-testing.md) - Manual CLI testing workflow
- [Pattern Testing Spec](../../specs/PATTERN_TESTING_SPEC.md) - Technical specification
- [Coverage in CI](../../development/COVERAGE.md) - How the pattern unit tests
  run here feed the repository-wide coverage figure
- [Patterns package test lanes](../../../patterns/deno.jsonc) - Where each kind of test (plain Deno unit test, pattern test, integration test) lives in the patterns package and how each is discovered and run
