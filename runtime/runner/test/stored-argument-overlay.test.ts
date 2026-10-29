/** Checks shared-link validation work and preservation of each defaulted view. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("stored-argument-overlay");

/** Supplies the candidate contract to validation without executing a graph. */
function candidate(argumentSchema: JSONSchema): Pattern {
  return { argumentSchema, resultSchema: true, result: {}, nodes: [] };
}

describe("runner", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.idle();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  it("validates the argument link staged in the supplied transaction", async () => {
    const committed = runtime.getCell(signer.did(), "committed");
    const staged = runtime.getCell(signer.did(), "staged");
    const piece = runtime.getCell(signer.did(), "piece");
    const { error } = await runtime.editWithRetry((tx) => {
      committed.withTx(tx).set({ count: 7 });
      staged.withTx(tx).set({ count: "wrong" });
      piece.withTx(tx).setMetaRaw(
        "argument",
        committed.getAsLink(),
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const schema = candidate({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    const tx = runtime.edit();
    try {
      piece.withTx(tx).setMetaRaw(
        "argument",
        staged.getAsLink(),
        rawMetaWriteAuthorization,
      );
      expect(() => runtime.runner.validateStoredArgument(tx, piece, schema))
        .toThrow("count: value does not match type number");
      expect(() =>
        runtime.runner.validateStoredArgument(runtime.readTx(), piece, schema)
      ).not.toThrow();
    } finally {
      tx.abort();
    }
  });

  it("bounds shared-graph reads while refusing a readable invalid argument", async () => {
    const graphIds = new Set<string>();
    const argument = runtime.getCell(signer.did(), "argument");
    const piece = runtime.getCell(signer.did(), "piece");
    const { error } = await runtime.editWithRetry((tx) => {
      let next: Cell<unknown> = runtime.getCell(
        signer.did(),
        "leaf",
        undefined,
        tx,
      );
      next.set({ label: "leaf" });
      graphIds.add(next.getAsNormalizedFullLink().id);
      for (let depth = 0; depth < 12; depth++) {
        const node = runtime.getCell(
          signer.did(),
          `node-${depth}`,
          undefined,
          tx,
        );
        node.set({ left: next, right: next });
        graphIds.add(node.getAsNormalizedFullLink().id);
        next = node;
      }
      argument.withTx(tx).set({ count: "wrong", graph: next });
      piece.withTx(tx).setMetaRaw(
        "argument",
        argument.getAsLink(),
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const schema = candidate({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    const tx = runtime.readTx();
    using reads = spy(tx, "read");
    expect(() => runtime.runner.validateStoredArgument(tx, piece, schema))
      .toThrow("count: value does not match type number");
    const graphReads = reads.calls.filter((call) =>
      graphIds.has(call.args[0].id)
    );
    expect(graphReads.length).toBeGreaterThan(0);
    expect(graphReads.length).toBeLessThan(100 * graphIds.size);
    expect(argument.getRaw()).toMatchObject({ count: "wrong" });
  });

  it("keeps distinct defaults when two views share an unreadable descendant", async () => {
    const argument = runtime.getCell(signer.did(), "argument");
    const piece = runtime.getCell(signer.did(), "piece");
    const missing = runtime.getCell(signer.did(), "missing");
    const { error } = await runtime.editWithRetry((tx) => {
      const shared = runtime.getCell(signer.did(), "shared", undefined, tx);
      shared.set({ name: missing });
      argument.withTx(tx).set({ left: shared, right: shared });
      piece.withTx(tx).setMetaRaw(
        "argument",
        argument.getAsLink(),
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const view = (label: string): JSONSchema => ({
      type: "object",
      properties: {
        name: { type: "string" },
        label: { type: "string", const: label, default: label },
      },
      required: ["name", "label"],
    });
    const schema = candidate({
      type: "object",
      properties: { left: view("Glaze"), right: view("Sprinkles") },
      required: ["left", "right"],
    });
    expect(() =>
      runtime.runner.validateStoredArgument(runtime.readTx(), piece, schema)
    ).not.toThrow();

    const { error: invalidWrite } = await runtime.editWithRetry((tx) => {
      missing.withTx(tx).set(42);
    });
    expect(invalidWrite).toBeUndefined();
    expect(() =>
      runtime.runner.validateStoredArgument(runtime.readTx(), piece, schema)
    ).toThrow("name: value does not match type string");
  });

  it("preserves a readable view when a raw alias reaches an active ancestor", async () => {
    const argument = runtime.getCell(signer.did(), "argument");
    const piece = runtime.getCell(signer.did(), "piece");
    const name = runtime.getCell(signer.did(), "missing-name");
    const graph = runtime.getCell(signer.did(), "graph");
    const alias = runtime.getCell(signer.did(), "alias");
    const { error } = await runtime.editWithRetry((tx) => {
      graph.withTx(tx).set({ label: "Glaze", child: alias });
      alias.withTx(tx).set(graph);
      argument.withTx(tx).set({ name, graph });
      piece.withTx(tx).setMetaRaw(
        "argument",
        argument.getAsLink(),
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const schema = candidate({
      type: "object",
      properties: {
        name: { type: "string" },
        graph: {
          type: "object",
          properties: {
            label: { type: "string" },
            child: {
              type: "object",
              properties: { label: { type: "string" } },
              required: ["label"],
            },
          },
          required: ["label", "child"],
        },
      },
      required: ["name", "graph"],
    });
    expect(() =>
      runtime.runner.validateStoredArgument(runtime.readTx(), piece, schema)
    ).not.toThrow();

    const { error: invalidWrite } = await runtime.editWithRetry((tx) => {
      graph.withTx(tx).set({ label: 42, child: alias });
    });
    expect(invalidWrite).toBeUndefined();
    expect(() =>
      runtime.runner.validateStoredArgument(runtime.readTx(), piece, schema)
    ).toThrow("label: value does not match type string");
  });
});
