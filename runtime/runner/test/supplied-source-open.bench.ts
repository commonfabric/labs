/**
 * What opening a runtime-supplied surface costs once its destination space has
 * already opened that surface. The wish builtin opens one such surface per wish
 * node — a board of topics each wishing for `#profile` opens the profile create
 * surface once per topic — so every open after a space's first is this one.
 *
 * One runtime is built for the whole file, and one open outside the samples
 * compiles the served program into the space. Each sample then opens a fresh
 * slot there, and the timed interval runs from the call to
 * `SourceReconciler.open()` to its answer: reading the slot, asking the served
 * route which identity it advertises, and producing the pattern. The route is
 * an in-process fetch, so no network time is included.
 *
 * A diagnostic open, also outside the samples, writes to stderr how many
 * compiles and evaluations a warm open performs.
 */

import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";

import {
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
  systemPatternSource,
} from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const signer = await Identity.fromPassphrase("bench supplied source open");
const space = signer.did();

// The runtime writes debug and info lines to stdout, which at module scope
// would land in the report; a compile this file runs outside the samples
// logs a cache hit at info.
setGlobalLogFloor("warn");

const MAIN_PATH = "/api/patterns/system/bench-surface.tsx";
const PART_PATH = "/api/patterns/system/bench-surface-part.tsx";
const ORIGIN = systemPatternSource("system/bench-surface.tsx");

const FILES = new Map([
  [
    MAIN_PATH,
    [
      "import { Surface } from './bench-surface-part.tsx';",
      "export default Surface;",
      "",
    ].join("\n"),
  ],
  [
    PART_PATH,
    [
      "import { computed, pattern } from 'commonfabric';",
      "export const Surface = pattern<",
      "  { name: string },",
      "  { greeting: string }",
      ">(({ name }) => ({ greeting: computed(() => `hello ${name}`) }));",
      "",
    ].join("\n"),
  ],
]);

const identity = await resolveEntryIdentity(
  MAIN_PATH,
  (name) =>
    FILES.has(name)
      ? Promise.resolve(FILES.get(name)!)
      : Promise.reject(new Error(`not found: ${name}`)),
);

/** Serves the surface's files, and its identity from the `?identity` route. */
const fetch: RuntimeFetch = (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === MAIN_PATH && url.searchParams.has("identity")) {
    return Promise.resolve(new Response(identity));
  }
  const contents = FILES.get(url.pathname);
  return Promise.resolve(
    contents === undefined
      ? new Response("not found", { status: 404 })
      : new Response(contents),
  );
};

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("http://toolshed.test"),
  storageManager,
  fetch,
});

// `Deno.bench` has no per-file teardown, so the runtime is disposed, as far
// as a synchronous handler can dispose it, when the process unloads.
globalThis.addEventListener("unload", () => {
  runtime.dispose();
});

let slots = 0;

/** Opens the surface for a slot this space has not opened before. */
async function openFreshSlot(): Promise<void> {
  const slot = runtime.getCell(space, `bench-slot-${slots++}`);
  const pattern = await runtime.sourceReconciler.open(slot, ORIGIN);
  if (pattern === undefined) throw new Error("The surface did not open");
}

await openFreshSlot();
await runtime.patternManager.flushCompileCacheWrites();

{
  const harness = runtime.harness;
  const compileToRecordGraph = harness.compileToRecordGraph.bind(harness);
  const evaluateRecordGraph = harness.evaluateRecordGraph.bind(harness);
  let compiles = 0;
  let evaluations = 0;
  harness.compileToRecordGraph = (...args) => {
    compiles++;
    return compileToRecordGraph(...args);
  };
  harness.evaluateRecordGraph = (...args) => {
    evaluations++;
    return evaluateRecordGraph(...args);
  };
  try {
    await openFreshSlot();
  } finally {
    harness.compileToRecordGraph = compileToRecordGraph;
    harness.evaluateRecordGraph = evaluateRecordGraph;
  }
  benchDiagnostic(JSON.stringify({ warmOpen: { compiles, evaluations } }));
}

Deno.bench({
  name: "warm open",
  group: "supplied-source-open",
  async fn(b) {
    const slot = runtime.getCell(space, `bench-slot-${slots++}`);
    b.start();
    const pattern = await runtime.sourceReconciler.open(slot, ORIGIN);
    b.end();
    if (pattern === undefined) throw new Error("The surface did not open");
  },
});
