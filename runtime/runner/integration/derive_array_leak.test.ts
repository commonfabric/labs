#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Checks that building and tearing down a view over a derived array, again
 * and again, does not retain memory in the test's own isolate, which runs the
 * derivation and renders the view, and does not grow the resident size of the
 * Toolshed at `API_URL` past a fixed limit.
 *
 * One cycle clicks the fixture's increment and then its decrement, so the
 * counter returns to zero and the view to no elements, and whatever the
 * cycle allocated is garbage once it ends. Memory that grows with the number
 * of cycles is therefore memory something retained. The cycles that run
 * before the baseline take the one-time costs, such as compiled code and
 * caches filling, out of the measurement.
 *
 * The view is rendered here, as a browser would render it, because the
 * scheduler runs only the computations something reads: with nothing reading
 * the view, a click runs the handler and no derivation at all.
 *
 * The isolate is measured after a full garbage collection, as the heap and
 * the memory outside it that V8 accounts for. That reading does not depend on
 * when the collector last ran, nor on which pages the operating system has
 * compressed or swapped out, so its limit only has to leave room for bounded
 * structures that are still filling, such as timing reservoirs and caches.
 * Retention smaller than that limit across the measured cycles passes. Each
 * test file runs in an isolate of its own, so the reading leaves other files
 * out.
 *
 * Nothing here can make the server collect. Its resident size, its only
 * reading of the whole process, moves by hundreds of megabytes with
 * collection timing, so a server leak smaller than the server's limit
 * passes.
 */

// deno-lint-ignore no-external-import -- Enables `gc()` after startup, whatever flags started the test.
import { setFlagsFromString } from "node:v8";
// deno-lint-ignore no-external-import -- Creates the context that holds `gc()`.
import { runInNewContext } from "node:vm";
import { MockDoc } from "@commonfabric/html/mock-doc";
import { renderInProcess } from "@commonfabric/html/in-process";
import { createSession, Identity } from "@commonfabric/identity";
import {
  experimentalOptionsFromEnv,
  UI,
  withServerExecutionDefault,
} from "@commonfabric/runner";
import { uiSchema } from "@commonfabric/runner/schemas";
import { createTestSpace, env } from "@commonfabric/integration";
import { PiecesController } from "@commonfabric/piece/ops";
import { defer, type Deferred } from "@commonfabric/async/defer";

import { compileAndSavePattern, Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const { API_URL } = env;

// Cycles run before the baseline, and cycles measured after it.
const WARM_UP_CYCLES = 30;
const MEASURED_CYCLES = 20;

// The most the isolate and the server may grow across the measured cycles.
// Without a leak, on a Mac in either posture, the isolate grew less than
// 6 MB, and the server's resident size by up to 260 MB.
const MAX_CLIENT_GROWTH_MB = 16;
const MAX_SERVER_GROWTH_MB = 512;

const MB = 1024 * 1024;

/** Returns V8's `gc()`, which collects this isolate's whole heap. */
function exposeGarbageCollector(): () => void {
  // V8 gives `gc()` only to contexts created after the flag is set, so the
  // function comes from a new context.
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("V8 did not expose `gc()`");
  return () => gc();
}

/**
 * Returns the memory this isolate holds live, in megabytes: the heap and
 * V8's external memory, after `collectGarbage` has run.
 */
function getClientMemoryMB(collectGarbage: () => void): number {
  collectGarbage();
  const { heapUsed, external } = Deno.memoryUsage();
  return (heapUsed + external) / MB;
}

/**
 * Returns the resident size of the Toolshed at `API_URL`, in megabytes, as
 * that server reports it.
 */
async function getServerMemoryMB(): Promise<number> {
  const url = new URL("api/health/stats", API_URL);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `${url} answered ${response.status}: ${await response.text()}`,
    );
  }
  const rss = (await response.json()).processMemory?.rss;
  if (typeof rss !== "number") {
    throw new Error(`${url} reported no \`processMemory.rss\``);
  }
  return rss / MB;
}

