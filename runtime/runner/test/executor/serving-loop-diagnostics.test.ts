import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/logger";

import { servingLoopDiagnostics } from "../../src/executor/serving-loop-diagnostics.ts";
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

describe("servingLoopDiagnostics()", () => {
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

  it("returns this realm's timing statistics and no compile worker's without one", async () => {
    const { timingStats } = await servingLoopDiagnostics();

    expect(timingStats[REALM_LOGGER]?.probe?.count).toBeGreaterThan(0);
    expect(
      Object.keys(timingStats).some((name) =>
        name.startsWith(COMPILE_WORKER_LOGGER_PREFIX)
      ),
    ).toBe(false);
  });

  it("returns the compile worker's phase timings beside this realm's", async () => {
    await runtime.harness.compileToRecordGraph(PROGRAM);

    const { timingStats } = await servingLoopDiagnostics(worker);

    expect(timingStats[REALM_LOGGER]?.probe?.count).toBeGreaterThan(0);
    expect(
      timingStats[`${COMPILE_WORKER_LOGGER_PREFIX}js-compiler`]?.[
        "phase/emitFile"
      ]?.count,
    ).toBeGreaterThan(0);
  });
});
