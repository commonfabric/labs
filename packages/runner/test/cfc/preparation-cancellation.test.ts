import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { recordReferencedArgumentFields } from "../../src/cfc/reference-initialization.ts";
import { Runtime } from "../../src/runtime.ts";
import { CooperativeYield } from "../../src/scheduler/cooperative-yield.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { TransactionWrapper } from "../../src/storage/extended-storage-transaction.ts";

import { labelsReached } from "../support/reached-labels.ts";
import {
  seedReferenceGraphLeaf,
  stageReferenceGraph,
} from "../support/staged-reference-graph.ts";

const signer = await Identity.fromPassphrase("cfc preparation cancellation");
const space = signer.did();
const rowSchema = {
  type: "object",
  properties: {
    content: {
      type: "string",
      ifc: { confidentiality: [cfcAtom.space(space)] },
    },
  },
} as const;

/**
 * Stages a reference graph of depth `depth` whose holder, staged first,
 * declares a floor nested where the graph reaches its leaf. A reference
 * persists its own label without walking what it reaches; the floor needs
 * the leaf's evidence, and is what makes preparing the holder walk the
 * staged references.
 */
function stageFlooredGraph(runtime: Runtime, depth: number) {
  const graph = stageReferenceGraph(runtime, space, depth, 2, "top-down");
  let slot: JSONSchema = {
    type: "object",
    ifc: { requiredIntegrity: ["leaf-proof"] },
  };
  for (let level = 0; level < depth; level++) {
    slot = { type: "object", properties: { p0: slot } };
  }
  const holder = graph.holder.asSchema({
    type: "object",
    ifc: { integrity: ["object-proof"] },
    properties: { argument: slot },
  });
  holder.set({ argument: graph.nodes[0] });
  recordReferencedArgumentFields(
    graph.tx,
    holder.getAsNormalizedFullLink(),
    ["argument"],
  );
  return { ...graph, holder };
}

function makeRuntime() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });
  return { runtime, storageManager };
}

async function prepareRows(cooperative: boolean, closed: boolean) {
  const { runtime, storageManager } = makeRuntime();
  try {
    const seed = runtime.edit();
    const source = runtime.getCell(space, "source", rowSchema, seed);
    source.set({ content: "message" });
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    try {
      const content = source.withTx(tx).key("content").get();
      const schema = {
        ...rowSchema,
        properties: {
          content: {
            ...rowSchema.properties.content,
            ifc: {
              ...rowSchema.properties.content.ifc,
              ...(closed ? { maxConfidentiality: [] } : {}),
            },
          },
        },
      } as const;
      const rows = Array.from({ length: 3 }, (_, i) => {
        const row = runtime.getCell(space, `row-${i}`, schema, tx);
        row.set({ content });
        return row.getAsNormalizedFullLink();
      });
      if (cooperative) {
        await new TransactionWrapper(tx).prepareForCommitCooperatively(
          new AbortController().signal,
        );
      } else {
        tx.prepareForCommit();
      }
      const prepared = tx.getCfcState().prepare;
      return {
        status: prepared.status,
        reasons: prepared.status === "invalidated" ? prepared.reasons : [],
        documents: rows.map((row) =>
          tx.readOrThrow({ ...row, type: "application/json", path: [] })
        ),
      };
    } finally {
      tx.abort("prepared rows inspected");
    }
  } finally {
    await runtime.dispose({ closeStorage: false });
    await storageManager.synced();
    await storageManager.close();
  }
}

