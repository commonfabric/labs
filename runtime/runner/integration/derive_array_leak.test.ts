#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Checks that building and tearing down a view over a derived array, again
 * and again, retains no memory that V8 accounts for in the test's own
 * isolate, which runs the derivation and renders the view, nor in the
 * Toolshed at `API_URL`, which stores every commit and, with server execution
 * on, runs the pattern's handlers and computations too. Memory V8 does not
 * account for, such as SQLite's, is out of its reach.
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
 * Both are measured after a full garbage collection, as the heap and the
 * memory outside it that V8 accounts for: the test's isolate here, and the
 * server's main thread and serving-loop worker through
 * `/api/health/collected-memory`, which a server started with
 * `EXPOSE_GC=true` answers. That reading does not depend on when the
 * collector last ran, nor on which pages the operating system has compressed
 * or swapped out, so its limit only has to leave room for bounded structures
 * that are still filling, such as timing reservoirs and caches. Retention
 * smaller than that limit across the measured cycles passes. Each test file
 * runs in an isolate of its own, so the client reading leaves other files
 * out. The server reading covers whatever else the server is doing.
 */

import { toCompactDebugString } from "@commonfabric/data-model";
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
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import {
  type CollectedMemory,
  collectedMemory,
  exposeGarbageCollector,
} from "../src/collected-memory.ts";
import { compileAndSavePattern, Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const { API_URL } = env;

// Cycles run before the baseline, and cycles measured after it.
const WARM_UP_CYCLES = 30;
const MEASURED_CYCLES = 20;

// The most the isolate and the server may grow across the measured cycles.
// Without a leak, on a Mac, the isolate grew at most 1 MB and the server at
// most 5 MB, with server execution off, and on with the serving loop in a
// worker and on the main thread.
const MAX_CLIENT_GROWTH_MB = 16;
const MAX_SERVER_GROWTH_MB = 16;

const MB = 1024 * 1024;

/** Returns an isolate's live memory in megabytes. */
const megabytes = ({ heapUsed, external }: CollectedMemory) =>
  (heapUsed + external) / MB;

/** Returns the memory this isolate holds live, in megabytes. */
function getClientMemoryMB(): number {
  return megabytes(collectedMemory());
}

/**
 * Returns the memory the threads of the Toolshed at `API_URL` hold live, in
 * megabytes.
 */
async function getServerMemoryMB(): Promise<number> {
  const url = new URL("api/health/collected-memory", API_URL);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `${url} answered ${response.status}: ${await response.text()}`,
    );
  }
  const { mainThread, servingLoopWorker }: {
    mainThread?: CollectedMemory;
    servingLoopWorker?: CollectedMemory;
  } = await response.json();
  if (mainThread === undefined) {
    throw new Error(`${url} reported no \`mainThread\``);
  }
  const total = megabytes(mainThread) +
    (servingLoopWorker === undefined ? 0 : megabytes(servingLoopWorker));
  if (!Number.isFinite(total)) {
    throw new Error(`${url} reported a reading that is not a number`);
  }
  return total;
}

