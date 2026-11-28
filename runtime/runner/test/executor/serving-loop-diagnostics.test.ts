import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/logger";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  compileWorkerLoopDiagnostics,
  servingLoopDiagnostics,
} from "../../src/executor/serving-loop-diagnostics.ts";
import {
  COMPILE_WORKER_LOGGER_PREFIX,
  ModuleCompileWorker,
} from "../../src/harness/module-compile-worker.ts";
import {
  Runtime,
  type RuntimeProgram,
  signer,
  StorageManager,
} from "../engine-test-support.ts";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  return { result: value };",
      "});",
    ].join("\n"),
  }],
};

// A timing this realm records itself, so a case can tell this realm's
// statistics from the compile worker's.
const REALM_LOGGER = "serving-loop-diagnostics-test";

describe("serving loop diagnostics", () => {
  let worker: ModuleCompileWorker;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    getLogger(REALM_LOGGER).time(performance.now() - 1, "probe");
    worker = new ModuleCompileWorker();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      moduleCompiler: worker,
    });
  });

  afterEach(async () => {
    worker.close();
    await runtime.dispose();
    await storageManager.close();
  });

  it("servingLoopDiagnostics() returns this realm's timing statistics and no compile worker's without one", () => {
    const { timingStats, loggerCounts } = servingLoopDiagnostics();

    expect(timingStats[REALM_LOGGER]?.probe?.count).toBeGreaterThan(0);
    expect(
      [...Object.keys(timingStats), ...Object.keys(loggerCounts)].some((
        name,
      ) => name.startsWith(COMPILE_WORKER_LOGGER_PREFIX)),
    ).toBe(false);
  });

  it("servingLoopDiagnostics() returns the compile worker's phase timings and log counts beside this realm's", async () => {
    await runtime.harness.compileToRecordGraph(PROGRAM);

    const { timingStats, loggerCounts } = servingLoopDiagnostics(worker);

    expect(timingStats[REALM_LOGGER]?.probe?.count).toBeGreaterThan(0);
    expect(
      timingStats[`${COMPILE_WORKER_LOGGER_PREFIX}js-compiler`]?.[
        "phase/emitFile"
      ]?.count,
    ).toBeGreaterThan(0);
    const workerCounts = Object.entries(worker.diagnostics().loggerCounts);
    expect(workerCounts.length).toBeGreaterThan(0);
    for (const [name, byKey] of workerCounts) {
      for (const [key, counts] of Object.entries(byKey)) {
        expect(loggerCounts[name]?.[key]).toEqual(counts);
      }
    }
  });

  it("compileWorkerLoopDiagnostics() returns the compile worker's diagnostics without this realm's", async () => {
    await runtime.harness.compileToRecordGraph(PROGRAM);

    const { timingStats, loggerCounts } = compileWorkerLoopDiagnostics(worker);

    const workerDiagnostics = worker.diagnostics();
    expect(timingStats).toEqual(workerDiagnostics.timingStats);
    expect(timingStats[REALM_LOGGER]).toBeUndefined();
    const { total, ...byLogger } = loggerCounts;
    const workerCounts = Object.entries(workerDiagnostics.loggerCounts);
    expect(workerCounts.length).toBeGreaterThan(0);
    expect(Object.keys(byLogger).sort()).toEqual(
      workerCounts.map(([name]) => name).sort(),
    );
    let expectedTotal = 0;
    for (const [name, byKey] of workerCounts) {
      const loggerTotal = Object.values(byKey).reduce(
        (sum, counts) => sum + counts.total,
        0,
      );
      expect(loggerCounts[name]).toEqual({ ...byKey, total: loggerTotal });
      expectedTotal += loggerTotal;
    }
    expect(total).toBe(expectedTotal);
  });
});
