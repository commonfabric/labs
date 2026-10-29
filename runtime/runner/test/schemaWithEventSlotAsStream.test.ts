import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import { internCellLinkSchema } from "../src/cell.ts";
import { isCellResultForDereferencing } from "../src/query-result-proxy.ts";
import { schemaWithEventSlotAsStream } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test event slot as stream");
const space = signer.did();

describe("schemaWithEventSlotAsStream()", () => {
  // Each case builds its handler schema anew and gives it a title of its own,
  // so that no case finds a schema another case derived from already
  // interned.
  const handlerSchema = (title: string) =>
    ({
      title,
      type: "object",
      properties: {
        $event: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        $ctx: {
          type: "object",
          properties: { count: { type: "number", asCell: ["cell"] } },
        },
      },
      required: ["$event", "$ctx"],
    }) as JSONSchema;

  it("returns the schema with its `$event` slot declared a stream and no longer required", () => {
    expect(schemaWithEventSlotAsStream(handlerSchema("declared"))).toEqual({
      title: "declared",
      type: "object",
      properties: {
        $event: { asCell: ["stream"] },
        $ctx: {
          type: "object",
          properties: { count: { type: "number", asCell: ["cell"] } },
        },
      },
      required: ["$ctx"],
    });
  });

  it("returns a schema declaring no `$event` slot as it is", () => {
    const lifted = {
      type: "object",
      properties: { count: { type: "number" } },
    } as JSONSchema;
    expect(schemaWithEventSlotAsStream(lifted)).toBe(lifted);
    for (const schema of [undefined, true, false] as const) {
      expect(schemaWithEventSlotAsStream(schema)).toBe(schema);
    }
  });

  it("deep-freezes a handler schema in place, and leaves a schema declaring no `$event` slot unfrozen", () => {
    const schema = handlerSchema("frozen in place");
    schemaWithEventSlotAsStream(schema);
    expect(isDeepFrozen(schema)).toBe(true);

    const lifted = {
      title: "left unfrozen",
      type: "object",
      properties: { count: { type: "number" } },
    } as JSONSchema;
    schemaWithEventSlotAsStream(lifted);
    expect(Object.isFrozen(lifted)).toBe(false);
  });

  it("returns one deep-frozen schema for every call with one handler schema", () => {
    const schema = handlerSchema("one object");
    const first = schemaWithEventSlotAsStream(schema);
    expect(isDeepFrozen(first)).toBe(true);
    expect(schemaWithEventSlotAsStream(schema)).toBe(first);
  });

  it("returns one schema for two equal handler schemas", () => {
    expect(schemaWithEventSlotAsStream(handlerSchema("equal"))).toBe(
      schemaWithEventSlotAsStream(deepFreeze(handlerSchema("equal"))),
    );
  });

  it("hashes nothing to hand a cell the schema again", () => {
    // A node plan's inputs cell takes the schema through `asSchema()`, which
    // interns it. A schema built anew for each plan is hashed whole each time.
    const schema = handlerSchema("hashed once");
    internCellLinkSchema(schemaWithEventSlotAsStream(schema));
    const hashedBefore = getContainersHashedForTestingOnly();
    for (let plan = 0; plan < 10; plan++) {
      internCellLinkSchema(schemaWithEventSlotAsStream(schema));
    }
    expect(getContainersHashedForTestingOnly()).toBe(hashedBefore);
  });

  it("returns a schema of its own for a handler schema that differs", () => {
    const first = schemaWithEventSlotAsStream(handlerSchema("differs, one"));
    const second = schemaWithEventSlotAsStream(handlerSchema("differs, two"));
    expect(second).not.toBe(first);
    expect(first).toMatchObject({ title: "differs, one" });
    expect(second).toMatchObject({ title: "differs, two" });
  });

  describe("given a handler schema read out of a cell", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
    });

    afterEach(async () => {
      await tx.commit().settled;
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("returns the deep-frozen declared schema, leaving the cell's value as it was", () => {
      // Freezing a value read out of a cell in place would write through to
      // what the cell holds.
      const cell = runtime.getCell(space, "handler schema", undefined, tx);
      cell.set(handlerSchema("read out of a cell"));
      const read = cell.getAsQueryResult() as JSONSchema;
      expect(isCellResultForDereferencing(read)).toBe(true);

      const declared = schemaWithEventSlotAsStream(read);
      expect(declared).toEqual({
        title: "read out of a cell",
        type: "object",
        properties: {
          $event: { asCell: ["stream"] },
          $ctx: {
            type: "object",
            properties: { count: { type: "number", asCell: ["cell"] } },
          },
        },
        required: ["$ctx"],
      });
      expect(isDeepFrozen(declared)).toBe(true);
      expect(schemaWithEventSlotAsStream(read)).toBe(declared);
      expect(Object.isFrozen(read)).toBe(false);
      expect(cell.get()).toEqual(handlerSchema("read out of a cell"));
    });
  });
});
