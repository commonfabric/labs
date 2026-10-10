---
status: historical
created: 2026-10-10
archived: 2026-10-10
reason: "Feasibility study snapshot: the workspace run under Node 26 through a Deno-emulation layer, branch `danfuzz/node-feasibility`."
---

# Running `labs` on Node: a feasibility study

Can this repository run on Node instead of Deno? This records what a two-day
study on branch `danfuzz/node-feasibility` found, at its head on 2026-10-10.
The study aimed at feasibility, not completeness: get as far as reasonably
possible, and record each decision for later analysis. The decisions and their
reasons are in the branch's commit messages, and how to run the result is in
`nodejs/README.md` on the branch.

## Answer

Yes, by emulation. Every unit suite tried runs under Node 26, most of them
completely green, and the deployed path works end to end: the `cf` CLI, run on
Node against a toolshed running on Node, creates a space, deploys a pattern,
calls a handler, and reads back the result. The shell's browser bundles build
under Node.

That was done without changing one file under `packages/`. All of it is a layer
of about 3,000 lines in `nodejs/` that makes Node look like Deno to the
workspace's source:

- Loader hooks that resolve specifiers as Deno does (a member's import map
  over the root's, members by package name, `npm:`, `jsr:` and `esm.sh`
  specifiers) and compile TypeScript and JSX with esbuild, with a disk cache.
- A `Deno` global: `@deno/shim-deno` for most of the namespace, with this
  layer's own `test` (over `node:test`), `Command`, `serve`,
  `upgradeWebSocket`, error mapping, and a `deno` executable stand-in for code
  that re-invokes the running Deno.
- The web APIs Deno has and Node lacks: a Web `Worker`, IndexedDB, the global
  scope as an `EventTarget`, `reportError()`.
- Replacements for the packages that bind Deno-only machinery: `@db/sqlite`
  over `node:sqlite`, `@denosaurs/plug`, and `@deno/esbuild-plugin`.
- A `package.json` generated from `deno.lock`, so Node runs the same package
  versions Deno does.

Because it emulates Deno, code that asks whether it runs on Deno is told yes.
That is what made "no source changes" possible, and it is also the main
argument against treating the layer as a destination; see "Directions" below.

## Unit suites under Node

