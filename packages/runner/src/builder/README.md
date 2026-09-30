# Pattern DX

When creating patterns all cells are really proxies for future cells. They can
be nested and assigned to each other.

## Internal structure

`pattern` creates an internal representation, which is effectively:

- the default value for the cell representing the pattern
- initial values, usually constants or bound data structures like the UI
- nodes, which are defined by
  - module
  - input cell expressed as bound data structure
  - output cell expressed as bound data structure, if any

Bound data structures, which are also used for UI, are static data, where some
fields can be cell proxies. For the pattern, it is both inputs and outputs and
aliasing within the cell is allowed (loops are not, of course). For module
inputs, the idea is that when the pattern is run, the data is collected from
those cells. For module outputs, the result is effectively destructured into the
corresponding cells.

When invoking a pattern from another pattern, the graphs can be combined: The
pattern cell is being created, with the default values optionally overriden by
cell aliasing to the caller cells.

## Aliasing cells

```ts
const { foo, bar } = patternCell;
const { baz } = example({ bar });
foo.set(baz);
```

Means that the key 'baz' on the output of `example` should be assigned to
`patternCell.foo`. We can do this in a few ways:

- Create another subpath on `patternCell` for the output of `example` and do an
  internal path alias.
- On the `example` node, add an annotation of where data should flow, i.e. the
  reverse binding above, here `{ baz: patternCell.foo }`.

For now, we just assign a default cell and reference "forward". Later we could
do a pass to optimize these away somewhat.

---

When invoking a pattern, the following steps happen:

- The pattern is invoked with the cell it should populate (almost always that's
  a new cell, prefilled with references to inputs)
- Default values are populated, unless there is already something there
- Initial values are populated, overwriting what is there already
- Nodes are registered with inputs as assumed dependencies
- Run loop:
  - Events are dispatched, which will mark cells dirty
  - Effects (e.g. UI rendering) mark cells dirty, and the graph is walked up
    until the end is reached. The first time this is on declared cells,
    afterwards on actually used ones.
  - All involved nodes are topologically sorted.
  - Repeat until no cells are dirty or a fixed number of maximum iterations have
    been completed.

Note: Since the graph is flatted after resolving all patterns, etc., only UI
rendering will cause computation. We will need some other way to trigger
computation for slow jobs / imports / etc.

---

There are two levels of indirections for cells:

- The aliasing at pattern level, which is as static as the pattern (i.e. an
  inner module can't rewire the aliases)
- The cell references in the data itself, which can be overriden.

As an example: Say a pattern is invoked, and a cell bound to `a.b` in its
namespace. A module write into `a` will also write into that bound cell (the
value of `a.b` or `undefined` otherwise). The value of `a.b` can be a cell
reference itself, but then that reference is written into the bound cell.

`a` can't be a cell reference though: The path to any aliased cells must be
static. This means in practice that we don't want to go too deep in the nesting
when aliasing. Usuall it is either top-level or one level deeper for an open
ended set to not pollute the top namespace (e.g. `template` at the top level and
then `vars.foo` and `vars.bar` for the template veriables). A module could in
principle modify individual `vars` and some of those might be local to the
pattern, but a module can't change `vars` itself to point somewhere else.

IOW, all properties up-path from aliases are readonly to modules. They can
however be cell references themselves, just created by the runtime, and
typically to seperate cells that are changed at different times (this might just
be an intermediate optimization, depending on how the runtime and the storage
layer evolve).

When a module is invoked, we do another round of path following, and this is
where cell references in the data are resolved, often lazily. Modules are
reactive to the last data read (and called with the initial cells the first
time).

Is changing references allowed? Yes, but we have to be careful with the reactive
nature: Are we rewriting a path, and now listen to other parts? Say a module
reads `{ foo: { bar: ... } }` and writes a different cell reference for `foo`.
In principle, if `bar` has never been read, we wouldn't listen to changes just
on `bar` (assuming the reference `foo` remains the same). But by definition none
of the other values could depend on that `bar`, so this should be fine: At this
level, i.e. beyond what the pattern marks read-only, modules can change cell
references.

To summarize the implications for the implementation:

- Write cell references into the data, and resolve them lazily
- For pattern-level aliases mark those and all the paths ahead as read-only
- When writing a cell reference to such a cell reference, make it two levels
  deep, otherwise overwrite. In fact this go several levels deep, as a pattern
  can call another pattern pointing to a cell reference. So this just reflects
  layers of aliasing. Though all but the last are static!

### Streams

A cell path whose schema declares `asCell: ["stream"]` is a stream; the builder
stamps that declaration on the stream's descriptor and on every alias that
reaches it, and nothing is stored at the path. Values written into that location
won't be stored, but instead immediately sent to the scheduler to be queued up.

The scheduler will invoke each handler tied to that location in turn, always
waiting for at least one round of computation to settle between calls. That way
no event should be lost, as long as it is translated into a state change
captured by a cell.

Handlers are called exactly once per event. If they read from other cells,
changes to those don't trigger a new call. When they write to cells, those are
marked dirty, but they aren't added as dependencies for the topological sort,
since anyway the only time they are called is at the top of the transaction
cycle when a new event is queued.

We currently only support simple event handler for one event.

Right now, only `handler` returns these "streams".
