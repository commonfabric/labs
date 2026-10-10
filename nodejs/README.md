# Running the workspace under Node

This directory lets the workspace's TypeScript run under Node (26 or later)
without changing the workspace's source. It does so by making Node look like
Deno to that source, not by porting the source to Node: Deno's module resolution
is reproduced by loader hooks, and the `Deno` global and the web APIs Deno has
and Node lacks are supplied as shims. Code that asks whether it is running on
Deno therefore gets the answer `true`.

## Setup

Once per checkout, from this directory:

```sh
npm install --ignore-scripts
```

`package.json` is generated, not edited: `node tools/gen-package-json.mjs`
rewrites it from the `npm:` and `jsr:` specifiers in the workspace's
`deno.jsonc` files, pinned to the versions `deno.lock` resolved them to, with
the lock's transitive versions as `overrides`. JSR packages come from JSR's npm
registry (`@jsr/<scope>__<name>`), configured in `.npmrc`. Peer dependencies are
not enforced, since Deno does not enforce them.

## Running things

- `bin/cfnode <module.ts> [args...]` is the counterpart of `deno run -A`: Node
  with `--disable-proto=delete` (Deno deletes `Object.prototype.__proto__`) and
  `--import register.mjs`. Any other `node` option passes through.
- `bin/test-member <member-dir> [node --test options...]` runs a member's unit
  tests (`test/**/*.test.ts(x)`, without `*.browser.test.*`) under
  `node --test`, from the member's directory and with `ENV=test`, as its Deno
  task does. A `--preload` in the member's `deno-test` task is passed as an
  `--import`.
- `bin/cf [args...]` is the `cf` CLI, the counterpart of `deno task cf`.
- `bin/deno` stands in for the `deno` executable: `Deno.execPath()` names it,
  and `new Deno.Command("deno", ...)` runs it, so code that re-invokes the
  running Deno gets Node. It runs `deno task` itself (announcing the task on
  stderr, as Deno does, with `bin/` first on `PATH`), and hands `run`, `test`,
  and `eval` to `bin/deno-as-node`, which translates the command line to a
  `cfnode` one (permission, lock, and type-check flags dropped; `--v8-flags`
  passed as Node flags; `--preload` as `--import`). With it, a member's own
  `deno task test` runs on Node:
  `cd packages/leb128 && ../../nodejs/bin/deno
  task test`.
- `tools/summary-reporter.mjs` is a `node --test` reporter writing one JSON line
  per test, and `tools/tally.mjs <file.jsonl>...` totals them and groups
  failures by message, for working through a large suite.
- `felt` bundles unchanged:
  `cd packages/shell && ../../nodejs/bin/cfnode
  ../felt/cli.ts build .`.

Tests that open a listening socket must run outside an agent sandbox that
refuses `listen`.

## What is here

- `register.mjs`: the `--import` entry point. Registers the loader hooks
  in-thread (`module.registerHooks()`), then installs the globals.
- `lib/resolver.mjs`: maps a specifier as Deno would: the importing member's
  import map over the root's, workspace members by package name through their
  `exports`, and `npm:`, `jsr:`, and `esm.sh` specifiers to installed packages.
  Packages that bind to Deno-only machinery map to this directory's replacements
  (`@db/sqlite`, `@denosaurs/plug`, `@deno/esbuild-plugin`).
- `lib/hooks.mjs`: the loader hooks. Resolution goes through `resolver.mjs`;
  TypeScript and JSX compile with esbuild under the root's JSX settings, cached
  under `.cache/compiled/` by a hash of the source and options; Deno's
  `with { type: "text" }` and `{ type: "bytes" }` imports become modules
  exporting the text or a `Uint8Array`.
- `lib/deno-global.mjs`: the `Deno` global. `@deno/shim-deno` supplies most of
  it; `test` (over `node:test`), `bench` (a no-op), `Command`, `serve`,
  `upgradeWebSocket`, `execPath`, and `unrefTimer` are this directory's. File
  functions accept `file:` URLs and throw `Deno.errors` classes, and
  `Symbol.for("Deno.customInspect")` methods are honored by `util.inspect()`.
- `lib/web-globals.mjs`: `self`; a Web `Worker` over `worker_threads`, with the
  in-worker global scope; `indexedDB` from `fake-indexeddb`.
- `lib/global-events.mjs`: the main thread's global scope as an `EventTarget`,
  with the `unhandledrejection`, `error`, and `unload` events (dispatched ahead
  of every Node listener, `node:test`'s included); `reportError()`,
  `ErrorEvent`, and `PromiseRejectionEvent`.
- `lib/websocket-upgrade.mjs`: `Deno.upgradeWebSocket()` for `Deno.serve()`,
  over the `ws` package.
- `lib/tcp-bind.mjs`: binds a listening socket before `Deno.serve()` returns, as
  Deno does, so `addr.port` is known at once.
- `lib/internal-timers.mjs`: Node builtins (undici's `fetch()` and `WebSocket`)
  keep the real timer functions when code, such as a test's fake clock, replaces
  the globals; Deno's equivalents are native and never see the replacement.
- `lib/fs-file.mjs`: `Deno.FsFile` locking and syncing.
- `lib/sqlite.mjs`: the `@db/sqlite` API this repository uses, over
  `node:sqlite`.
- `lib/plug.mjs`: the `@denosaurs/plug` replacement. Node has no FFI, so it
  serves only the native functions the workspace binds next to `@db/sqlite` (a
  statement column's origin table and column), answered from `node:sqlite`.
- `lib/esbuild-plugin.mjs`: the `@deno/esbuild-plugin` replacement, built on
  `resolver.mjs`, so a bundle and the runtime resolve alike.

## Known differences from Deno

- IndexedDB is in memory; Deno's persists.
- `navigator.locks.query()` reports only the calling thread's locks.
- Node 26 does not grant a Web Lock request queued before a terminated worker's
  lock is released. The `Worker` shim works around it by asking for each pending
  lock name with `ifAvailable` when a worker exits.
- Test sanitizers (ops, resources, exits) are not applied, and `Deno.bench`
  benchmarks do not run.
- Test output is `node:test`'s, so a test asserting on Deno's test-runner output
  (such as its `Caused by:` line) does not match.
- A browser bundle resolves packages under esbuild's browser conditions, which
  selects some packages' browser builds where Deno's plugin does not.
- `Deno.FsFile` locks exclude only other files open in the same process: Node
  has no `flock()`.
- SQLite text that SQLite marks as JSON reads as text: `node:sqlite` does not
  expose a value's subtype, so `@db/sqlite`'s `parseJson` is not emulated. The
  SQLite `node:sqlite` bundles also formats a REAL as text differently.
- Binding before `Deno.serve()` returns relies on `process.binding("tcp_wrap")`,
  an undocumented Node interface.
