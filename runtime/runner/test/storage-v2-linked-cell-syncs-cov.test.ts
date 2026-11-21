import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { NormalizedLink } from "../src/link-types.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import type { StorageManager } from "../src/storage/v2.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

describe("StorageManager", () => {
  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  /**
   * The documents a walk of a relative link from `base` syncs, recorded
   * rather than loaded.
   */
  const syncedFrom = async (base: NormalizedLink): Promise<string[]> => {
    const storage = env.runtime.storageManager as StorageManager;
    const originalOpen = storage.open.bind(storage);
    const synced: string[] = [];
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return (id: string) => {
              synced.push(id);
              return Promise.resolve({ ok: {} });
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    try {
      const promises: Promise<unknown>[] = [];
      storage.accessForTestingOnly.collectLinkedCellSyncs(
        linkRefFrom({ path: ["sibling"] }),
        base,
        undefined,
        promises,
        new Set(),
      );
      await Promise.all(promises);
      return synced;
    } finally {
      storage.open = originalOpen;
    }
  };

  describe("accessForTestingOnly", () => {
    describe("collectLinkedCellSyncs()", () => {
      it("syncs the document a relative link resolves against", async () => {
        expect(await syncedFrom({ id: "of:origin", space, path: [] }))
          .toEqual(["of:origin"]);
      });

      it("syncs nothing for a relative link with no document to resolve against", async () => {
        expect(await syncedFrom({ space, path: [] })).toEqual([]);
      });
    });
  });
});
