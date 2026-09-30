/** Keeps targeted input reads inside the projection chosen by their parents. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece input projection paths");

describe("piece input paths", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      await createSession({ identity: signer, spaceName: crypto.randomUUID() }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /** Installs a schema fixture through the normal persistent-piece setup. */
  async function create(
    schema: JSONSchema,
    input: unknown,
  ): Promise<PieceController> {
    const pattern = runtime.unsafeTrustPattern({
      argumentSchema: schema,
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    }, { reason: "input projection regression fixture" });
    return new PieceController(
      pieces,
      await pieces.runPersistent(pattern, input, undefined, { start: true }),
    );
  }

  it("refuses a field exposed only by an inactive union branch", async () => {
    const piece = await create({
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { b: { type: "string" }, c: { type: "string" } },
          required: ["c"],
        },
      ],
    }, { a: "yes", b: "hidden" });
    expect(await piece.input.get()).toEqual({ a: "yes" });
    await expect(piece.input.get(["b"])).rejects.toThrow(
      'property "b" not found',
    );
    await expect(piece.input.getCell(["b"])).rejects.toThrow(
      'property "b" not found',
    );
    expect(await piece.input.get(["a"])).toBe("yes");
  });

  it("retains branch projections when descending and selecting containers", async () => {
    const piece = await create({
      anyOf: [
        {
          type: "object",
          properties: {
            a: { type: "string" },
            obj: {
              type: "object",
              properties: { visible: { type: "string" } },
            },
          },
          required: ["a"],
        },
        {
          type: "object",
          properties: {
            c: { type: "string" },
            obj: { type: "object", properties: { hidden: { type: "number" } } },
          },
          required: ["c"],
        },
      ],
    }, { a: "yes", obj: { visible: "kept", hidden: 3 } });
    expect(await piece.input.get(["obj"])).toEqual({ visible: "kept" });
    await expect(piece.input.get(["obj", "hidden"])).rejects.toThrow(
      'property "hidden" not found',
    );
    expect((await piece.input.getCell(["obj"])).get()).toEqual({
      visible: "kept",
    });
  });

  it("preserves branch-local scalar and object defaults in selected cells", async () => {
    const piece = await create({
      anyOf: [
        {
          type: "object",
          properties: {
            a: { type: "string" },
            leaf: { type: "string", default: "A" },
            obj: {
              type: "object",
              properties: { value: { type: "string" } },
              default: { value: "A" },
            },
          },
          required: ["a"],
        },
        {
          type: "object",
          properties: {
            c: { type: "string" },
            leaf: { type: "string", default: "B" },
            obj: {
              type: "object",
              properties: { value: { type: "string" } },
              default: { value: "B" },
            },
          },
          required: ["c"],
        },
      ],
    }, { a: "yes" });
    expect(await piece.input.get(["leaf"])).toBe("A");
    expect((await piece.input.getCell(["leaf"])).get()).toBe("A");
    expect((await piece.input.getCell(["obj"])).get()).toEqual({ value: "A" });
  });

  it("reads array length without admitting length as a link destination", async () => {
    const piece = await create({
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
    }, { items: ["one", "two"] });
    expect(await piece.input.get(["items", "length"])).toBe(2);
    expect((await piece.input.getCell(["items", "length"])).get()).toBe(2);
    await expect(pieces.link(piece.id, [], piece.id, ["items", "length"]))
      .rejects.toThrow("current pattern's input schema");
    await expect(piece.input.set(0, ["items", "length"]))
      .rejects.toThrow("current pattern's input schema");
    expect(await piece.input.get(["items"])).toEqual(["one", "two"]);
  });

  it("refuses hidden edits before invoking the producer and preserves visible edits", async () => {
    const piece = await create({
      type: "object",
      properties: { title: { type: "string" } },
    }, { title: "Topic", hidden: "retained" });
    let calls = 0;
    await expect(piece.input.edit(() => {
      calls++;
      return { value: "changed" };
    }, ["hidden"])).rejects.toThrow("current pattern's input schema");
    expect(calls).toBe(0);
    expect((await piece.input.getCell()).getRaw()).toEqual({
      title: "Topic",
      hidden: "retained",
    });
    expect(
      await piece.input.edit(
        (stored) => ({ value: `${String(stored)} edited` }),
        ["title"],
      ),
    ).toEqual({ wrote: true });
    expect(await piece.input.get(["title"])).toBe("Topic edited");
  });

  it("rechecks input visibility before producing a write after a metadata retry", async () => {
    const piece = await create({
      type: "object",
      properties: { title: { type: "string" } },
    }, { title: "Topic" });
    const input = await piece.input.getCell();
    const provider = storage.open(pieces.getSpace());
    const originalAbsences = provider.unexaminedAbsences;
    const originalPresentCount = provider.presentCount;
    const originalPendingLoadGeneration = storage.pendingLoadGeneration.bind(
      storage,
    );
    const originalLoadsSettled = storage.loadsSettled.bind(storage);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Hold the edit's first attempt in its absence-reconciliation wait on a
    // fabricated in-flight load, then have it find the document present so
    // the attempt re-runs against the metadata replaced meanwhile.
    let first = true;
    provider.unexaminedAbsences = () => [{
      space: pieces.getSpace(),
      id: "of:forced-reconciliation",
      scope: "space",
    }];
    storage.pendingLoadGeneration = () => 1;
    storage.loadsSettled = () => {
      if (!first) return Promise.resolve();
      first = false;
      entered.resolve();
      return release.promise;
    };
    let rounds = 0;
    provider.presentCount = () => (++rounds === 1 ? 1 : 0);
    let calls = 0;
    const update = piece.input.edit(() => {
      calls++;
      return { value: "Changed" };
    }, ["title"]);
    const refusal = expect(update).rejects.toThrow(
      "current pattern's input schema",
    );
    try {
      await entered.promise;
      const currentSchema = {
        type: "object",
        properties: { other: { type: "string" } },
      } as const;
      const replaced = await runtime.editWithRetry((tx) => {
        piece.getCell().withTx(tx).setMetaRaw(
          "argument",
          input.asSchema(currentSchema).getAsLink({
            base: piece.getCell(),
            includeSchema: true,
          }),
          rawMetaWriteAuthorization,
        );
      });
      expect(replaced.error).toBeUndefined();
      release.resolve();
      await refusal;
      expect(calls).toBe(1);
      expect(input.getRaw()).toEqual({ title: "Topic" });
      expect(await piece.input.get()).toEqual({});
    } finally {
      release.resolve();
      provider.unexaminedAbsences = originalAbsences;
      provider.presentCount = originalPresentCount;
      storage.pendingLoadGeneration = originalPendingLoadGeneration;
      storage.loadsSettled = originalLoadsSettled;
      await refusal;
    }
  });

  it("keeps unknown inputs opaque while preserving their reference", async () => {
    const piece = await create({
      type: "object",
      properties: { reference: { type: "unknown" } },
    }, { reference: { hidden: "data" } });
    expect(await piece.input.get(["reference"])).toEqual({});
    await expect(piece.input.get(["reference", "hidden"]))
      .rejects.toThrow("current pattern's input schema");
    await expect(piece.input.getCell(["reference", "hidden"]))
      .rejects.toThrow("current pattern's input schema");
  });

  it("preserves scope caps when selecting through a union of handles", async () => {
    const source = runtime.getCell(
      pieces.getSpace(),
      "scoped-source",
      undefined,
      undefined,
      "session",
    );
    const write = await runtime.editWithRetry((tx) => {
      source.withTx(tx).set({ kind: "number", value: 7 });
    });
    if (write.error) throw write.error;
    for (const scope of ["space", "session"] as const) {
      const piece = await create({
        type: "object",
        properties: {
          handle: {
            anyOf: [
              {
                type: "object",
                properties: {
                  kind: { const: "number" },
                  value: { type: "number" },
                },
                required: ["kind", "value"],
                asCell: [{ kind: "cell", scope }],
              },
              {
                type: "object",
                properties: {
                  kind: { const: "text" },
                  value: { type: "string" },
                },
                required: ["kind", "value"],
                asCell: [{ kind: "cell", scope }],
              },
            ],
          },
        },
      }, { handle: source });
      if (scope === "space") {
        await expect(piece.input.get(["handle", "value"])).rejects.toThrow(
          "not found",
        );
        await expect(piece.input.getCell(["handle", "value"])).rejects.toThrow(
          "not found",
        );
      } else {
        expect(await piece.input.get(["handle", "value"])).toBe(7);
        expect((await piece.input.getCell(["handle", "value"])).get()).toBe(7);
      }
    }
  });
});
