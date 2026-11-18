import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { schemaForSpaceCrossing } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("link-utils space crossing cov");
const space = signer.did();

const recompositionWarnings = (): number => {
  const counts = getLoggerCountsBreakdown()["schema-closure"] as
    | Record<string, { warn?: number }>
    | undefined;
  return counts?.["schema-closure"]?.warn ?? 0;
};

describe("link-utils", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  describe("schemaForSpaceCrossing()", () => {
    // The referenced document is registered, so the closure check passes and
    // only recomposition can refuse the reference.

    const group = {
      $defs: {
        Name: { type: "string", title: "space crossing member" },
        Count: { type: "number" },
      },
    } as const;
    const groupHash = internSchemaAsTaggedHashString(group);

    it("returns the member a fragment reference names in a registered document", () => {
      registerSchemaDocument(groupHash, group);
      const before = recompositionWarnings();

      expect(
        schemaForSpaceCrossing(tx, space, {
          $ref: `cid:${groupHash}#/$defs/Name`,
        }),
      ).toEqual({ $ref: "#/$defs/Name", ...group });
      expect(recompositionWarnings()).toBe(before);
    });

    it("returns `false` and warns for a reference to a member its document lacks", () => {
      registerSchemaDocument(groupHash, group);
      const before = recompositionWarnings();

      expect(
        schemaForSpaceCrossing(tx, space, {
          $ref: `cid:${groupHash}#/$defs/Absent`,
        }),
      ).toBe(false);
      expect(recompositionWarnings()).toBe(before + 1);
    });

    it("returns `false` for a bare reference to a document of named members", () => {
      registerSchemaDocument(groupHash, group);

      expect(schemaForSpaceCrossing(tx, space, { $ref: `cid:${groupHash}` }))
        .toBe(false);
    });

    it("returns `false` for a reference to a document with a dangling local ref", () => {
      const dangling = {
        type: "object",
        properties: { broken: { $ref: "#/$defs/Missing" } },
      } as const;
      const danglingHash = internSchemaAsTaggedHashString(dangling);
      registerSchemaDocument(danglingHash, dangling);

      expect(
        schemaForSpaceCrossing(tx, space, { $ref: `cid:${danglingHash}` }),
      ).toBe(false);
    });

    it("throws an error that is not a recomposition refusal", () => {
      // The member's `title` reads normally while the document registers,
      // then throws when recomposition reads it again.
      let armed = false;
      const member = Object.defineProperty(
        { type: "string" } as const,
        "title",
        {
          enumerable: true,
          get() {
            if (armed) throw new TypeError("title read failed");
            return "space crossing throwing member";
          },
        },
      );
      const throwing = { $defs: { Name: member } };
      const throwingHash = internSchemaAsTaggedHashString(throwing);
      registerSchemaDocument(throwingHash, throwing);
      armed = true;
      const before = recompositionWarnings();

      expect(() =>
        schemaForSpaceCrossing(tx, space, {
          $ref: `cid:${throwingHash}#/$defs/Name`,
        })
      ).toThrow(TypeError);
      expect(recompositionWarnings()).toBe(before);
    });
  });
});