async function runTest() {
  exposeGarbageCollector();
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
    let onChange = (_source: "counter" | "applied") => {};
    const render = renderInProcess(
      container,
      result.asSchema(uiSchema).key(UI),
      {
        document: mock.document,
        setProp: mock.renderOptions.setProp,
        onError: fail,
        onApplied: () => onChange("applied"),
      },
    );
    const cancelValueSink = piece.key("value").sink(() => onChange("counter"));
    try {
      // Sends one click, and waits until the counter is `expected` and the
      // view shows that many elements. Where the server runs the handler,
      // the value arrives from the server, which neither the runtime going
      // idle nor the server confirming this runtime's commits waits for.
      const click = async (
        cycle: string,
        stream: "increment" | "decrement",
        expected: number,
      ) => {
        if (failure) throw failure;
        const label =
          `derive array leak: ${cycle}, ${stream}, expected ${expected}`;
        let stage = "send";
        const wait = shown = defer();
        // Keep only the last notifications for this click, using the reads
        // already needed to recognize its completion.
        const notifications: {
          source: "counter" | "applied";
          value: number;
          items: number | undefined;
        }[] = [];
        onChange = (source) => {
          const items = mock.document.getElementById("items")
            ?.getElementsByTagName("i").length;
          const value = piece.get().value;
          notifications.push({ source, value, items });
          if (notifications.length > 16) notifications.shift();
          if (value === expected && items === expected) {
            wait.resolve();
          }
        };
        try {
          // A live server keeps the event loop open even when this click
          // cannot finish. Cover each settling stage with the shared net.
          await withStuckNet(
            (async () => {
              piece.key(stream).send({});
              stage = "counter and view";
              await wait.promise;
              shown = undefined;
              stage = "runtime idle";
              await runtime.idle();
              stage = "storage synced";
              await runtime.storageManager.synced();
            })(),
            label,
          );
        } catch (error) {
          // Read diagnostic state only on failure: cell reads can take
          // document holds and affect the memory this test measures.
          const readDiagnostic = <T>(read: () => T): T | string => {
            try {
              return read();
            } catch (error) {
              return `Diagnostic unavailable: ${String(error)}`;
            }
          };
          // Capture demand and pending work before diagnostic cell reads
          // can start loading documents. Nothing here waits for settlement.
          const scheduler = readDiagnostic(() => runtime.scheduler.getStats());
          const schedulerSizes = readDiagnostic(() =>
            runtime.scheduler.getSizes()
          );
          const graph = readDiagnostic(() =>
            runtime.scheduler.getGraphSnapshot()
          );
          const storage = readDiagnostic(() => storageManager.getDiagnostics());
          const mappedItems = readDiagnostic(() => {
            // The fixture's second div contains its mapped array. Resolve
            // that slot to identify the publication its renderer sink reads.
            const cell = result.asSchema(true).key(UI).key("children").key(1)
              .key("children").key(0).resolveAsCell();
            const value = cell.getRawUntyped();
            return {
              link: cell.getAsNormalizedFullLink(),
              length: Array.isArray(value) ? value.length : undefined,
              value,
            };
          });
          const mapActions = readDiagnostic(() => {
            if (typeof graph === "string" || typeof mappedItems === "string") {
              return "Map actions unavailable without graph and mapped items";
            }
            const id = mappedItems.link.id;
            return graph.nodes.filter((node) =>
              node.id.includes(id) ||
              [
                ...node.reads ?? [],
                ...node.shallowReads ?? [],
                ...node.writes ?? [],
              ].some((address) => address.includes(id))
            ).map((node) => ({
              ...node,
              // A list sink also reads each rendered row. Keep its reads
              // of the list itself in this excerpt; the full graph follows.
              reads: node.reads?.filter((address) => address.includes(id)),
              shallowReads: node.shallowReads?.filter((address) =>
                address.includes(id)
              ),
            }));
          });
          // Large snapshots are bounded separately so the graph cannot
          // crowd the map publication or rendered view out of the report.
          const snapshot = (value: unknown, limit: number) =>
            toCompactDebugString(value, {
              maxLength: limit,
              maxDepth: 12,
              maxArrayLength: 1000,
              maxStringLength: 16_384,
            });
          // Print before disposal, which can itself wait on the scheduler.
          console.error(label, {
            error: failure ?? error,
            stage,
            value: readDiagnostic(() => piece.get().value),
            items: readDiagnostic(() =>
              mock.document.getElementById("items")
                ?.getElementsByTagName("i").length
            ),
            notifications,
            scheduler,
            schedulerSizes,
            storage,
          });
          console.error("Mapped items:", snapshot(mappedItems, 16_384));
          console.error("Map actions:", snapshot(mapActions, 32_768));
          console.error(
            "Rendered view:",
            snapshot(readDiagnostic(() => container.innerHTML), 16_384),
          );
          console.error("Scheduler graph:", snapshot(graph, 262_144));
          throw failure ?? error;
        } finally {
          shown = undefined;
        }
      };
      const cycle = async (label: string) => {
        await click(label, "increment", piece.get().stepsPerClick);
        await click(label, "decrement", 0);
      };

      console.log("derive array leak: warmup cycles");
      for (let i = 0; i < WARM_UP_CYCLES; i++) {
        await cycle(`warmup cycle ${i + 1}/${WARM_UP_CYCLES}`);
      }
      console.log("derive array leak: baseline client memory");
      const clientBeforeMB = getClientMemoryMB();
      console.log("derive array leak: baseline server memory");
      const serverBeforeMB = await getServerMemoryMB();
      console.log("derive array leak: measured cycles");
      for (let i = 0; i < MEASURED_CYCLES; i++) {
        await cycle(`measured cycle ${i + 1}/${MEASURED_CYCLES}`);
      }
      console.log("derive array leak: final client memory");
      const clientGrowthMB = getClientMemoryMB() - clientBeforeMB;
      console.log("derive array leak: final server memory");
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
          `The server retained ${serverGrowthMB.toFixed(1)} MB across ` +
            `${MEASURED_CYCLES} cycles (limit ${MAX_SERVER_GROWTH_MB} MB)`,
        );
      }
    } finally {
      console.log("derive array leak: view cleanup");
      cancelValueSink();
      render.cancel();
    }
  } finally {
    console.log("derive array leak: runtime disposal");
    await runtime.dispose();
    console.log("derive array leak: storage close");
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
