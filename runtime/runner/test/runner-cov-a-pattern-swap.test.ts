import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner pattern swap");
const space = signer.did();

// Each version derives one cell from its input, under a name of its own, so
// the cell a version's setup writes is a document the other never reads, and
// which of the two follows a change of the input says which version runs.
const programOf = (key: string, factor: number): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ n: number }>(({ n }) => ({",
      `  ${key}: computed(() => n * ${factor}),`,
      "}));",
      "",
    ].join("\n"),
  }],
});

const V1 = programOf("doubled", 2);
const V2 = programOf("tripled", 3);

const logged = (name: string): number =>
  getLoggerCountsBreakdown().runner?.[name]?.error ?? 0;

type Result = { doubled?: number; tripled?: number };

describe("runner", () => {
  describe("pattern watcher swapping to a live pattern", () => {
    let server: ReturnType<typeof newLoopbackServer>;
    let rt: Runtime;

    const openRuntime = (): Runtime =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
      });

    const closeRuntime = async (runtime: Runtime) => {
      await runtime.idle();
      await runtime.runner.idlePointerMaintenance();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      await runtime.dispose();
    };

    beforeEach(() => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      rt = openRuntime();
    });

    afterEach(async () => {
      await closeRuntime(rt);
      await server.close();
    });

    const settled = async (runtime: Runtime) => {
      await runtime.idle();
      await runtime.runner.idlePointerMaintenance();
      await runtime.storageManager.synced();
      await runtime.idle();
      await runtime.runner.idlePointerMaintenance();
    };

    /** Runs `program` as the piece `name` on `runtime`. */
    const runOn = async (
      runtime: Runtime,
      program: RuntimeProgram,
      name: string,
    ) => {
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(program, {
        space,
        tx,
      }) as Pattern;
      const cell = runtime.getCell<Result>(space, name, undefined, tx);
      const running = runtime.run(tx, pattern, { n: 1 }, cell);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      await settled(runtime);
      return { cell, pattern };
    };

    /** Sets the input of the piece `cell` to `n` on `rt`. */
    const setInput = async (cell: Cell<Result>, n: number) => {
      const tx = rt.edit();
      cell.getArgumentCell<{ n: number }>()!.withTx(tx).key("n").set(n);
      expect((await tx.commit().settled).error).toBeUndefined();
      await settled(rt);
    };

    it("swaps at once to a pattern whose piece has no manifest", async () => {
      const { cell } = await runOn(rt, V1, "no-manifest");
      const v2 = await rt.patternManager.compilePattern(V2, { space });
      const v2Ref = rt.patternManager.getArtifactEntryRef(v2)!;

      const tx = rt.edit();
      const withTx = cell.withTx(tx);
      withTx.setMetaRaw("internal", undefined, rawMetaWriteAuthorization);
      withTx.setMetaRaw("patternIdentity", v2Ref, rawMetaWriteAuthorization);
      expect((await tx.commit().settled).error).toBeUndefined();
      await settled(rt);
      await setInput(cell, 5);

      expect(await cell.pull()).toEqual({ tripled: 15 });
    });

    describe("whose cells another runtime's setup wrote", () => {
      // `writer` moves the piece to `V2` by setting it up again, so the
      // stored manifest lists cells `rt`, which runs the piece, has never
      // held. `rt` names them before it swaps.

      let writer: Runtime;

      beforeEach(() => {
        writer = openRuntime();
      });

      afterEach(async () => {
        await closeRuntime(writer);
      });

      const moveOnWriter = async (name: string, beforeMove = () => {}) => {
        await runOn(writer, V1, name);
        await rt.patternManager.compilePattern(V2, { space });
        const cell = rt.getCell<Result>(space, name);
        expect(await rt.start(cell)).toBe(true);
        expect(await cell.pull()).toEqual({ doubled: 2 });
        beforeMove();
        const moved = await runOn(writer, V2, name);
        writer.runner.stop(moved.cell);
        await settled(rt);
        await setInput(cell, 5);
        return cell;
      };

      it("swaps once it has named them", async () => {
        const cell = await moveOnWriter("named");

        expect(await cell.pull()).toEqual({ tripled: 15 });
        expect(logged("pattern-swap-name-error")).toBe(0);
      });

      it("logs `pattern-swap-name-error`, and keeps the running pattern, when naming them fails", async () => {
        const before = logged("pattern-swap-name-error");

        const cell = await moveOnWriter("unnamed", () => {
          rt.runner.accessForTestingOnly.dependencySyncer = () =>
            Promise.reject(new Error("The store is unreachable"));
        });

        expect(logged("pattern-swap-name-error")).toBe(before + 1);
        // The stored projection is the writer's, and nothing follows the
        // input into it; the cell the running `V1` derives does.
        expect(await cell.pull()).toEqual({ tripled: 3 });
        expect(
          await getDerivedInternalCell(cell, {
            partialCause: Object.freeze(["__patternResult", "doubled"]),
            kind: "computed",
          })
            .pull(),
        ).toBe(10);
      });
    });
  });
});
