# Shuttle — futures

Satellite of [`README.md`](README.md): the trajectory past v1.
Nothing here is v1 scope and nothing is a commitment to build order. The
positions are taken now so that later features land coherently with the
settled decisions; the candidates are ranked leads, to be ruled when their
turn comes.

## Positions

**Configuration lives in the fabric.** Command aliases and shuttle
preferences belong in a piece under the user's profile, not in a dotfile:
they then follow the user to any terminal, including the eventual hosted
one with no local disk — the same portability constraint the
native-versus-escaped pipeline split already serves. How the first
connection bootstraps before configuration loads is the open detail.

**Bookmarks are favorites.** A local bookmark file would be a
shuttle-private naming layer, which decision 13 forbids — and the fabric
already has named entry points. A `bookmark` verb writes through the wish
machinery to the user's favorites, and `cd #<name>` is already the
spelling that reaches them. Bookmarking is a fabric feature shuttle uses,
not a shuttle feature.

**The session scope is the variable store.** `@session` scoped cells are
per-user, per-session, durable, inspectable, and reactive — and redirects
already write values into the fabric, so
`get big --filter … > scratch/result@session` is assignment. A `$name`
spelling can be pure sugar over a session-scoped scratch area. Shuttle
adds spelling, never a private interpreter heap: script state is then
debuggable by the same acts as any other state. Where the scratch area's
home piece lives is the open detail.

**Scripting comes in three layers, and stops there.**

1. Linear command files: `shuttle -c '…'` and `#!/usr/bin/env shuttle`
   scripts (the `cf exec` shebang is the precedent). No control flow.
2. Real programs: the seams shuttle calls are importable libraries, so
   control flow means a TypeScript file using the same API — perhaps
   `run script.ts` handing it the ambient record. Shuttle never grows a
   script language of its own.
3. The stance underneath: recurring automation that lives with the data
   belongs inside the fabric as a pattern or verb — reactive, durable,
   shareable. Scripting is for driving the fabric from outside.

The scripting bundle is also the agent door the non-goals hold open:
stable machine-readable output, exit-code discipline, and deterministic
non-TTY behavior (no views, no strip) arrive with it, not before.

**A slow call's outcome collects in the fabric, not in a shuttle job table.**
The identity half is already shuttle's: one invocation session is minted at
startup and passed explicitly into every `call`, which mints an id under it
(decision 6, [`runtime-integration.md`](runtime-integration.md)). Replaying that
pair deduplicates against the receipt the handling wrote: the commit lands once
and the original outcome settles the retry, though the body runs again and
repeats whatever effects it has outside its transaction. Where no receipt was
written — a handling that failed, or a deployment not writing them — there is
nothing to collide with, and the replay executes and commits again. What v1 has
no spelling for is the wait half: `cf`'s `--wait <seconds>` patience bound, and
its `--no-wait`, which exits at the commit acknowledgment carrying the receipt's
address (`resolveWaitControl`, `packages/cli/commands/piece.ts`). Both belong at
shuttle's `call` when a slow verb makes them worth typing, and collecting a
detached outcome is then an ordinary `get` of that address: no second read path,
and the handler does not run again.

One fact bounds how far that goes. The handler runs in the calling process,
which is why even a detached call awaits its own commit. A shuttle that exits
mid-call abandons work, and the invocation id makes the retry safe rather than
the abandonment lossless. So a backgrounded call here is a line shuttle keeps
running while the prompt goes on reading keys — which B1f's event loop already
allows — and never a call that outlives the process.

Where outcomes collect while nobody is watching is a fabric question rather than
a shuttle one, on the same stance the session scope takes above: shuttle adds
spelling, never a private store. A receipt is addressed from the event id and
the handler's bound closure, so the caller collects it from the address the call
published and nobody enumerates them; listing what settled since a person left
needs the retention collection
[`../pattern-verb-contract.md`](../pattern-verb-contract.md) designs and has not
built. Shuttle's own collector is `watch`: a verb whose result lands in a
watched cell announces itself through the event lines B3 builds, and candidate
6's `--bell` and `--notify` carry that to someone who stepped away. The open
detail is whether an armed watch on a detached call's receipt earns a spelling
of its own, or whether `watch <receipt>` is already it.

**A place's space is safe by its alphabet rather than by a guard.**
`renderPosition` (`place.ts`) writes the space into what `pwd` and `where`
show without holding it to the class a terminal acts on, and `isDID`
admits that class — it asks for a `did:` prefix, a second colon, and a
length. The guard is absent, and deliberately so. What stands in its place
is where a space comes from: a place is built on the DID an opened
connection reports, and a `did:key` is base58btc, an alphabet with no
character in the class. A DID method with a wider alphabet is what ends
that, and it is worth noticing when one arrives, because the guard becomes
necessary at exactly that moment and neither way of adding it is free.
Glyphing the space costs `pwd` being complete and pasteable; refusing it
widens what the doors admit. Each is a ruling to take against a case
somebody can reach, and the alphabet is why there is none to take it
against today.

