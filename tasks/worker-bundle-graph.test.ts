// The CLIENT WORKER's code-reachable module set must never contain a
// server-only module. The class this pins: a VALUE import added to a
// module the worker bundle reaches (`executor/wave.ts` is imported by
// cell/runtime/runner/scheduler) drags the whole server side — the
// memory v2 server, its sqlite engine — into the browser worker, which
// dies at startup with no error surfaced anywhere near the cause: the
// observed shape was every named-space login timing out ("Timed out
// waiting for runtime login") while the worker fetched its chunks and
// never issued one /api request (PR #6191's toDirtyKey import; caught
// manually by an ON gate probe against a pure-main control, fixed by
// relocating the helper to the browser-safe `memory/v2.ts` surface).
// TYPE-only imports of server modules are fine — they erase at compile
// — which is exactly the code-vs-type edge discrimination `deno info`
// exposes and this walk follows.

import { assert, assertEquals } from "@std/assert";

const WORKER_ENTRY = "packages/runtime-client/src/backends/web-worker/index.ts";

/** Server-only modules the worker's CODE-reachable set must not hold:
 * the memory v2 server, its engine, and the sqlite disk source (the
 * engine's storage backend — present iff the engine side leaked). */
const FORBIDDEN_SUFFIXES = [
  "packages/memory/v2/server.ts",
  "packages/memory/v2/engine.ts",
  "packages/memory/v2/sqlite/disk-source.ts",
];

/** Modules the code walk MUST reach — the sanity floor that keeps this
 * test from passing vacuously on a broken graph read: the wave carriage
 * (the module whose import regressed) and the browser-safe memory
 * surface it now imports from. */
const REQUIRED_SUFFIXES = [
  "packages/runner/src/executor/wave.ts",
  "packages/memory/v2.ts",
];

type DenoInfoDependency = {
  code?: { specifier?: string };
  type?: { specifier?: string };
};

type DenoInfoModule = {
  specifier: string;
  dependencies?: DenoInfoDependency[];
};

type DenoInfoGraph = {
  roots: string[];
  redirects?: Record<string, string>;
  modules: DenoInfoModule[];
};

/** The specifiers reachable from the graph's roots over CODE edges only
 * (dynamic imports included — they ship too; type-only edges skipped:
 * they erase at compile). Redirects are resolved before lookup. */
const codeReachable = (graph: DenoInfoGraph): Set<string> => {
  const redirects = graph.redirects ?? {};
  const resolve = (specifier: string): string =>
    redirects[specifier] ?? specifier;
  const bySpecifier = new Map(
    graph.modules.map((module) => [module.specifier, module]),
  );
  const reached = new Set<string>();
  const queue = graph.roots.map(resolve);
  while (queue.length > 0) {
    const specifier = queue.pop()!;
    if (reached.has(specifier)) continue;
    reached.add(specifier);
    const module = bySpecifier.get(specifier);
    if (module === undefined) continue;
    for (const dependency of module.dependencies ?? []) {
      const code = dependency.code?.specifier;
      if (code !== undefined) queue.push(resolve(code));
    }
  }
  return reached;
};

Deno.test("the client worker's code-reachable module set holds no server-only module (and really reaches the runtime graph)", async () => {
  const repoRoot = new URL("../", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: ["info", "--no-lock", "--json", WORKER_ENTRY],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `deno info failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  const graph = JSON.parse(
    new TextDecoder().decode(output.stdout),
  ) as DenoInfoGraph;
  assertEquals(graph.roots.length, 1);
  const reached = codeReachable(graph);

  // The sanity floor first: a walk that reached almost nothing (a moved
  // entry, a broken parse) must fail HERE, not "pass" the absence
  // asserts below.
  assert(
    reached.size > 100,
    `implausibly small code-reachable set (${reached.size} modules) — ` +
      "the walk or the entry point is broken",
  );
  for (const suffix of REQUIRED_SUFFIXES) {
    assert(
      [...reached].some((specifier) => specifier.endsWith(suffix)),
      `the code walk no longer reaches ${suffix} — the sanity anchor ` +
        "moved; update REQUIRED_SUFFIXES with the graph change that " +
        "moved it",
    );
  }

  for (const suffix of FORBIDDEN_SUFFIXES) {
    const hit = [...reached].find((specifier) => specifier.endsWith(suffix));
    assert(
      hit === undefined,
      `server-only module in the WORKER's code-reachable set: ${hit} — ` +
        "a value import somewhere in the worker graph now pulls the " +
        "server side into the browser bundle (the worker dies at " +
        "startup; logins time out). Find the importing edge with " +
        `\`deno info ${WORKER_ENTRY}\` and make it type-only or import ` +
        "from the browser-safe surface (memory/v2.ts) instead.",
    );
  }
});
