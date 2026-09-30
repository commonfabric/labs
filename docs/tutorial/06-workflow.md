# Chapter 6 — The Development Workflow

You now know the language; this chapter is the toolchain. The loop is:
**sketch → check → test → deploy → drive**, all through the `cf` CLI
(run as `deno task cf ...` from the repo root). Keep this chapter open while
you build your first pattern.

## Check: the fast inner loop

```bash
deno task cf check pattern.tsx                 # compile + execute once (quiet on success)
deno task cf check pattern.tsx --no-run        # typecheck only (fastest)
deno task cf check pattern.tsx --show-transformed   # print the compiled output
deno task cf check pattern.tsx --verbose-errors     # more error context
```

`cf check` runs the full compiler pipeline (Chapter 7) and instantiates the
pattern once, so it catches both type errors and graph-construction errors
("reactive reference outside context", handlers in the wrong scope, ...).
`--show-transformed` is your X-ray: when behavior is mysterious, look at
what your source actually compiled into before theorizing. The transformed
output is dense — pipe it into `cf view`, an interactive syntax-aware pager
that colors builders, schemas, and closures and lets you navigate the
structure tree:

```bash
deno task cf check pattern.tsx --show-transformed --no-run | deno task cf view
```

## Set up identity and server

You need a running server and a key. For a local server, see
`docs/development/LOCAL_DEV_SERVERS.md` (short version: there's a task that
runs Toolshed on `localhost:8000`; use `dev-local` for the shell, not
`dev`). Then:

```bash
# Create a unique dev key. Redirect from `deno run -A packages/cli/mod.ts`,
# never `deno task cf` — the task wrapper prints ANSI preamble that corrupts
# the key file. (Chapter 10 covers the shared `implicit trust` dev identity
# and the narrow case where you'd derive it instead.)
deno run -A packages/cli/mod.ts id new > cf.key

export CF_IDENTITY=./cf.key
export CF_API_URL=http://localhost:8000
```

Every piece command below takes `-i/--identity`, `-a/--api-url`,
`-s/--space` — or reads them from `CF_IDENTITY`, `CF_API_URL`, and a `-s`
space name. (What the key actually is, and how a space name becomes a DID,
is Chapter 10.)

Worth doing once, since the rest of this chapter is a lot of typing — turn on
tab completion:

```bash
# zsh: add to ~/.zshrc after compinit (bash: swap zsh -> bash, use ~/.bashrc)
source <(deno run -A packages/cli/mod.ts completion zsh)
```