## Deferred from v1, design settled

Each of these was ruled during the v1 design and then deferred past v1 to
keep the first build small. The designs are settled — recorded here so
they are re-scheduled later, never re-litigated — and the main document's
decisions point here where they defer.

- **A live view of a piece.** A frame carrying what a piece is — its
  arguments, a summary of its result, its callables with their doc
  annotations, and its pattern identity — and keeping it current as the
  piece computes. Those four are what `describe` writes and what
  [`views.md`](views.md) names, and a view that carried fewer would be a
  reading of its own rather than that one made live. What `describe`
  writes is that reading already, so what is deferred here is the
  liveness: a piece is many cells, and watching one frame's worth of them
  is the seam question issue
  [#6534](https://github.com/commonfabric/labs/issues/6534) carries for
  the list view. Open: whether a frame over a whole piece subscribes per
  cell or over the document, and what it shows for a cell that has not
  settled.
- **Narrowing inside a view.** A key that shows only the part of what is
  on screen that matches, beside the `/` that finds. It waits on a
  narrowing shaped to the data: `--filter` takes arrays today, and a
  rendering of a value is a tree, so the question is which shapes are
  worth narrowing and what a narrowed tree reads back as. Whatever answers
  it answers for every surface that reads, not for a view alone — a view
  that narrowed its own drawing would hand back something that is no
  longer the value's rendering ([`views.md`](views.md)).
- **The pinned strip.** A reserved region above the prompt renders armed
  watches' current values live while scrollback flows past. Event lines
  carry the arm-then-act loop in v1; the strip returns when watch density
  demands it. Open: its height, and what it shows when more watches are
  armed than fit.
- **Cold-browse mode.** Walking around with no computation: reads serve
  stored state, labeled as such, with the mode unmistakable in the prompt
  and every view, toggled as a `where` mode dimension. It insures against
  a warming cost not yet observed; reaching-in-warms already leaves merely
  listed pieces cold, which is v1's whole run-state story.
- **The native tool set.** Published names that work bare in a pipeline
  and are guaranteed wherever shuttle runs — a native tool may start as a
  forward to a local binary; that is implementation, not contract. The
  v0 list: `jq`, `grep`, `wc`, `head`, `tail`, `sort`, `uniq`, `cut`,
  with `cat` deliberately absent (`get` prints, `< file:…` feeds, and
  concatenation waits for a demand). Until the set ships, bare `|` is
  reserved and its error names `|!`, so nobody learns an invisible local
  habit v1 would have to unteach.
- **`where` editing the heavyweight dimensions.** Switching api endpoint
  or identity mid-session, rebuilding the connection and saying so. v1
  fixes them at launch, the space too (decision 22) — restarting is the
  switch — which also honors the one-connection-per-process limit the
  seam work records.
- **The `fuse/` facet.** The FUSE layout mirrored at the space root, for
  mutual legibility between the two tools. Shuttle reuses `packages/fuse`
  naming and hydration work regardless; the facet is the presentation
  half, and it waits.
- **Fabric-to-fabric redirection.** `get topics/3 > drafts/copy` as a
  value copy, with `link` remaining the only reference-writer. The plane
  grammar — bare relative operands are fabric, schemes are explicit — is
  settled and v1 grammar; the copy itself waits for a demand.
- **`https:` read ends.** The scheme family is open by design; `file:` is
  its v1 member, and `set x - < https://…` joins when a use rules it in.
- **`search`.** A `search <query>` verb at any place, over what stands
  below it. Pipes over `ls` cover the interim.
- **A canonical output form.** A second form for everything shuttle prints:
  RFC 6901 pointers, no shuttle quoting, exactly what `cf` parses. `pwd`,
  `ls` and `get` all print, so the fork is a dimension of the output rather
  than one verb's flag, and the switch is a `where` dimension — the form is
  an ambient property of the whole run, and `where` is the ambient record's
  one surface (decision 22). It arrives when a caller exists to want it, and
  the scripting bundle above is where one does: stable machine-readable
  output is part of that bundle rather than of the interactive surface.

  One property it inherits and one it decides. It inherits the doors'
  refusals ([`grammar.md`](grammar.md)): a name is refused for what a
  rendering of it reads back as, and this form renders the same names, so it
  is refused the same ones. What it decides is the glyphing, and the reason
  is what this form is for — it exists to be parsed rather than read, and a
  character shown as the glyph naming it is not the character `cf` would
  parse back. That is the question B4 meets first, in a rendering with a
  second destination ([`build-sequence.md`](build-sequence.md)), and this
  form reaches it for the same reason rather than for one of its own. What
  the interactive form does today is settled: a message is glyphed and a
  serialized value keeps JSON's own spelling, which it can because
  `JSON.stringify` already writes `\uXXXX` for C0 and leaves only `DEL` and
  C1 to finish.

  A second property, and this one it supplies rather than inherits: a value
  the interactive form loses without a word. An `undefined` or an interned
  symbol under a key loses the key, and either of them at an array index is
  written `null` — the first reads as a key the fabric does not hold, the
  second as a value it does, and a cell holds every one of them
  (`prompt.ts`). The interactive form cannot close that, because a tag
  standing where the value was would stop being JSON somebody can paste back,
  which is what its escaping exists to keep (`place.ts`). This form makes no
  such promise, so it is where a spelling for them belongs, and the storage
  codec already has one to borrow: `Undefined@1` beside the `BigInt@1` that
  `get` writes as `$bigint` today (`packages/data-model/src/codec-json/`).
- **Vim keybindings, as a `where` dimension.** Modal editing at the prompt,
  an option and never a default. What it costs is a second binding table
  over motions the line editor already drives, plus the mode the table
  switches on — which is what B1c's choice of substrate buys, and why that
  choice is recorded with B1c rather than here
  ([`build-sequence.md`](build-sequence.md)).
- **Which space a piece is in.** Naming the space that holds an arbitrary
  piece, rather than the one the place stands in. It is a query over the
  fabric and not a dimension of the ambient record, so it arrives with
  multi-space sessions (candidate 3) and takes its answer from them. v1
  refuses to follow a reference into another space — denoting is not
  reaching ([`grammar.md`](grammar.md)) — so the only space v1 could ever
  name is the connected one, which `where` already prints.

## Candidates, ranked

1. **The weaver bridge.** `cd <weaver-URL>` lands in that piece one layer
   down; a `weaver` verb emits the URL for the current place (or a
   handle: `weaver %3`) to jump a layer up. The route grammar is already
   in the prior-art table as mutually translatable; this makes the
   two-layer story concrete in both directions.
2. **Write guards.** Cold-browse mode is compute-cold, not write-safe. A
   `where writes off` dimension, and per-space protection — shuttle
   refuses writes to a marked space until explicitly armed — encode the
   local, rehearsal, production discipline into the tool.
3. **Multi-space sessions.** Per-space controllers behind one prompt, so
   `cd` can cross spaces and home-anchored wish targets can be followed.
   Not yet designed: it needs the per-process module globals the seam
   work records scoped per connection, and a controller lifecycle per
   space. Until it lands, one shuttle process serves one space,
   restarting is the space switch, and cross-space references are
   refused with the reason.
4. **History and records.** Persistent, searchable command history; a
   `record` verb writing the transcript to a `file:` target or into the
   fabric. The recall `up` and `down` give is v1 and is over one run's own
   lines (decision 29); what waits here is the half that outlives the
   process. The event-line design already makes transcripts evidence; this
   makes them saveable.
5. **Time and diff.** `history <ref>` and `diff` across time or between
   references — the state inspector's reconstruction machinery is the
   offline prior art — plus a modest `undo` that writes back what the
   session last saw, honest about concurrent writes.
6. **Small muscle memory.** `pushd`/`popd` on the place stack;
   `watch --bell` and `--notify` (local side effects, marked as such); an
   opt-in `--resume` restoring the user's own last ambient record — which
   is not the persisted cross-process ambience the non-goals rule out,
   and the line between the two is drawn here on purpose: resume hands
   one shuttle its own past, never another tool the session's present.
   And a colored prompt, to tell a command from its output in
   scrollback: the escapes are zero-width, so every width computation
   on a painted string goes through `visibleWidth`, or the cursor
   arithmetic that reads terminal columns rather than code points lands
   in the wrong one at a wrap.
7. **Completion that walks a path.** Completion is place-relative: it
   offers what stands where shuttle stands, so a path typed into a target
   — `get %1/zones/0/n` — completes nothing, which is exactly when a
   person most wants it, the segments being unguessable. Making it
   operand-relative means resolving a partial operand and listing under
   it. The question to rule first is whether completing across a handle
   **substitutes** it: `%n` is a reference only until the next listing
   (decision 17), so a line still carrying `%1` says less than it seems
   to — and rewriting two characters into a sixty-character handle is a
   worse line to read and to edit. A third reading resolves the handle to
   find candidates without rewriting what is shown. Whatever is ruled
   holds for every verb taking a path operand, `get`, `set`, `edit` and
   `link` alike; a completion rule with one exception is one that drifts.