async function runTest() {
  const collectGarbage = exposeGarbageCollector();
  const account = await Identity.generate();
  const space = await createTestSpace(account);
  const session = createSession({ identity: account, spaceDid: space });

  // The first error the runtime or the view reported, and the wait for the
  // click in progress, which that error ends.
  let failure: Error | undefined;
  let shown: Deferred | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    shown?.reject(error);
  };

  const storageManager = StorageManager.open({
    as: session.as,
    memoryHost: new URL(API_URL),
  });
  const runtime = new Runtime({
    apiUrl: new URL(API_URL),
    // The posture this client runs (server-execution v2, testing.md §2):
    // resolved exactly like a deployed entry point — the canonical env
    // mapping, else the first-party default — so this process runs the arm
    // the lane's toolshed runs. A bare construction resolves the ambient
    // baseline instead, a posture no deployment runs.
    experimental: withServerExecutionDefault(
      experimentalOptionsFromEnv(Deno.env.get),
    ),
    storageManager,
    errorHandlers: [fail],
  });
  try {
    const pieces = new PiecesController(session, runtime);
    await pieces.ready;
    const pattern = await compileAndSavePattern(
      runtime,
      await Deno.readTextFile("./integration/derive_array_leak.tsx"),
      { space },
    );
    const result = await pieces.runPersistent(pattern, {});
    const piece = result.asSchema({
      type: "object",
      properties: {
        value: { type: "number" },
        stepsPerClick: { type: "number" },
        increment: { asCell: ["stream"] },
        decrement: { asCell: ["stream"] },
      },
      required: ["value", "stepsPerClick", "increment", "decrement"],
    });

    const mock = new MockDoc(
      '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    );
    const container = mock.document.getElementById("root");
    if (container === null) throw new Error("The mock document has no root");
    // Runs whenever the counter changes or the view applies a batch.
    let onChange = () => {};
    const render = renderInProcess(
      container,
      result.asSchema(uiSchema).key(UI),
      {
        document: mock.document,
        setProp: mock.renderOptions.setProp,
        onError: fail,
        onApplied: () => onChange(),
      },
    );
    const cancelValueSink = piece.key("value").sink(() => onChange());
    try {
      // Sends one click, and waits until the counter is `expected` and the
      // view shows that many elements. Where the server runs the handler,
      // the value arrives from the server, which neither the runtime going
      // idle nor the server confirming this runtime's commits waits for.
      const click = async (
        stream: "increment" | "decrement",
        expected: number,
      ) => {
        if (failure) throw failure;
        const wait = shown = defer();
        onChange = () => {
          const items = mock.document.getElementById("items")
            ?.getElementsByTagName("i").length;
          if (piece.get().value === expected && items === expected) {
            wait.resolve();
          }
        };
        try {
          piece.key(stream).send({});
          await wait.promise;
        } finally {
          shown = undefined;
        }
        await runtime.idle();
        await runtime.storageManager.synced();
      };
      const cycle = async () => {
        await click("increment", piece.get().stepsPerClick);
        await click("decrement", 0);
      };

      for (let i = 0; i < WARM_UP_CYCLES; i++) await cycle();
      const clientBeforeMB = getClientMemoryMB(collectGarbage);
      const serverBeforeMB = await getServerMemoryMB();
      for (let i = 0; i < MEASURED_CYCLES; i++) await cycle();
      const clientGrowthMB = getClientMemoryMB(collectGarbage) -
        clientBeforeMB;
      const serverGrowthMB = await getServerMemoryMB() - serverBeforeMB;
      if (failure) throw failure;

      const growth = (grewMB: number, fromMB: number, limitMB: number) =>
        `${grewMB.toFixed(1)} MB from ${fromMB.toFixed(1)} MB ` +
        `(limit ${limitMB} MB)`;
      console.log(
        `Across ${MEASURED_CYCLES} cycles, the test's isolate grew ` +
          growth(clientGrowthMB, clientBeforeMB, MAX_CLIENT_GROWTH_MB) +
          ", and the server grew " +
          growth(serverGrowthMB, serverBeforeMB, MAX_SERVER_GROWTH_MB),
      );
      if (clientGrowthMB > MAX_CLIENT_GROWTH_MB) {
        throw new Error(
          `The test's isolate retained ${
            clientGrowthMB.toFixed(1)
          } MB across ` +
            `${MEASURED_CYCLES} cycles (limit ${MAX_CLIENT_GROWTH_MB} MB)`,
        );
      }
      if (serverGrowthMB > MAX_SERVER_GROWTH_MB) {
        throw new Error(
          `The server grew ${serverGrowthMB.toFixed(1)} MB across ` +
            `${MEASURED_CYCLES} cycles (limit ${MAX_SERVER_GROWTH_MB} MB)`,
        );
      }
    } finally {
      cancelValueSink();
      render.cancel();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

// The test runs without a per-test deadline. See
// docs/development/waiting-in-tests.md.
Deno.test({
  name: "derive array leak test",
  fn: runTest,
  sanitizeResources: false,
  sanitizeOps: false,
});
