import type { JSONSchema } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { registerSchemaDocument } from "../src/schema-registry.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

describe("CFC schema dependency sync", () => {
  let env: SchedulerTestRuntime;
  let carrierId: string;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
    carrierId = env.runtime.getCell(space, "cfc-carrier")
      .getAsNormalizedFullLink().id;
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  for (const available of [true, false]) {
    it(
      available
        ? "skips the schema load when its verified content is registered locally"
        : "loads a schema absent from the local registry",
      async () => {
        const schema = { type: "string", title: "local CFC schema" } as const;
        const hash = internSchemaAsTaggedHashString(schema);
        if (available) registerSchemaDocument(hash, schema);
        const synced = await syncWithSchema(hash);
        expect(synced).toEqual(
          available ? [carrierId] : [carrierId, `cid:${hash}`],
        );
      },
    );
  }

  for (const complete of [true, false]) {
    it(
      complete
        ? "skips the schema load when its transitive dependencies are registered"
        : "loads a registered schema whose transitive dependency is missing",
      async () => {
        const leaf = { type: "string", title: "CFC dependency" } as const;
        const leafHash = internSchemaAsTaggedHashString(leaf);
        const schema: JSONSchema = {
          type: "object",
          properties: { name: { $ref: `cid:${leafHash}` } },
        };
        const hash = internSchemaAsTaggedHashString(schema);
        registerSchemaDocument(hash, schema);
        if (complete) registerSchemaDocument(leafHash, leaf);
        const synced = await syncWithSchema(hash);
        expect(synced).toEqual(
          complete ? [carrierId] : [carrierId, `cid:${hash}`],
        );
      },
    );
  }

  it("keeps the cell pending until a missing schema load settles", async () => {
    const hash = internSchemaAsTaggedHashString({
      type: "string",
      title: "pending CFC dependency",
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sync = syncWithSchema(hash, async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const key = `${space}/space/${carrierId}`;
    expect(env.storageManager.pendingLoadGeneration(key)).toBeDefined();
    release.resolve();
    await sync;
    expect(env.storageManager.pendingLoadGeneration(key)).toBeUndefined();
  });

  /**
   * Supplies a carrier's metadata at the provider boundary and records loads.
   * The schema registry is real; no schema document is persisted on the server.
   */
  async function syncWithSchema(
    hash: string,
    loadSchema: () => Promise<void> = () => Promise.resolve(),
  ): Promise<string[]> {
    const storage = env.storageManager;
    const originalOpen = storage.open.bind(storage);
    const synced: string[] = [];
    storage.open = (openSpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "get") {
            return () => ({ value: {}, cfc: { schemaHash: hash } });
          }
          if (property === "sync") {
            return async (id: string) => {
              synced.push(id);
              if (id.startsWith("cid:")) await loadSchema();
              return { ok: {} };
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    try {
      await storage.syncCell(env.runtime.getCell(space, "cfc-carrier"));
      return synced;
    } finally {
      storage.open = originalOpen;
    }
  }
});