Counts are passing tests over tests run, from unsandboxed runs (an agent
sandbox refuses `listen`, which fails socket-using files for reasons that are
not Node's).

| Layer        | Member              | Result                                       |
| ------------ | ------------------- | -------------------------------------------- |
| Foundation   | `api`               | 40/40                                        |
|              | `content-hash`      | 727/727                                      |
|              | `data-model`        | 4293/4293                                    |
|              | `data-model-schema` | 433/433                                      |
|              | `identity`          | 42/42                                        |
|              | `memory`            | 2081/2111, one hanging file left out         |
|              | `runner`            | 15437 pass, 12 fail, 2 cancelled; 1045 files |
|              | `utils`             | 1101/1104                                    |
| System       | `iframe-sandbox`    | 135/135 (unit tests; browser tests not run)  |
|              | `js-compiler`       | 181/181                                      |
|              | `schema-generator`  | 1225/1225                                    |
|              | `ts-transformers`   | 3092/3092                                    |
| Capabilities | `html`              | 530/530                                      |
|              | `llm`               | 44/44                                        |
|              | `navigation`        | 51/51                                        |
|              | `piece`             | 1462/1462                                    |
| Operation    | `cli`               | about 2223 pass, 73 fail; 120 of 299 files   |
|              | `state-inspector`   | 448/448                                      |
| Product      | `runtime-client`    | 1131/1131                                    |
| Utilities    | `leb128`            | 71/71                                        |
|              | `pure-json`         | 24/24                                        |
|              | `home-schemas`      | 7/7                                          |

Not attempted: `ui` and every other browser-run suite, the integration suites,
`cf-harness`, `connectors`, `agent-runner`, `fuse`, `dashboard`, and the
pattern tests beyond `counter`.

The repository's own test plumbing also runs: `nodejs/bin/deno task test` in a
member goes through `tasks/run-member-tests.ts` and the member's `deno-test`
task, with every `deno` it spawns being the stand-in.

### What still fails, by cause

- `memory`: 9 tests expect SQLite's JSON-subtyped text to read as an object
  (`@db/sqlite`'s `parseJson`); `node:sqlite` cannot see a value's subtype. One
  test expects an older SQLite's text for a REAL. The standalone server's
  files had a hang that the later merges of `Deno.upgradeWebSocket()` and a
  synchronous bind addressed in `runner`, but not re-measured in `memory`. One
  TLS test needs an `openssl` that can make ed25519 keys.
- `runner`: about 8 files. One asserts on Deno's `Caused by:` output; two hit
  `@std/testing/bdd` refusing a `describe()` registered after tests start; one
  never exits; three single assertions not investigated; one flaky under load.
- `cli`: the run was partial. Failure clusters: "parent finished" reports from
  the test adapter, which did not reproduce for single files and may be a
  side effect of 60-file concurrent runs hitting the timeout; 120-second
  timeouts; color and TTY assertions; and the darwin mount-table FFI tests,
  which cannot work without FFI.
- `utils`: one test expects `navigator.locks.query()` on the main thread to
  list a worker's lock; Node reports per thread.

## Speed

On one machine (Apple silicon, warm caches):

- `data-model`'s suite: 10 s under Node, 11 s under Deno.
- `cf --help`: 0.92 s under Node, 0.78 s under Deno. Before the compile cache,
  Node took 2.2 s, compiling every module at every start.
- The shell bundle: about 1.3 s under Node, 2.5 s under Deno.
- `cf space create` against a Node toolshed: 47 s, mostly compiling the home
  pattern; `cf piece new` with the counter: 30 s. These were not measured
  against Deno.

## Where Node and Deno differ for this codebase

These are what the layer could not hide, or hides at a cost:

- **No FFI.** `@db/sqlite` is replaced by `node:sqlite`, which works but
  cannot see JSON subtypes and bundles a newer SQLite. Advisory file locks
  (`flock()`) have no Node counterpart, so locks exclude only within one
  process; the routed-epoch ledger, the compile byte cache, and the harness
  credential store would need a native addon for cross-process locking. The
  darwin mount-table reader has no path at all.
- **Synchronous bind.** Deno knows a server's port when `Deno.serve()`
  returns; Node reports it in a callback. The layer gets Deno's behavior
  through `process.binding("tcp_wrap")`, an undocumented interface.
- **The test runner.** `node:test` replaces `deno test`: sanitizers are not
  applied, `Deno.bench` does not run, output formats differ, and a test that
  depends on Deno's runner semantics can behave differently.
- **IndexedDB** is in memory (`fake-indexeddb`); Deno's persists.
- **A Node 26 defect.** A Web Lock request queued before a terminated worker's
  lock is released is never granted, though nothing holds the lock.
  `utils/worker-lifetime`'s `terminateWorker()` waits on exactly that, so three
  `data-model` files hung. The `Worker` shim works around it; it is worth
  reporting upstream.
- **`__proto__`**: Deno deletes `Object.prototype.__proto__`; Node needs
  `--disable-proto=delete`, which is why every Node command goes through a
  launcher.
- **Bundles** built through the layer's esbuild plugin resolve packages under
  browser conditions, so they differ from Deno-built bundles in which file of
  some packages they take (OpenTelemetry's metrics stack drops out, turndown
  takes its browser build). Not a missing module; arguably more correct for a
  browser, but not identical.

## What was not addressed

- The Deno-hosted gates: `deno check`, `deno lint` with its plugins, `deno
  fmt`, `deno coverage`, `deno compile` (the release binaries), and the
  `deno task` graph beyond the stand-in's simple runner. Moving off Deno
  entirely would need a replacement for each (`tsc` with the per-member
  configurations, a linter with the repository's rules ported, a formatter
  matching the current output, V8 coverage tooling, a single-executable build).
  The study kept Deno as the development tool throughout.
- Deployment packaging, the browser integration suites, and the FUSE mount.

## Directions

Three ways forward, should running on Node become a goal:

1. **Keep the emulation layer.** Cheapest now, and it proved the codebase has
   no deep dependency on Deno. But it runs the Deno code paths on Node under a
   shim, two runtimes' worth of behavior has to stay in step, and it leans on
   one undocumented Node interface and one Node defect workaround.
2. **Write new code to run on both.** Deno supports `node:` builtins and npm
   packages, so code written against `node:fs`, `node:http`, and the like runs
   on either runtime. Moving the `Deno.*` call sites (thousands, most of them
   `Deno.test` and file I/O in tests) behind `node:` APIs or small portable
   wrappers would shrink the layer toward the parts no API choice removes: FFI,
   file locks, and the test runner.
3. **Port fully to Node.** The largest effort, dominated by the tooling above
   rather than by runtime code, which this study suggests is the easy part.

## How the study was run

The lead agent built the loader, the `Deno` global, the web globals, the
bundler plugin, the lock-pinned dependencies, and the compile cache, and ran
the foundation, system, and capabilities suites. Three subagents took one
vertical each, on sibling branches merged back at safe points: the SQLite
adapter and `memory`/`state-inspector`; the `runner` suite; and the CLI and
toolshed. Two pieces were built twice in parallel (`Deno.upgradeWebSocket()`
and the `deno` stand-in) and reconciled at merge; the merge commits record
which was kept and why.
