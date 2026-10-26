import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedLink } from "../src/link-types.ts";

const signer = await Identity.fromPassphrase("collect linked cell syncs");
const space = signer.did();

describe("collectLinkedCellSyncs()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager.close();
  });

  const base: NormalizedLink = {
    space,
    id: "of:collect-linked-cell-syncs" as NormalizedLink["id"],
    path: [],
  };

  /** A link to a document of the space, as a value holds one. */
  const link = {
    "/": {
      "link@1": {
        id: "of:collect-linked-cell-syncs-target",
        path: [],
        space,
      },
    },
  };

  /** A record nested `depth` records deep under `next`, holding `link` at the bottom. */
  function nested(depth: number): unknown {
    return depth === 0 ? link : { next: nested(depth - 1) };
  }

  /**
   * A schema of a record nested `depth` records deep under `next`, built
   * afresh so that it is not deep-frozen.
   */
  function nestedSchema(depth: number): JSONSchema {
    return depth === 0 ? { type: "object" } : {
      type: "object",
      properties: { next: nestedSchema(depth - 1) },
    };
  }

  /**
   * Walks `value` under `schema`, and returns how many containers were hashed
   * on the way and how many syncs the walk reached.
   */
  async function walked(
    value: unknown,
    schema: JSONSchema,
  ): Promise<{ containersHashed: number; syncs: number }> {
    const promises: Promise<unknown>[] = [];
    const before = getContainersHashedForTestingOnly();
    storageManager.accessForTestingOnly.collectLinkedCellSyncs(
      value,
      base,
      schema,
      promises,
      new Set(),
    );
    const containersHashed = getContainersHashedForTestingOnly() - before;
    await Promise.all(promises);
    return { containersHashed, syncs: promises.length };
  }

  it("reaches a link at the bottom of a nested value", async () => {
    expect((await walked(nested(6), nestedSchema(6))).syncs).toBe(1);
  });

  it("hashes a schema that is not deep-frozen once for a walk rather than once per record it descends", async () => {
    // Every walk is handed a fresh schema of one shape, so what each hashes
    // of that schema is the same, and a first walk of each depth has hashed
    // every derivation of it that the second reaches. What a deeper walk must
    // not add is a hash of the schema at each record below the first.

    await walked(nested(1), nestedSchema(6));
    await walked(nested(6), nestedSchema(6));
    const shallow = await walked(nested(1), nestedSchema(6));
    const deep = await walked(nested(6), nestedSchema(6));

    expect(deep.syncs).toBe(1);
    expect(deep.containersHashed).toBe(shallow.containersHashed);
  });
});
