# Reading Fabric data: one model, several arrivals

This is the umbrella for three concerns that share a model: **the read layer**,
**calls** layered on it, and **the command surface**. Two documents cover them,
since the first two are closely coupled and the third moves on its own timeline.

- [Shaped reads and verb results](shaped-reads-and-verb-results.md) — **the read
  layer, and calls.** How a read decides what to return, and what calling a verb
  adds on top.
- [CLI surface shape](../history/plans/cli-surface-shape.md) — **the command surface.** An
  executed plan, now archived: what the surface was to look like, and the
  additive path that got it there without breaking callers.

Call-specific investigation detail — what produces a receipt and what its
existence proves, how its address is derived, the entity-URI change to
`--piece`, error conventions and sequencing — is collected in
[Verb calls: working notes](verb-result-selection.md). Sketches to draw from,
not a settled contract.

It assumes no prior familiarity with the runtime. If you want the full
background rather than the working vocabulary below,
[the tutorial](../tutorial/README.md) covers cells in chapter 2, what a cell
really is in chapter 8, and storage in chapter 9.

## Orientation

| Term | What it is |
| --- | --- |
| **Space** | A store of data, named by a cryptographic identifier. Everything lives in exactly one space. |
| **Cell** | The unit of state — reactive, durable, and addressable. Behind each is a stored JSON document. |
| **Address** | Where a cell lives: a space, an entity id such as `of:fid1:abc…`, and optionally a path inside the document. |
| **Link** | A pointer from one cell to another, stored inline in a document. Following links is how one cell reaches another. |
| **Pattern** | A user-authored program declaring state and, optionally, callable operations. Components run once to wire up reactive state, in the style of Solid.js. |
| **Piece** | A running instance of a pattern in a space. What you address, read, and call. |
| **Verb** | A piece's callable operation, invoked with `cf piece call`. |
| **Receipt** | The cell the runtime writes when a verb finishes, holding whatever the verb returned. |
| **Schema** | A description of data's shape. Schemas are queries here: the runtime reads one to decide which documents to load and how to treat each value. |
| **Shape** | The schema supplied for one particular read — what this caller wants back. Written concisely or in full. |

Two ideas that carry most of the weight:

**A cell is a point in a graph, not a self-contained record.** Its document
holds values *and links to other cells*. Reading one without saying where to
stop follows those links onward, and onward again, so an innocuous-looking read
can return an enormous amount of unrelated data. That is the whole problem this
work exists to solve.

**Schemas are queries, not type annotations.** This is the schema-on-read
principle the rest of the system runs on: you describe the shape of the data you
want, and that description decides what gets loaded. Reactivity is a
subscription to a query whose selector is a schema, and a read works the same
way — the schema supplied becomes the set of paths fetched, so links outside it
are never followed.

A cell carries a schema and a reader supplies one. They are the same kind of
artifact; what differs is **authority**, not direction. The cell's schema is
authoritative for how a value is treated — whether it comes back as a handle,
what it defaults to, which partition it reads, who may see it. The reader's
selects among what is there.

## The model

**Everything addressable is a cell.** A piece is a cell — the function that
"gets a piece's result" returns the piece itself, and nothing in the read path
checks whether the thing you addressed is a piece at all. A receipt is a cell.
A piece's arguments are a cell, reached by following a link stored in its
document. There is no separate "piece object" behind the address you hold.

**Arrival is plural; reading is singular.** There are several genuinely
different ways to end up holding a cell:

| Arrival | What it does |
| --- | --- |
| `cf cell get --piece <addr>` | addresses a cell directly |
| `cf piece call --piece <addr> <verb>` | runs a verb, then reads the receipt it wrote |
| `cf wish <query>` | resolves a query to whatever satisfies it |
| `cf exec <mountedFile>` | reaches a verb through a filesystem mount and runs it |

None of these should absorb the others — a query is not an address, and running
a verb is not reading. But all four end in the same place: you now hold a cell,
and you want structured data out of it.

That last step — **given a cell and a description of what you want, produce
structured output** — is one operation. The description says which positions
come back as values and which come back as addresses you can use later.

## Why this matters

The last step is now shared: all four arrivals take `--filter`, `--select` and
`--schema`, parse them with one parser, and refuse the same mistakes in the
same words. What follows is the divergence that motivated sharing it — the same
note rendering two different ways depending on how you reached it. Read it from
the board that holds it:

```json
{ "title": "Notes", "body": "…" }
```

Create it with a verb and read it out of the call's result, and its `append`
operation comes along as a raw internal pointer:

```json
{ "note": { "title": "Notes", "body": "…",
            "append": { "/": { "link@1": { "id": "of:fid1:…", … } } } } }
```

Neither behavior was designed. Each command grew its own output handling and
they drifted, which is what one shared read step exists to prevent recurring.

## What the model settles

Three questions dissolve rather than needing answers.

**How deep should a read follow links?** It does not traverse by depth at all. A
read selects by path, so paths outside the selection are never followed however
many hops away they sit.

**What format should a verb's result use?** The one a read already uses. Inside
the result, it *is* a read, on a different cell.

**What makes a receipt special?** Nothing. It is an ordinary cell. One
carrying a plain result declares a descriptive schema like any other cell; one
carrying a reactive result declares none yet, and closing that gap is an open
question of the read layer, not a property of receipts.

## The three concerns

**The read layer.** Given a cell and a description of what you want, return
structured data. What is missing is a way for that description to say "give me
an address here, a value there" — which is what preserves a created thing's
identity instead of flattening it into a copy of its contents. Covered in
[Shaped reads and verb results](shaped-reads-and-verb-results.md).

**Calls, layered on it.** Running a verb writes a receipt; reading that receipt
is an ordinary read. What belongs to the call is the surrounding envelope, safe
retries, collecting a result later, and recovering an address when a response is
lost. Same document as the read layer.

**The command surface.** How commands are named, and how a caller writes
what a command acts on. The plan that settled both is executed and archived as
[CLI surface shape](../history/plans/cli-surface-shape.md).

## What follows from the split

Reads and calls stop blocking each other. The read layer can be settled against
`cf cell get`, which is where the load already is, and calls inherit it rather
than specifying a parallel format.

The command surface stops being a prerequisite. Sharing the read layer between
commands requires no renaming, so the naming and structure questions can be
argued on their own timeline instead of gating functional work.
