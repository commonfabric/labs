# References as arguments

## The short version

**A pattern handler that declares a reference should accept one — a live
read/write cell — from any external caller. Today a model and the CLI can
pass one:** the LLM dialog builtin resolves `{"@link": "…"}` into a live cell
before dispatch (`traverseAndCellify`), and the CLI's dispatch gate accepts
the link envelope and converts the address a read emits into it, reading
reference positions off the declared contract
([verb input contract](../history/plans/verb-input-contract.md)) — refusing, at those
positions, the shape-matching payload that would have **stored a detached
copy instead of an edge and reported success**. The webhook and ingest paths
reach the same handler and still resolve nothing — the payload goes through
unresolved.

**The fix:** move that resolution to the boundary every external caller
crosses, and give the outer gates the link acceptance the dispatch gate already
has. Medium work, mostly relocating code that already runs in production. The
CLI's half is done — its gate accepts the envelope (#5880) and converts the
emitted address — so what remains is the webhook and ingest half.

**One constraint, not a second decision:** what is accepted inbound has to
include the shape a read already emits. Otherwise a caller still cannot submit
the address it was just handed, and the capability does not compose. The CLI
satisfied it by converting that shape into the envelope at its gate.

**Not a confinement decision — the runtime already took a position.** The
dispatch-side closed-world gate accepts a link value opaquely and defers its
schema check to the handler's own reads (`closedWorldEventRejection`,
`packages/runner/src/runner.ts`, via its `acceptOpaqueValue: isCellLink`
option). The CLI's pre-dispatch gate passes the same option since #5880; the
webhook path has no gate at all. The remaining refusal is drift between that
path and the gate it feeds, not policy. CFC gets a heads-up — an existing
capability widening to external principals — not a ruling to wait for.

**Independent of all of it:** refusing the structural copy, instead of storing
it, needs no encoding decision and no gate change — and the CLI now refuses
it at every declared reference position.

The rest of this document is the evidence for the paragraphs above.

## The team already needed this and already built it

`traverseAndCellify` (`packages/runner/src/builtins/llm-dialog.ts`) walks an LLM
tool call's input, finds `{"@link": "…"}`, and resolves it through
`runtime.getCellFromLink()` before dispatch. Its output becomes
`invocationArgs`, which goes into the `handler` branch's stream send. Its
counterpart `traverseAndSerialize` renders cells *out* in the same shape, so
the LLM boundary has a complete round trip: a model is handed an address and
can hand it back.

That is proof of need from inside the codebase. Somebody hit this wall on a
surface that matters and built the resolution rather than working around it.

**The problem is where it lives.** It sits inside one builtin, so it serves one
consumer. Every other caller that crosses the same serialized boundary is
second-class:

| Consumer | Can pass a reference? |
| --- | --- |
| LLM tool call (`llm-dialog`) | **yes** — `@link`, resolved before dispatch |
| `cf piece call` | **yes** — the link envelope, and the emitted address converted against the declared contract at the dispatch gate |
| Webhook POST (`sendToStream`, `packages/toolshed/routes/webhooks/`) | no — the raw payload is sent unresolved |
| [Ingest channels](ingest-channels-journal-sink.md) | no — builds on the same dispatch |
| `cf exec` and the FUSE projection | **yes** — JSON in, the same gate as `cf piece call` |

The same handler, reached two ways, accepts a reference from one and not the
other. Nothing about the verb differs; only the door the caller came through.

### Why the round trip is a constraint rather than a preference

Two spellings of an address are already in use:

| Spelling | Where | Direction |
| --- | --- | --- |
| `{"@link": "…"}` | `llm-dialog` | in **and** out |
| `{"$link": "/[@did/]<id>[@scope][/path]"}` | shaped reads ([shaped reads](shaped-reads-and-verb-results.md)) | out only |

Both carry the canonical reference string, so the address a caller reads is one
`--piece` already accepts. The CLI's dispatch gate now accepts it as a verb
argument too, converting it against the declared contract — which is what makes
the capability compose, and is the property
[CLI surface shape](cli-surface-shape.md) already states for commands. The
callers that still cannot pass one in are the webhook and ingest paths, which
reach the same handler through no gate at all.

## What this cost when it was measured, and where that cost remains

