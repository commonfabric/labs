---
name: isolated-test-processes
description: Guide for writing side-effect-free tests that spawn child processes, especially Deno commands. Use when adding or reviewing tests that call Deno.Command, run deno check/test/run/task/install, generate temporary deno.json files, update goldens, write build artifacts, or otherwise risk changing deno.lock or files in the repository workspace.
---

# Isolated Test Processes

Tests that spawn Deno can update the repository even when the test only means to
verify behavior. Deno commands resolve dependencies and may refresh `deno.lock`
metadata. Generated configs, output files, and golden updates can also leave
workspace files behind if cleanup is not tied to failure paths.

## Repo Map

Use `@commonfabric/test-support/isolated-deno` for nested Deno commands that
need lockfile isolation.

For nested Deno checks that need a generated config:

```ts
import {
  runDenoCheckWithTemporaryConfig,
} from "@commonfabric/test-support/isolated-deno";
```

That helper keeps the generated Deno workspace config in the repository root,
where Deno requires workspace members to be nested under the config directory.
It points Deno at a temporary copy of `deno.lock`, so dependency metadata writes
do not touch the real lockfile. It also removes the generated root config in a
`finally` block. The nested check uses frozen dependency resolution, so its
generated config must preserve the dependency graph in the checked-in lockfile.
Start with the root config and change only the compiler settings needed by the
test. Workspace member imports already come from their package configs. Do not
copy them into the generated root config.

For nested Deno commands that do not need a generated config:

```ts
import {
  runDenoCommandWithTemporaryLock,
} from "@commonfabric/test-support/isolated-deno";
```

Pass an argument builder and place the temporary lock path in the child Deno
command's `--lock` flag.

## Values

- A verification test must not change `deno.lock` or repository files.
- A verification test must use the dependency graph already recorded in
  `deno.lock`. Dependency fetching belongs in setup before the test runs.
- A generated config may change compiler options. It must preserve imports,
  workspace members, and other dependency declarations.
- If a test needs mutable inputs or outputs, put them under `Deno.makeTempDir()`
  or an explicit test fixture copy.
- If a generated file must briefly live in the repository root for tool
  semantics, give it a unique dot-prefixed name and remove it in `finally`.
- If a test intentionally updates fixtures or goldens, gate the write behind an
  explicit environment variable such as `UPDATE_GOLDENS=1`.
- Treat `Deno.Command(Deno.execPath())` as a side-effect boundary. The child
  Deno process does not inherit the parent test runner's lockfile flags.
- Spawn `Deno.execPath()`, never the program name `"deno"`. A name resolves
  through `PATH`, which is a different Deno than the one running the test
  whenever the shell's Deno is not the version pinned in `mise.toml`. The two
  versions share one cache directory but read transpiled sources only from their
  own part of it, so a coverage profile written by one and reported by the other
  yields a report with every file missing. (In a `deno compile`d binary
  `Deno.execPath()` is that binary rather than Deno, so code that has to run
  both compiled and under Deno needs its own way to find a Deno.)
- A `--allow-run=deno` grant does not permit spawning `Deno.execPath()`, because
  Deno resolves the allowlist entry through `PATH` as well. Name the binary
  rather than widening the grant to a bare `--allow-run`. In a task line,
  `--allow-run="$(deno eval "console.log(Deno.execPath())")"` computes it,
  because `deno` inside a task runs the Deno running the task whatever `PATH`
  says — `packages/test-support/src/isolated-deno.test.ts` pins that with a
  decoy `deno` on the child's `PATH`. From a script, read `Deno.execPath()`
  directly, as `tasks/run-member-tests.test.ts` does with `--allow-run=${deno}`.

- End a child Deno that is done, or that waits only on input the test controls,
  by closing that input, and then await its `status`. Do not signal it. The
  child inherits `DENO_COVERAGE_DIR` and writes its coverage profiles as it
  exits. A signal sent during that exit loses a profile or truncates one, and
  one truncated profile makes `deno coverage` refuse every profile in the job.
  "Tests that start Deno" in `docs/development/TESTING.md` has the detail.

## Common Tells

Risky tests often contain `Deno.Command(Deno.execPath())`, `deno check`,
`deno task`, `deno install`, generated `deno.json` files, generated build
outputs, or direct writes to paths under the repository root.
