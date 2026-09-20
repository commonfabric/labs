# Implementation plan

- [x] Disable ShadowRef/unsafe_ and see what breaks, ideally remove it (will
  merge later as it'll break a few patterns)
- [x] Update Cell API types to already unify them
  - [x] Create an `BrandedCell<>` type with a symbol based brand, with the value
    be `string`
  - [x] Factor out parts of the cell interfaces along reading, writing, .send
    (for stream-like) and derives (which is currently just .map)
  - [x] Define `OpaqueCell<>`, `Cell<>` and `Stream<>` by using these factored
    out parts.
  - [x] Add `ComparableCell<>`.
  - [x] Add `ReadonlyCell` and `WriteonlyCell`.
  - [x] Make `Reactive` a variant of `OpaqueCell` with the current proxy
    behavior, i.e. each key is a `Reactive` again. That's just for now, until
    the AST does a .key transformation under the hood.
  - [x] Update `CellLike` to be based on `BrandedCell` but allow nesting.
  - [x] `Opaque<T>` accepts `T` or any `CellLike<T>` at any nesting level
  - [ ] Simplify most wrap/unwrap types to use `CellLike`. We need
    - [x] "Accept any T where any sub part of T can be wrapped in one or more
      `BrandedCell`" (for inputs to node factories)
    - [x] "Strip any `BrandedCell` from T and then wrap it in Reactive<>" (for
      outputs of node factories, where T is the output of the inner function)
    - [x] Make passing the output of the second into the first work. Tricky
      because we're doing almost opposite expansions on the type.
- [ ] Add ability to create a cell without a link yet.
  - [x] Merge StreamCell into RegularCell and rename RegularCell to CellImpl
    - [x] Primarily this means changing `.set` to first read the resolved value
      to see whether we have a stream and then use the stream behavior instead
      of regular set.
  - [x] Change constructor for RegularCell to make link optional
  - [x] Add .for method to set a cause (within current context)
    - [x] second parameter to make it optional/flexible:
      - [x] ignores the .for if link already exists
      - [ ] adds extension if cause already exists (see tracker below)
  - [x] Make .key work even if there is no cause yet.
  - [x] Add some method to force creation of cause, which errors if in
    non-handler context and no other information was given (as e.g. deriving
    nodes, which do have ids, after asking for them -- this walks the graph up
    until it hits the passed in cells)
  - [x] For now though throw in non-handler context when needing a link and it
    isn't there, e.g. because we need to create a link to the cell (when passed
    into `anotherCell.set()` for example). We want to encourage .for use in
    ambiguous cases.