The original harm was not "you cannot do this yet" but the boundary
**accepting a wrong payload and storing the wrong thing** — a shape-matching
copy settled, reported a plausible result, and stored a **detached copy
inside the caller's own document**, with nothing reporting an error. Measured
addresses and reproduction:
[#5560](https://github.com/commonfabric/labs/issues/5560).

At the CLI that table now reads:

| Payload | Result at a declared reference position |
| --- | --- |
| the address a read emits (`/of:…`) | converted to the link envelope; the edge lands on the target |
| the runtime link envelope | accepted (#5880); the edge lands on the target |
| the `{"$link": "/of:…"}` object a marked read renders, alone or with projected contents beside it | converted as the address inside it; the edge lands on the target |
| a string in no address form | refused naming the position and the `/of:…` form |
| a literal shape-matching object | refused — an inline copy would store a detached document |

The webhook and ingest paths still take the original table: the raw payload
goes through unresolved, and the detached copy is still stored as success.

The verbs this reaches are not hypothetical. Every event field across the
shipped patterns that declares a reference:

```text
addPiece     Stream<{ piece: MentionablePiece }>
addPiece     Stream<{ piece: Writable<MentionablePiece> }>
addPiece     Stream<{ piece: Writable<RecordPiece> }>
appendLink   Stream<{ piece: Writable<MentionablePiece> }>
removeEvent  Stream<{ event: EventPiece }>
removeItem   Stream<{ item: DoItem }>
removeItem   Stream<{ item: ReadingItemPiece }>
removeItem   Stream<{ item: TodoItem }>
```

Every one is *put this existing thing here* or *take this existing thing out* —
the class of operation that must name something that already exists. The
sharpest is the root pattern's, since every space has one:

```bash
$ cf piece call --piece <root> addPiece '{"piece":"/of:fid1:…"}'
```

`pieces.add` sends to that exact stream from inside the runtime. An LLM can
invoke it, and so can the CLI — the address as printed, at the position
`addPiece` declares. A webhook still cannot.

## What is missing

**Resolution at the shared boundary rather than per consumer.**
`traverseAndCellify` is the working reference implementation; what it needs
is a home where every caller reaches it. The CLI settled its own half — its
pre-dispatch gate passes the `acceptOpaqueValue` option the dispatch gate
passes (#5880), and converts the emitted address one gate earlier — but that
conversion lives in the CLI, so the webhook and ingest paths still forward a
payload unresolved.

**The schema questions this document once held open are ruled.** Which of a
verb's two event schemas is the input contract — the body's usage summary or
the authored event — was decided for the authored event
([verb input contract](../history/plans/verb-input-contract.md)), and emission now serves it:
a declared reference field the body never reads stays in the served
`properties` and `required`, carrying the capability its usage earned as its
`asCell` marker. Resolution at the CLI became schema-DIRECTED off that
contract — the marker names the positions to convert at, and a typo'd
payload is refused rather than resolved — while the runtime's own dispatch
gate remains schema-blind (`closedWorldEventRejection` passes a link value
opaquely in any declared position). A boundary that adopts resolution for the
webhook and ingest paths chooses between those two proven shapes; the
contract ruling means the schema-directed one is available everywhere the
compiled pattern is.

## Size

**Medium**, and most of it landed. The emission change shipped with the input
contract's `contract` mode in
`packages/ts-transformers/src/transformers/schema-injection.ts`, the gate
alignment was one option at one call site (#5880), and the CLI's address
conversion rides its dispatch gate. What remains — resolution the webhook and
ingest paths reach — is a lift-and-share of existing, exercised code. Nothing
durable is written, so it reverses by assignment rather than migration.

## The refusal is drift, not policy

At what layer are references disallowed? None of them chooses to. The layers
disagree, and the innermost one already ruled in favor.

**The dispatch-side gate accepts links.** `closedWorldEventRejection`
(`packages/runner/src/runner.ts`) validates a present event payload with
`acceptOpaqueValue: (value) => isCellLink(value)`: a link value passes
unjudged, because its target cannot be read at dispatch and its schema check
belongs to the handler's own reactive reads. The same gate works out how to
stop a caller smuggling undeclared *keys* through links without ever banning
link *values*. That is a considered position on exactly this question, taken in
the layer most careful about what a caller may submit.

**The CLI gate is the same validator, aligned since #5880.**
`verbInputSchemaError` (`packages/cli/lib/callable.ts`) calls the identical
`validateSchemaValue` and now passes `acceptOpaqueValue`, so a link envelope
passes it opaquely — and one gate earlier, the emitted address is converted
into that envelope against the declared contract. Its purpose is unchanged:
refuse a malformed payload before it spends the invocation id.

**The webhook path takes no position.** `sendToStream`
(`packages/toolshed/routes/webhooks/webhooks.utils.ts`) forwards the raw
payload with no gate and no traversal.

**And "data cannot name a cell" is not a core invariant — measured.** A sigil
link is a link wherever it appears in stored data (`isLinkRef`,
`packages/data-model/src/cell-rep.ts`), and a sigil riding an event payload
survives `send()` as a **live edge**: probed against a local toolshed with an
`any`-typed event field, so no gate intervened, the handler received the
resolved target — its own properties, and its `title` read back. The door is
already open under the native spelling, so this plan names a capability rather
than adding one.

That also bounds what the gate change alone bought. The CLI's gate was the
only thing between a sigil payload and a `send()` that already resolves it,
and aligning it made the native spelling work end to end — confirmed against
a declared field: the edge that lands is the target, read back by address.
Shared resolution now serves the *other* callers, which is composition rather
than basic capability.

What remains for whoever owns CFC is a notification, not a ruling: opening the
outer doors widens an existing exposure — an external principal, not just the
user's own model session, gets to name an address a handler will act on with
its own authority. They should hear that and can object. But the precedent this
change extends is the runtime's own gate, not a workaround.

## What is correct regardless

Refusing a structural copy where a reference is declared stands on its own: no
new vocabulary, no encoding decision, no gate change. The CLI's refusal now
converts that silent corruption into an error; a boundary resolution for the
remaining callers owes the same refusal beside it.
