import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "editWithRetry conflict aggregation test",
);
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

describe("editWithRetry conflict aggregation", () => {
  it("repairs unseen space and user instances sharing an ID after one rejected commit", async () => {
    const server = newSharedServer();
    const writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    let readerStorage: EmulatedStorageManager | undefined;
    let reader: Runtime | undefined;
    try {
      const seed = writer.edit();
      const staleA = writer.getCell(
        space,
        "aggregated-stale",
        valueSchema,
        seed,
      );
      const staleB = writer.getCell(
        space,
        "aggregated-stale",
        valueSchema,
        seed,
        "user",
      );
      const anchor = writer.getCell(space, "unrelated-anchor", undefined, seed);
      anchor.set("watched");
      staleA.set({ value: 41 });
      staleB.set({ value: 42 });
      const scopes = ["space", "user"] as const;
      const staleConflicts = scopes.map((scope) => ({
        of: staleA.getAsNormalizedFullLink().id,
        scope,
      }));
      expect((await seed.commit().settled).error).toBeUndefined();
      await writerStorage.synced();

      readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      // Keep a watched view for the ordered catch-up without covering either
      // conflicting instance.
      await readerStorage.open(space).sync(
        anchor.getAsNormalizedFullLink().id,
        { path: [], schema: false },
      );
      const rejections: unknown[] = [];
      const awaitReadiness = reader.awaitCommitRetryReadiness.bind(reader);
      reader.awaitCommitRetryReadiness = (error, teardownSignal) => {
        const conflicts = (error as {
          conflicts?: Array<{ of?: unknown; scope?: unknown }>;
        }).conflicts ?? [];
        rejections.push(
          conflicts.map(({ of, scope }) => ({ of, scope })),
        );
        return awaitReadiness(error, teardownSignal);
      };

      let runs = 0;
      let observed: unknown[] = [];
      const result = await reader.editWithRetry((tx) => {
        runs++;
        observed = scopes.map((scope) => {
          const address = toMemorySpaceAddress(
            reader!.getCell(
              space,
              "aggregated-stale",
              valueSchema,
              tx,
              scope,
            ).getAsNormalizedFullLink(),
          );
          // Record a validation read without an independent load. Writing
          // the same address leaves its absent basis for the server to judge.
          const read = tx.read(address, { trackReadWithoutLoad: true });
          expect(read.error).toBeUndefined();
          tx.write(address, { value: runs });
          return readerStorage!.open(space).replica.getDocument(
            address.id,
            scope,
          )?.value;
        });
      }, 1);

      expect(result.error).toBeUndefined();
      expect(runs).toBe(2);
      expect(observed).toEqual([{ value: 41 }, { value: 42 }]);
      expect(rejections).toEqual([staleConflicts]);
    } finally {
      await reader?.dispose();
      await writer.dispose();
      await readerStorage?.close();
      await writerStorage.close();
      await server.close();
    }
  });
});