describe("preparation-cancellation", () => {
  it("leaves canceled actions unstarted and aborts only writable transactions", async () => {
    const { runtime, storageManager } = makeRuntime();
    const controller = new AbortController();
    controller.abort("query owner stopped");
    try {
      let runs = 0;
      const outcome = await runtime.editWithRetry(() => runs++, 3, {
        signal: controller.signal,
      });
      expect(outcome.error?.name).toBe("StorageTransactionAborted");
      expect(runs).toBe(0);
      const read = runtime.readTx();
      await read.prepareForCommitCooperatively(controller.signal);
      expect(read.status().status).toBe("ready");
      expect(read.getCfcState().prepare.status).toBe("unprepared");
      const write = runtime.edit();
      await new TransactionWrapper(write).prepareForCommitCooperatively(
        controller.signal,
      );
      expect((await write.commit().settled).error?.name).toBe(
        "StorageTransactionAborted",
      );
      expect(write.getCfcState().prepare.status).toBe("unprepared");
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.synced();
      await storageManager.close();
    }
  });

  it("discards prepared writes canceled before their commit continuation", async () => {
    const { runtime, storageManager } = makeRuntime();
    const controller = new AbortController();
    using _slices = stub(
      CooperativeYield.prototype,
      "maybeYield",
      () => undefined,
    );
    try {
      const outcome = runtime.editWithRetry(
        (tx) => {
          runtime.getCell(space, "prepared-row", rowSchema, tx)
            .set({ content: "message" });
        },
        0,
        { signal: controller.signal },
      );
      controller.abort("query owner stopped");
      expect((await outcome).error?.name).toBe("StorageTransactionAborted");
      expect(
        runtime.getCell(space, "prepared-row", rowSchema, runtime.readTx())
          .get(),
      ).toBeUndefined();
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.synced();
      await storageManager.close();
    }
  });

  it("observes owner cancellation between targets without committing or retrying", async () => {
    const { runtime, storageManager } = makeRuntime();
    const controller = new AbortController();
    const canceled = Promise.withResolvers<void>();
    const preparedTargets = new Set<string>();
    const count = 12;
    let runs = 0;
    // Spend each cooperative work slice deterministically; cancellation
    // itself still arrives through the macrotask queue the runtime must yield.
    using _slices = stub(
      CooperativeYield.prototype,
      "maybeYield",
      function (this: CooperativeYield) {
        return this.yieldNow();
      },
    );
    try {
      const outcome = await runtime.editWithRetry(
        (tx) => {
          runs++;
          const write = tx.writeOrThrow.bind(tx);
          tx.writeOrThrow = (address, value, options) => {
            const result = write(address, value, options);
            if (address.path[0] === "cfc") {
              preparedTargets.add(address.id);
              if (preparedTargets.size === 1) {
                setTimeout(() => {
                  controller.abort("query owner stopped");
                  canceled.resolve();
                }, 0);
              }
            }
            return result;
          };
          for (let i = 0; i < count; i++) {
            runtime.getCell(space, `canceled-row-${i}`, rowSchema, tx)
              .set({ content: "message" });
          }
        },
        3,
        { signal: controller.signal },
      );
      await canceled.promise;

      expect(preparedTargets.size).toBeGreaterThan(0);
      expect(preparedTargets.size).toBeLessThan(count);
      expect(outcome.error?.name).toBe("StorageTransactionAborted");
      expect(runs).toBe(1);
      const read = runtime.readTx();
      for (let i = 0; i < count; i++) {
        expect(
          runtime.getCell(space, `canceled-row-${i}`, rowSchema, read).get(),
        ).toBeUndefined();
      }
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.synced();
      await storageManager.close();
    }
  });

  it("cancels a staged-reference walk before its first target persists", async () => {
    const { runtime, storageManager } = makeRuntime();
    try {
      await seedReferenceGraphLeaf(runtime, space);
      const { tx, holder } = stageFlooredGraph(runtime, 5);
      runtime.resetCfcStats();
      const preparedTargets = new Set<string>();
      const write = tx.writeOrThrow.bind(tx);
      tx.writeOrThrow = (address, value, options) => {
        const result = write(address, value, options);
        if (address.path[0] === "cfc") preparedTargets.add(address.id);
        return result;
      };
      const controller = new AbortController();
      let cancellationScheduled = false;
      using _slices = stub(
        CooperativeYield.prototype,
        "maybeYield",
        function (this: CooperativeYield) {
          if (
            runtime.getCfcStats().stagedReferenceDerivations < 4
          ) return undefined;
          if (!cancellationScheduled) {
            cancellationScheduled = true;
            setTimeout(() => controller.abort("query owner stopped"), 0);
          }
          return this.yieldNow();
        },
      );
      await tx.prepareForCommitCooperatively(controller.signal);
      expect(controller.signal.aborted).toBe(true);
      expect((await tx.commit().settled).error?.name).toBe(
        "StorageTransactionAborted",
      );
      expect(preparedTargets.size).toBe(0);
      expect(holder.withTx(runtime.readTx()).get()).toBeUndefined();
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.synced();
      await storageManager.close();
    }
  });

  it("preserves every prepared label across yields within a floor's reference walk", async () => {
    const depth = 5;
    const prepare = async (cooperative: boolean) => {
      const { runtime, storageManager } = makeRuntime();
      try {
        await seedReferenceGraphLeaf(runtime, space);
        const { tx, holder, nodes } = stageFlooredGraph(runtime, depth);
        if (cooperative) {
          await tx.prepareForCommitCooperatively(new AbortController().signal);
        } else tx.prepareForCommit();
        expect((await tx.commit().settled).error).toBeUndefined();
        return {
          labelMaps: [holder, ...nodes].map((cell) =>
            readStoredCfcMetadata(
              runtime.readTx(),
              cell.getAsNormalizedFullLink(),
            )?.labelMap
          ),
          reached: labelsReached(runtime, holder.getAsNormalizedFullLink(), [
            "argument",
            ...Array.from({ length: depth }, (_, level) => `p${level % 2}`),
          ]),
        };
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.synced();
        await storageManager.close();
      }
    };
    const synchronous = await prepare(false);
    using _slices = stub(
      CooperativeYield.prototype,
      "maybeYield",
      function (this: CooperativeYield) {
        return this.yieldNow();
      },
    );
    const cooperative = await prepare(true);
    expect(cooperative).toEqual(synchronous);
    // The holder stores its own label alone; the leaf's labels are reached
    // through the graph rather than stored along it.
    expect(cooperative.labelMaps[0]?.entries.map((entry) => entry.path))
      .toEqual([[]]);
    expect(cooperative.reached.confidentiality).toContain("secret");
    expect(cooperative.reached.integrity).toContain("leaf-proof");
  });

  for (const closed of [false, true]) {
    it(
      closed
        ? "retains every ceiling refusal across cooperative yields"
        : "retains complete prepared row labels across cooperative yields",
      async () => {
        using _slices = stub(
          CooperativeYield.prototype,
          "maybeYield",
          function (this: CooperativeYield) {
            return this.yieldNow();
          },
        );
        const synchronous = await prepareRows(false, closed);
        const cooperative = await prepareRows(true, closed);
        expect(cooperative).toEqual(synchronous);
        if (closed) {
          expect(cooperative.status).toBe("invalidated");
          expect(cooperative.reasons).toHaveLength(3);
          expect(
            cooperative.reasons.every((reason) =>
              reason.includes("maxConfidentiality")
            ),
          ).toBe(true);
        } else {
          expect(cooperative.status).toBe("prepared");
          expect(cooperative.documents[0]).toMatchObject({
            value: { content: "message" },
            cfc: {
              labelMap: {
                entries: expect.arrayContaining([
                  expect.objectContaining({
                    label: { confidentiality: [cfcAtom.space(space)] },
                  }),
                ]),
              },
            },
          });
        }
      },
    );
  }

  for (const duringDerivation of [false, true]) {
    it(
      duringDerivation
        ? "aborts a transaction changed during reference derivation without granting write privilege"
        : "aborts a transaction changed during a yield without granting write privilege",
      async () => {
        const { runtime, storageManager } = makeRuntime();
        const turn = Promise.withResolvers<void>();
        let yielded = false;
        using _slices = stub(CooperativeYield.prototype, "maybeYield", () => {
          if (
            duringDerivation &&
            runtime.getCfcStats().stagedReferenceDerivations < 4
          ) {
            return undefined;
          }
          yielded = true;
          return turn.promise;
        });
        try {
          let tx;
          let row;
          if (duringDerivation) {
            await seedReferenceGraphLeaf(runtime, space);
            ({ tx, holder: row } = stageFlooredGraph(runtime, 5));
            runtime.resetCfcStats();
          } else {
            tx = runtime.edit();
            row = runtime.getCell(space, "changed-row", rowSchema, tx);
            row.set({ content: "message" });
          }
          const preparation = tx.prepareForCommitCooperatively(
            new AbortController().signal,
          );
          expect(yielded).toBe(true);
          tx.writeOrThrow({
            ...row.getAsNormalizedFullLink(),
            type: "application/json",
            path: ["cfc"],
          }, { version: 1 });
          expect(tx.getCfcState().unprivilegedSystemWrites.length)
            .toBeGreaterThan(
              0,
            );
          turn.resolve();
          await preparation;
          expect((await tx.commit().settled).error?.name).toBe(
            "StorageTransactionAborted",
          );
          expect(tx.getCfcState().prepare.status).toBe("unprepared");
        } finally {
          turn.resolve();
          await runtime.dispose({ closeStorage: false });
          await storageManager.synced();
          await storageManager.close();
        }
      },
    );
  }
});
