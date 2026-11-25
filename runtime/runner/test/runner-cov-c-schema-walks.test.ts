/**
 * What the runner's argument walk and the link resolution beneath its
 * scheduler reads make of schemas whose references resolve to booleans or
 * carry no schema of their own.
 */

import { expect } from "@std/expect";
import { internSchema } from "@commonfabric/data-model-schema";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cov-c schema walks");
const space = signer.did();

describe("runner schema walks", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let resultCell: Cell<unknown>;
  let target: Cell<{ value: number }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    target = runtime.getCell<{ value: number }>(
      space,
      "walk-target",
      undefined,
      tx,
    );
    target.set({ value: 1 });
    resultCell = runtime.getCell<unknown>(space, "walk-result", undefined, tx);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("collectArgumentSchedulerReadLinks", () => {
    it("reads a link whose schema is an external reference to a boolean document", () => {
      const walks = runtime.runner.accessForTestingOnly;
      const redirect = target.key("value").getAsWriteRedirectLink();
      const anything = internSchema(true, true).taggedHashString;
      registerSchemaDocument(anything, true);
      const opaque = internSchema(
        { type: "number", asCell: ["opaque"] } as JSONSchema,
        true,
      );
      registerSchemaDocument(opaque.taggedHashString, opaque.schema!);

      expect(
        walks.collectArgumentSchedulerReadLinks(
          {
            type: "object",
            properties: { field: { $ref: `cid:${anything}` } },
          },
          { field: redirect },
          resultCell,
        ).length,
      ).toBe(1);
      expect(
        walks.collectArgumentSchedulerReadLinks(
          {
            type: "object",
            properties: { field: { $ref: `cid:${opaque.taggedHashString}` } },
          },
          { field: redirect },
          resultCell,
        ),
      ).toEqual([]);
    });
  });

  describe("resolveLink() over a scheduler read's redirect", () => {
    // The runner's declared scheduler reads resolve a write redirect and read
    // its target under the schema the resolved link carries. A redirect read
    // with a schema keeps one through every hop: the read's own where the
    // stored link declares no shape, the stored link's where it does.

    it("keeps the read's schema across a stored redirect that carries none", () => {
      const hop = runtime.getCell<unknown>(
        space,
        "redirect hop",
        undefined,
        tx,
      );
      hop.setRaw(target.key("value").getAsWriteRedirectLink());
      const read = {
        ...hop.getAsNormalizedFullLink(),
        overwrite: "redirect" as const,
        schema: { type: "number" } as JSONSchema,
      };

      const resolved = resolveLink(runtime, tx, read, "writeRedirect");

      expect(resolved.id).toBe(target.getAsNormalizedFullLink().id);
      expect(resolved.path).toEqual(["value"]);
      expect(resolved.schema).toEqual({ type: "number" });
    });

    it("takes the stored redirect's schema where it declares a shape", () => {
      const declared = { type: "number", minimum: 0 } as JSONSchema;
      const hop = runtime.getCell<unknown>(space, "typed hop", undefined, tx);
      hop.setRaw(
        target.key("value").asSchema(declared).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );
      const read = {
        ...hop.getAsNormalizedFullLink(),
        overwrite: "redirect" as const,
        schema: { type: "number" } as JSONSchema,
      };

      const resolved = resolveLink(runtime, tx, read, "writeRedirect");

      // The stored link holds its schema in reference form.
      expect(resolved.id).toBe(target.getAsNormalizedFullLink().id);
      expect(resolved.schema).toEqual({
        $ref: `cid:${internSchema(declared, true).taggedHashString}`,
      });
    });
  });
});
