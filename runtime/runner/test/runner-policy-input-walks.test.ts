/**
 * The walks in `runner.ts` that record write-policy inputs for what a node or
 * a setup writes: the output-binding walks, which record an output schema for
 * each write-redirect link a binding holds, and the setup-projection walk,
 * which refuses a `FabricInstance` in the argument it projects.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  recordOutputSchemaPolicyInputs,
  recordRawBuiltinBindingSchemaPolicyInputs,
  schemaForRawBuiltinRootOutputBinding,
} from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test runner policy input walks");
const space = signer.did();

describe("runner-policy-input-walks", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let target: Cell<{ a: number; b: number[] }>;
  let resultCell: Cell<unknown>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    target = runtime.getCell(space, "walk-target", undefined, tx);
    target.set({ a: 1, b: [2] });
    resultCell = runtime.getCell(space, "walk-result", undefined, tx);
  });

  afterEach(async () => {
    if (tx.status().status === "ready") tx.abort();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * The `kind: "schema"` inputs `tx` holds, as document, path, schema and
   * role, with a schema a link carries as a reference recomposed.
   */
  function recordedSchemas() {
    return tx.getCfcState().writePolicyInputs.flatMap((input) =>
      input.kind === "schema"
        ? [{
          id: input.target.id,
          path: input.target.path,
          schema: resolvedSchema(input.schema),
          schemaRole: input.schemaRole,
        }]
        : []
    );
  }

  /** The same link, inside a `FabricInstance`. */
  function wrapped(link: unknown) {
    return new FabricError({
      type: "Error",
      message: "boom",
      stack: undefined,
      cause: undefined,
      extras: { inner: link as FabricValue },
    });
  }

  describe("recordOutputSchemaPolicyInputs()", () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        first: { type: "number" },
        list: { type: "array", items: { type: "integer" } },
        note: { type: "string" },
      },
    };

    it("records the result schema at each nested redirect's position, and nothing for a plain value", () => {
      const id = target.getAsNormalizedFullLink().id;
      recordOutputSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        {
          first: target.key("a").getAsWriteRedirectLink(),
          list: [target.key("b").getAsWriteRedirectLink()],
          note: "plain",
        },
        resultSchema,
      );

      // Each redirect records its own slot and the document it resolves to,
      // which here is the same slot.
      const first = { type: "number" };
      const item = { type: "integer" };
      expect(recordedSchemas()).toEqual([
        { id, path: ["a"], schema: first, schemaRole: "output" },
        { id, path: ["a"], schema: first, schemaRole: "output" },
        { id, path: ["b"], schema: item, schemaRole: "output" },
        { id, path: ["b"], schema: item, schemaRole: "output" },
      ]);
    });

    it("records nothing for a redirect at a position the result schema does not describe", () => {
      const closed: JSONSchema = {
        type: "object",
        properties: { first: { type: "number" } },
        additionalProperties: false,
      };
      recordOutputSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        { other: target.key("a").getAsWriteRedirectLink() },
        closed,
      );
      expect(recordedSchemas()).toEqual([]);

      recordOutputSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        { first: target.key("a").getAsWriteRedirectLink() },
        closed,
      );
      expect(recordedSchemas().length).toBe(2);
    });

    it("throws for a `FabricInstance` rather than missing a redirect inside it", () => {
      recordOutputSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        { first: { inner: target.key("a").getAsWriteRedirectLink() } },
        { type: "object", properties: { first: {} } },
      );
      expect(recordedSchemas().length).toBe(2);

      expect(() =>
        recordOutputSchemaPolicyInputs(
          tx,
          runtime,
          resultCell,
          { first: wrapped(target.key("a").getAsWriteRedirectLink()) },
          { type: "object", properties: { first: {} } },
        )
      ).toThrow(
        "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
          "recording output-schema policy inputs.",
      );
    });
  });

  describe("recordRawBuiltinBindingSchemaPolicyInputs()", () => {
    it("records the schema each nested redirect carries, and nothing for one that carries none", () => {
      const id = target.getAsNormalizedFullLink().id;
      const schema: JSONSchema = { type: "number" };
      recordRawBuiltinBindingSchemaPolicyInputs(tx, runtime, resultCell, [
        {
          typed: target.key("a").asSchema(schema).getAsWriteRedirectLink({
            includeSchema: true,
          }),
        },
        target.key("b").getAsWriteRedirectLink(),
      ]);

      expect(recordedSchemas()).toEqual([
        { id, path: ["a"], schema, schemaRole: "output" },
        { id, path: ["a"], schema, schemaRole: "output" },
      ]);
    });
  });

  describe("schemaForRawBuiltinRootOutputBinding()", () => {
    it("returns the schema of a binding that is itself a redirect, and `undefined` for one holding a redirect", () => {
      const schema: JSONSchema = { type: "number" };
      const link = target.key("a").asSchema(schema).getAsWriteRedirectLink({
        includeSchema: true,
      });

      expect(
        resolvedSchema(
          schemaForRawBuiltinRootOutputBinding(tx, runtime, resultCell, link),
        ),
      ).toEqual(schema);
      expect(
        schemaForRawBuiltinRootOutputBinding(tx, runtime, resultCell, {
          value: link,
        }),
      ).toBeUndefined();
    });
  });

  describe("setup projection", () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { payload: {} },
      },
      resultSchema: {},
      result: {},
      nodes: [],
    };

    it("throws for a `FabricInstance` in the argument a setup projects", () => {
      expect(() =>
        runtime.run(
          tx,
          trustExecutable(runtime, pattern),
          { payload: wrapped(target.key("a").getAsWriteRedirectLink()) },
          runtime.getCell(space, "projection-refused", undefined, tx),
        )
      ).toThrow(
        "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
          "recording setup-projection policy inputs.",
      );
    });

    it("sets up the same argument with the redirect in a plain record", () => {
      const result = runtime.run(
        tx,
        trustExecutable(runtime, pattern),
        { payload: { inner: target.key("a").getAsWriteRedirectLink() } },
        runtime.getCell(space, "projection-accepted", undefined, tx),
      );
      expect(result.getArgumentCell()?.key("payload").key("inner").get())
        .toBe(1);
    });
  });
});
