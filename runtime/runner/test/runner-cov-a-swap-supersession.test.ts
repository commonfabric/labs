import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner swap supersession");
const space = signer.did();

type Result = { out: number };

describe("runner", () => {
  describe("pattern watcher swap superseded while its setup is pending", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let rt: Runtime;
    let prepare: Runtime["prepareTxForCommit"];

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
      prepare = rt.prepareTxForCommit;
    });

    afterEach(async () => {
      rt.prepareTxForCommit = prepare;
      await rt.idle();
      await rt.runner.idlePointerMaintenance();
      await rt.dispose();
      await storageManager.close();
    });

    /** Associates `pattern`, trusted, with an identity named for `name`. */
    const known = (pattern: Pattern, name: string) => {
      const ref = { identity: `test-swap-${name}`, symbol: "default" };
      const trusted = trustPattern(rt, pattern);
      rt.patternManager.associatePatternIdentity(trusted, ref);
      return { pattern: trusted, ref };
    };

    /** A known pattern that multiplies its input by `factor`. */
    const scaling = (factor: number) =>
      known({
        argumentSchema: {
          type: "object",
          properties: { n: { type: "number" } },
        },
        resultSchema: {
          type: "object",
          properties: { out: { type: "number" } },
        },
        result: { out: { $alias: { partialCause: "out", path: [] } } },
        nodes: [{
          module: {
            type: "javascript",
            implementation: (n: number) => n * factor,
          },
          inputs: { $alias: { cell: "argument", path: ["n"] } },
          outputs: { $alias: { partialCause: "out", path: [] } },
        }],
      }, `scaling-${factor}`);

    /** Runs `pattern` as the piece `name` with input 1. */
    const runPiece = async (pattern: Pattern, name: string) => {
      const tx = rt.edit();
      const cell = rt.getCell<Result>(space, name, undefined, tx);
      const running = rt.run(tx, pattern, { n: 1 }, cell);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      await settled();
      return cell;
    };

    const settled = async () => {
      await rt.idle();
      await rt.runner.idlePointerMaintenance();
      await rt.idle();
      await rt.runner.idlePointerMaintenance();
    };

    const movePointer = async (
      cell: Cell<Result>,
      ref: { identity: string; symbol: string },
    ) => {
      const tx = rt.edit();
      cell.withTx(tx).setMetaRaw(
        "patternIdentity",
        ref,
        rawMetaWriteAuthorization,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    const setInput = async (cell: Cell<Result>, n: number) => {
      const tx = rt.edit();
      cell.getArgumentCell<{ n: number }>()!.withTx(tx).key("n").set(n);
      expect((await tx.commit().settled).error).toBeUndefined();
      await settled();
    };

    /**
     * Holds the settlement of every setup the watcher stages for `pieceId`
     * until the returned promise's resolver runs. Each setup still applies
     * locally when it commits.
     */
    const holdWatcherSetups = (pieceId: string) => {
      const settle = Promise.withResolvers<void>();
      rt.prepareTxForCommit = (tx: IExtendedStorageTransaction) => {
        const stagesSetup = [...tx.getWriteDetails?.(space) ?? []].some((
          { address },
        ) =>
          address.id === pieceId && address.path[0] === "patternSetupIdentity"
        );
        if (stagesSetup) {
          const commit = tx.commit.bind(tx);
          tx.commit = (...args) => {
            const receipt = commit(...args);
            return Object.create(receipt, {
              settled: { value: settle.promise.then(() => receipt.settled) },
            });
          };
        }
        prepare.call(rt, tx);
      };
      return settle;
    };

    it("runs the pattern a second move names, not the one whose setup it overtook", async () => {
      const doubled = scaling(2);
      const tripled = scaling(3);
      const quadrupled = scaling(4);
      const cell = await runPiece(doubled.pattern, "overtaken-setup");
      expect(cell.get()).toEqual({ out: 2 });

      const settle = holdWatcherSetups(cell.getAsNormalizedFullLink().id);
      await movePointer(cell, tripled.ref);
      await rt.idle();
      await movePointer(cell, quadrupled.ref);
      await rt.idle();
      settle.resolve();
      await settled();
      await setInput(cell, 5);

      expect(await cell.pull()).toEqual({ out: 20 });
    });

    describe("while the authority the first move inherits is read", () => {
      // A move whose history records an update to the incoming pattern reads
      // the authority that pattern inherits before it swaps. The read is
      // held until `release` runs.

      let release: () => void;
      let reading: Promise<void>;

      beforeEach(() => {
        const gate = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        release = gate.resolve;
        reading = started.promise;
        rt.patternManager.readInheritedAuthority = () => {
          started.resolve();
          return gate.promise;
        };
      });

      /** Moves `cell` to `ref` with a history recording the update. */
      const moveWithHistory = async (
        cell: Cell<Result>,
        ref: { identity: string; symbol: string },
      ) => {
        const tx = rt.edit();
        const withTx = cell.withTx(tx);
        withTx.setMetaRaw("pieceSourceHistory", [{
          revisionId: "update",
          timestamp: 1,
          pattern: ref,
          source: rt.getCell(space, `pattern:${ref.identity}`, undefined, tx)
            .getAsLink(),
          operation: "origin-update",
        }], rawMetaWriteAuthorization);
        withTx.setMetaRaw("patternIdentity", ref, rawMetaWriteAuthorization);
        expect((await tx.commit().settled).error).toBeUndefined();
        await reading;
      };

      it("swaps to the incoming pattern once the read settles", async () => {
        const doubled = scaling(2);
        const tripled = scaling(3);
        const cell = await runPiece(doubled.pattern, "inherits");

        await moveWithHistory(cell, tripled.ref);
        release();
        await settled();
        await setInput(cell, 5);

        expect(await cell.pull()).toEqual({ out: 15 });
      });

      it("runs the pattern a second move names, not the one whose read it overtook", async () => {
        const doubled = scaling(2);
        const tripled = scaling(3);
        const quadrupled = scaling(4);
        const cell = await runPiece(doubled.pattern, "overtaken-read");

        await moveWithHistory(cell, tripled.ref);
        await movePointer(cell, quadrupled.ref);
        release();
        await settled();
        await setInput(cell, 5);

        expect(await cell.pull()).toEqual({ out: 20 });
      });
    });

    it("logs `pattern-swap-setup-error` when the incoming pattern's graph cannot be instantiated", async () => {
      const doubled = scaling(2);
      const broken = known({
        argumentSchema: {
          type: "object",
          properties: { n: { type: "number" } },
        },
        resultSchema: {},
        result: { child: { $alias: { partialCause: "child", path: [] } } },
        nodes: [{
          module: { type: "pattern", implementation: "not a pattern" },
          inputs: {},
          outputs: { $alias: { partialCause: "child", path: [] } },
        }],
      }, "broken");
      const cell = await runPiece(doubled.pattern, "broken-swap");
      const before = getLoggerCountsBreakdown().runner?.[
        "pattern-swap-setup-error"
      ]?.error ?? 0;

      await movePointer(cell, broken.ref);
      await settled();

      expect(
        getLoggerCountsBreakdown().runner?.["pattern-swap-setup-error"]
          ?.error ?? 0,
      ).toBe(before + 1);
    });
  });
});
