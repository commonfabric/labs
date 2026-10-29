import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import type { SchedulerGraphNode } from "../../src/telemetry.ts";

const signer = await Identity.fromPassphrase("graph snapshot source sites");
const space = signer.did();

// One lift, declared on line 2 of the module and applied once by the pattern.
// The transformer records the position of the `lift(...)` call, so the site the
// snapshot reports is that declaration rather than the application below it.
const ONE_LIFT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, lift } from 'commonfabric';",
      "const doubled = lift((n: number) => n * 2);",
      "export default pattern<{ value: number }>(({ value }) => ({",
      "  doubled: doubled(value),",
      "}));",
    ].join("\n"),
  }],
};

/** Runs `program` and answers with the scheduler graph it built. */
async function runAndSnapshot(
  program: RuntimeProgram,
  argument: Record<string, number>,
): Promise<SchedulerGraphNode[]> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const compiled = await runtime.patternManager.compilePattern(program);
    const tx = runtime.edit();
    const resultCell = runtime.getCell<unknown>(
      space,
      "snapshot",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, argument, resultCell);
    await tx.commit().settled;
    await handle.pull();
    await runtime.idle();
    return runtime.scheduler.getGraphSnapshot().nodes;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("graph-snapshot", () => {
  describe("buildSchedulerGraphSnapshot()", () => {
    let nodes: SchedulerGraphNode[];
    let lift: SchedulerGraphNode;

    beforeAll(async () => {
      nodes = await runAndSnapshot(ONE_LIFT_PROGRAM, { value: 5 });
      const lifts = nodes.filter((node) => node.id.startsWith("cf:module/"));
      expect(lifts.length).toBe(1);
      lift = lifts[0];
    });

    it("reports the authored site of a lift as `src`", () => {
      expect(lift.src).toMatch(/^cf:module\/[^/]+\/main\.tsx:2:\d+$/);
    });

    it("reports a `src` under the module identity the action id carries", () => {
      const identity = lift.id.slice("cf:module/".length).split(":")[0];

      expect(lift.src?.startsWith(`cf:module/${identity}/`)).toBe(true);
    });

    it("reports no `src` for an input node", () => {
      const inputs = nodes.filter((node) => node.type === "input");

      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) expect(input.src).toBeUndefined();
    });
  });
});