- [x] Add space and event to Frame
- [ ] First merge of Reactive and RegularCell
  - [x] Create OpaqueCell type
  - [x] Make Reactive a proxy around OpaqueCell
  - [x] Add methods to Cell that allow linking to node invocations
    - [x] `setPreExisting` deprecated
    - [x] `setDefault` deprecated
    - [x] `setSchema` is tricky (asSchema is cleaner). Let's support it for now,
      but only if the cause isn't set yet.
    - [x] `connect` copy over and add a direction field, so can distinguish
      where this node is used as input vs where the passed node is an input to
      this node.
    - [x] `export` make the analogous version, if link is present use that as
      `external`.
    - [x] `map` and `mapWithPattern`: Copy over
    - [x] `toJSON` return `null` when no link otherwise what Cell does.
  - [x] No need for `toReactive` anymore, since all cells are now also
    Reactive. So remove all that.
  - [x] Call that for returned value in lift/handler, with a .for("assigned
    variable of property", true)
  - [ ] For now treat result as pattern, but it should be one where all nodes
    already have links associated with them (no internal necessary).
- [ ] Add tracking for used causes and created cells in contexts, when popping
  context write those down, with schemas used.
  - [ ] Set `source` in context, so that created cells copy it and write it as
    metadata.
  - [ ] Keep track of all created cells, make sure to track those as well for
    the pattern creation in lift/handler, so we don't need to return them in e.g.
    a handler.
  - [ ] Add a helper for cause generation that checks that no other created cell
    already has that cause.
- [ ] In lift/handler, change how patterns are invoked to directly go off the
  created graph.
  - [ ] For each created cell (as that's always the case when introducing a
    reactive node), schedule it, unless it didn't change (see next task)
  - [ ] Remember all scheduled nodes by result link, so we don't need to restart
    if there was no change.
  - [ ] Write metadata into result cell of the lift,
    - [ ] source, coming from context
    - [ ] `process`:
      - [ ] the `Module`, which includes the `Program` (as link, using
      `cid:hash` and maybe using `cid:hash` links for the individual files as
      well)
      - [ ] (P2) the created cells with link to module and/or schema (can leave schema off if it's same as module)
      - [ ] (P2) keep a history of previously used ones, we'll eventually need
        this for safe updating on schema changes
- [ ] Change lifecycle of patterns so that they are run like a lift, with an
  Reactive already tied to the arguments cell as input.
  - [ ] This should allow us to remove the JSON pattern representation
- [ ] Add `Cell.for(cause)` cell factory, replacing
  - [ ] `cell` and
  - [x] `createCell`.
- [x] Have `Cell.set` return itself, so `Cell.for(..).set(..)` works
- [ ] `cell.assign(otherCell)` applies `cell`'s link to `otherCell` if it
  doesn't have one yet. Useful to make self-referential loops.
- [ ] In AST transformation add `.for(variableName, true)` for `const var =`
  cases
- [ ] Update JSON Schema to support new way to describe cells

## Random nits

- [ ] Rename `.update` to `.updateWith`
  - [ ] Consider .update with a function callback, but not sure how useful that
  is.
- [ ] Add `.remove` and `.removeAll` which removes the element matching the
  parameter from the list.
- [ ] Add overload to `.key` that accepts an array of keys
- [x] Make name parameter in pattern optional

## Planned Future Work

- [ ] **First-class serializable factories** (see the
  [specification](./node-factory-shipping.md) and
  [implementation plan](../../plans/first-class-serializable-factories.md))
  - [ ] Extract generic `$patternRef` binding/setup behavior independently of
    graph snapshots and reactive-interpreter work
  - [ ] Make pattern, module/lift, and handler factories directly branded
    `Factory@1` `FabricValue`s
  - [ ] Add factory schemas, symbolic invocation, and generic cold resolution
  - [ ] Add nested-pattern closure conversion with a separate params root and
    one transformer-only `.curry(params)` operation
  - [ ] Replace `patternTool` consumers with inline wrapper patterns and retain
    compatibility reads

## Open Questions

### Type System Questions

- Should Opaque be a flag, or is it inferred from read, write and stream being
  false?
  - What's necessary for .equals() to be available? Should we make a new cell
    type just for that (useful to just reference an item, don't read or write,
    but also with the link itself not being opaque)
- How should we handle streams vs the former `{ $stream: true }` behavior?
  - Settled: the schema of the links that reach a stream declares it, the
    owning piece's manifest link among them; the stream's own document holds
    only its back-link (`docs/plans/stream-markers-out-of-stored-data.md`).
    What's the override rule? We can't turn a non-cell link into a Stream<>,
    so it should just be for narrowing.

### Implementation Clarification Needed

- **What actually breaks when ShadowRef/unsafe_ is disabled?** (Task line 3)
  - Need to run the experiment to see what fails
  - This will inform how we approach the migration
- **What does "adds extension if cause already exists" mean?** (Task line 24)
  - Need to clarify the extension mechanism for the flexible `.for()` parameter
  - How does this relate to the cause tracking work (lines 39-46)?
- **What is "First merge of Reactive and RegularCell"?** (Task line 33)
  - This seems like a major milestone - needs clearer definition
  - What specifically gets merged and how?
- **What does "treat result as pattern" mean?** (Task line 37-38)
  - Need to clarify what "pattern" means in this context
  - How does this differ from normal cell results?
- **Where is AST transformation implemented?** (Task line 69)
  - Need to locate existing AST transformation code
  - Should there be a spec for this work?

### Lifecycle and Runtime Questions

- What should happen with orphaned cells on pattern updates?
  - E.g. a lift previously wrote into x and now it now longer does, because the
    code changed
  - Ideally we know enough about `x` to be able to write a redirect into
    whatever the new thing is, but this is only useful if there are any links to
    it
  - So we could do that lazily when that is read
  - Its `source` already points to lift result cell
  - Keep a list of previously used ids in the metadata?
- What to do with `cell.key("foo").assign(otherCell)`?
  - That's closer to how in regular JS one would make a circular reference work
    (pass foo = {} to first function, assign output of second function to
    foo.bar)
  - It should result in a writeRedirect being written into `cell` and path
    `foo`. So maybe that's what we need to keep track of and do on runs
    - Maybe a link is sufficient as the destination isn't mutable anyway. Should
      the link be mutable, breaking the cycle, if that's indeed what we meant?
      But also, it's part of a reactive flow, so it should be expected to be
      overwritten again at any point
  - How is this different from .set? It works on opaques!
- What cause should we use in Cell.set(opaque)?
  - That should mean that cell.set(opaqueCell) triggers the opaqueCell creating
    a link
  - Interestingly, we call that from within normalizeAndDiff, which has extra
    context, e.g. the cell we set this to
  - Should we use this? It's conceptually equivalent to
    cell.set(opaqueCell.for(cell))
  - In a handler it feels right, but is also unnecessary. Should we error in a
    lift or just derive it from the source? If the latter we get a bunch of
    orphans, and this is so rare, that I think we should error
  - = Let's error for now and see how it feels