It completes commands and flags offline, and — once `CF_IDENTITY`/`CF_API_URL`
are set as above — the values that are actually painful to type: piece ids
(annotated with each piece's name), a piece's callable names, and cell paths a
segment at a time. It completes `deno task cf ...` as well as a `cf` binary.
See `cf completion --help`.

## Deploy and iterate

```bash
# Run every authored pattern test before deployment
deno task cf test pattern.test.tsx

# First deploy only — SAVE THE PRINTED PIECE ID
deno task cf piece new pattern.tsx --test pattern.test.tsx -s myspace

# Every iteration after that: rerun tests, then update the SAME piece in place
deno task cf test pattern.test.tsx
deno task cf piece setsrc pattern.tsx --test pattern.test.tsx \
  --cell fid1:abc... -s myspace
```

The most common workflow mistake is rerunning `piece new` after each edit —
that creates a new piece every time, and your space fills with stale
duplicates. `new` once, `setsrc` forever after.

Write automated pattern tests for new or changed behavior. Repeat `cf test` and
`--test` for every authored test entry. The deployment command packages and
type-checks attached tests but does not run them. Repeat the complete set of
flags on every `setsrc`; each update defines a complete source revision, so an
omitted test entry is not retained.

For example, a second test entry is run and attached separately:

```bash
deno task cf test pattern.integration.test.tsx
deno task cf piece setsrc pattern.tsx \
  --test pattern.test.tsx \
  --test pattern.integration.test.tsx \
  --cell fid1:abc... -s myspace
```

The attached files are included by `cf piece getsrc`, so another checkout of
the piece receives the source and its tests together. Without `--root`, the CLI
infers the common directory that contains the main entry and every test entry.
An explicit `--root` applies to all of them. A test-only change creates a new
source revision, so history and recovery keep each test package separate.

Files that hold data rather than code — a fixture, a table, a list of names —
travel the same way, and the pattern declares them by reading them:

```tsx
// Shown for illustration only.
import { dataFile, pattern } from "commonfabric";

export default pattern(() => ({
  cities: JSON.parse(dataFile("./data/cities.json")).cities,
}));
```

The path is relative to the module that reads it, the way an import specifier
is, so `./data/cities.json` is the file in the `data` directory beside the
pattern. That call is the whole declaration: `setsrc`, `check`, `test` and
`dev` each read it out of the source and attach the file, as they already
follow what the source imports. Nothing names the file a second time on a
command line.

A data file is stored verbatim beside the source. Deployment never parses,
type-checks, or compiles it, and no pattern can import it. It must be UTF-8
text, and it must sit inside the deployment root, which the CLI infers to cover
the main entry, every test entry, and every data file. Like a test entry, a data
file is part of the source revision's identity, so changing one creates a new
revision, and each revision keeps its own bytes.

The bytes travel with the pattern's code, so the read is immediate and returns
the same text on every load of a given revision. Reading at module scope rather
than inside a pattern produces a top-level value like any other, so it takes
the usual `__cf_data` snapshot.

`dataFile` returns text, so parsing it yields `any`. Name the shape you expect,
or the result schema the transformer infers has nothing to go on:

```tsx
// Shown for illustration only.
interface Cities {
  cities: string[];
}

const parsed = JSON.parse(dataFile("./data/cities.json")) as Cities;
```

A file the source cannot name — one read by a computed path, or one that ships
with a pattern that does not read it — is attached with a repeatable
`--datafile` flag, which every one of those commands takes:

```bash
deno task cf piece setsrc pattern.tsx \
  --test pattern.test.tsx \
  --datafile data/lookup.csv \
  --cell fid1:abc... -s myspace
```

That flag names a path on disk, and the file is stored under its path relative
to the deployment root. Repeat the complete set of `--datafile` flags on every
`setsrc`, because each update defines a complete source revision. A file
attached this way and never read leaves nothing in the source saying it is
data, which is why `cf piece getsrc` names those files for the next `setsrc`.

Attach neither way and the pattern still compiles and type-checks, then fails
on the read — `dataFile` is declared whether or not a file is attached, so the
absence shows up when the pattern runs rather than when it compiles.

Data files also travel for whoever reads the source next — you on another
machine, a teammate running `cf piece getsrc`, a tool reading the FUSE `.src/`
view. They are fixed at deploy time: data that changes while the pattern runs
belongs in its cells.

## Drive a deployed piece from the CLI

Everything a pattern exports (Chapter 3) is drivable without a browser:

```bash
deno task cf piece ls -s myspace                          # list registered pieces
deno task cf piece search -s myspace "invoice"            # search registered pieces
deno task cf piece inspect --cell <ID>                    # dump structure/state
deno task cf cell get --cell <ID> items                        # read one exported field
deno task cf piece call --cell <ID> addItem '{"title": "Test"}' # send to a stream
echo '"hello"' | deno task cf cell set --cell <ID> title       # write a field
deno task cf piece step --cell <ID>                       # force recompute
deno task cf piece view --cell <ID>                       # render the UI in the terminal
deno task cf piece link <srcID>/items <dstID>/items       # wire two pieces
deno task cf piece set-slug myslug <ID>                   # pretty URL
```

A reference names the target, and one grammar covers every part of the name:
`//<space>/<piece>[#member][@qualifier…][/<path>]`. The space is a name or a
DID, the piece a slug or a handle, so `//my-space/tracker@space/items` and
`//did:key:.../of:fid1:...@space/items` are the same shape. Within the current
space, `/tracker/items` omits the space and inherits the context scope. A reference carrying its
space needs no `-s` beside it: the embedded space supplies the target, and a
`-s` that disagrees with it is refused. So an address copied off one command's
output drives the next command unchanged, even from a shell configured for a
different space.

On `cell get`, `cell set`, and `piece call`, write the reference in the first
positional — `cf cell get /tracker/items`. `--cell` takes the same word where
a flag suits better, and is also where the bare id and slug spellings go
(`--cell fid1:abc...`, `--cell myslug`); `--piece` is a deprecated name for
that same flag, still accepted. On the commands that take `--input` (`cell
get` and `cell set` here), a trailing `#argument` selects the piece's
arguments cell the way that flag does; `piece call` takes no `--input` and
refuses the suffix. Each of the three sits under the noun it acts on: `get`
and `set` name a cell, and `call` invokes a verb on a piece.

One subtlety: neither `cf cell set` nor `cf piece call` refreshes *computed*
outputs. `set` writes the cell without running anything; `call` runs the
handler (so the handler's own writes land and sync), but the scheduler is
lazy — derived values recompute only when something observes them
(Chapter 8), and nothing in the ephemeral CLI session does. Run
`cf piece step --cell <ID>` — which pulls the piece, forcing
recomputation — before inspecting computed fields with `cell get` or
`piece inspect`.

This CLI surface is also exactly how *agents* drive the system — same
streams, same cells. The browser shell is just one more client.

## Testing patterns

Tests are patterns that test patterns: instantiate the subject, alternate
`action` steps and `assert(() => boolean)` assertions, and return them
under the reserved `[TESTS]` key. From
`packages/patterns/counter/counter.test.tsx`:

```tsx
// Shown at module scope.
import { action, assert, pattern, TESTS } from "commonfabric";
import Counter from "./counter.tsx";

export default pattern(() => {
  const counter = Counter({});

  const action_increment = action(() => {
    counter.increment.send();
  });

  const assert_initial_value_is_0 = assert(() => counter.value === 0);
  const assert_value_is_1 = assert(() => counter.value === 1);

  return {
    [TESTS]: [
      { assertion: assert_initial_value_is_0 },
      { action: action_increment },
      { assertion: assert_value_is_1 },
    ],
    counter, // exposed for debugging
  };
});
```

```bash
deno task cf test packages/patterns/counter/counter.test.tsx --verbose
deno task cf test packages/patterns/my-pattern/      # all tests in a directory
```

Notice what makes the subject *testable*: dual type parameters on
`pattern<Input, Output>()` and exported `Stream<T>` actions. That's why
Chapter 3 insisted on them. Keep assertions deterministic — no
`Date.now()` or randomness inside them. Patterns that fetch external data
(`fetchJson` and friends) can still be tested deterministically: export a
module-scope `fetchMocks` array from the test file and the harness injects
it as the runtime's fetch (worked examples in
`packages/patterns/examples/fetch-mock.test.tsx`). The guidance from the
canonical guide: primary verification is still runtime behavior; write
tests for logic that's awkward or expensive to verify by clicking.

## The gotcha checklist

Before your first deploy, scan your pattern against the ten most common
failures (each links to a full writeup under
`docs/development/debugging/gotchas/` or the development guide):

1. **`computed()` gating JSX** — cells are truthy objects inside the
   closure; use ternaries in JSX instead.
2. **Writing upstream cells inside `computed()`** — reactive cycle;
   derivation in computeds, mutation in actions.
3. **Echoing a `$value` binding from its own change handler** — feedback
   loop; the binding is the value path.
4. **`handler()`/`lift()` inside the pattern body** — must be module scope;
   use `action()` for closures.
5. **`new Writable(reactiveValue)`** — initialize with statics; copy from
   inputs inside an action.
6. **`onClick={stream.send(x)}`** — invokes during render; pass
   `() => stream.send(x)`.
7. **Storing a cell reference to mark selection** — later writes can land on
   the referenced item (sub-path writes and pattern bindings follow links)
   instead of changing the selection; box it: `selected.set({ item })`.
8. **`ifElse` on a composed pattern's cell** — hangs; bridge through a local
   `computed()`.
9. **`Date.now()` / `Math.random()` / `setTimeout` / `new Proxy()`** — `setTimeout`
   and `new Proxy()` are not available under SES. `Date.now()`, no-argument
   `new Date()`, and `Math.random()` are gated: call them directly in handlers or
   one-time initialization (the clock reads at one-second resolution there), but in
   `computed()`/`lift()` they throw a `TimeCapabilityError`. For reactive time in a
   `computed()`, use the `#now` wish.
10. **Unguarded scoped-cell reads while rendering** — `PerSession` cells are
    `undefined` until first sync; guard with `?? []`.

When something still goes wrong: `docs/development/debugging/` has the error
reference, and the repo-local `pattern-critic` agent/skill reviews a pattern
against the full rule list mechanically. For storage-level surprises ("what
is actually stored?", "who overwrote this?"), `cf inspect` performs an
offline autopsy of a space's SQLite database — see the `state-inspector`
skill.

---

This closes Part I — you can now build, deploy, link, and test patterns.
**Part II begins with [Chapter 7 — From TypeScript to a runnable
graph](07-compilation.md):** what actually happens when `cf check` compiles
your file.
