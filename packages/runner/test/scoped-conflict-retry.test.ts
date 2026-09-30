/**
 * Conflict recovery loads the scoped output that failed validation even when
 * the space instance's current link does not reach that output.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { ignoreReadForScheduling } from "../src/storage/reactivity-log.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  seedStoredReferenceEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

describe("scoped-conflict-retry", () => {
  it("restores an unwatched user output after one conflict and a scoped recovery pull", async () => {
    const signer = await Identity.fromPassphrase("scoped conflict retry");
    const space = signer.did();
    const server = newSharedServer();
    const writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    const reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const seed = writer.edit();
      writeSeedEnvelopeDoc(seed, space);
      const previous = writer.getCell<string>(
        space,
        "output",
        undefined,
        seed,
        "user",
      );
      previous.set("previous user value");
      const alternate = writer.getCell<string>(
        space,
        "alternate",
        undefined,
        seed,
      );
      alternate.set("alternate value");
      writer.getCell(space, "output", undefined, seed).set(alternate);
      expect((await seed.commit()).error).toBeUndefined();
      await writerStorage.synced();

      const output = reader.getCell(space, "output");
      await readerStorage.open(space).sync(
        output.getAsNormalizedFullLink().id,
        {
          path: [],
          schema: false,
        },
      );
      const attempt = () => {
        const tx = reader.edit();
        const scoped = reader.getCell<string>(
          space,
          "output",
          undefined,
          tx,
          "user",
        );
        const scopedAddress = toMemorySpaceAddress(
          scoped.getAsNormalizedFullLink(),
        );
        // Keep the output's validation dependency without starting a load
        // that could repair it independently of the retry helper.
        tx.read(scopedAddress, {
          meta: ignoreReadForScheduling,
          trackReadWithoutLoad: true,
        });
        tx.write(scopedAddress, "updated user value");
        seedStoredReferenceEnvelope(
          tx,
          {
            ...toMemorySpaceAddress(output.getAsNormalizedFullLink()),
            path: [],
          },
          { value: scoped.getAsLink() },
        );
        return tx.commit();
      };
      const rejected = await attempt();
      expect(rejected.error?.name).toBe("ConflictError");
      if (rejected.error?.name !== "ConflictError") {
        throw new Error("Expected the unseen user output to conflict");
      }
      expect(rejected.error.conflict.of).toBe(
        output.getAsNormalizedFullLink().id,
      );
      expect(rejected.error.conflict.scope).toBe("user");
      // Recovery must work from a cold replica independently of any rows
      // preparation or conflict reconciliation loaded in the failed reader.
      const recoveryStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const recovery = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: recoveryStorage,
      });
      try {
        expect(
          recoveryStorage.open(space).replica.getDocument(
            output.getAsNormalizedFullLink().id,
            "user",
          ),
        ).toBeUndefined();
        await recovery.awaitCommitRetryReadiness(rejected.error);
        expect(
          recoveryStorage.open(space).replica.getDocument(
            output.getAsNormalizedFullLink().id,
            "user",
          ),
        ).toEqual({ value: "previous user value" });
      } finally {
        await recovery.dispose();
        await recoveryStorage.close();
      }
      await reader.awaitCommitRetryReadiness(rejected.error);
      expect(
        readerStorage.open(space).replica.getDocument(
          output.getAsNormalizedFullLink().id,
          "user",
        ),
      )
        .toEqual({ value: "previous user value" });
      const retried = await attempt();
      expect(retried.error).toBeUndefined();
      await readerStorage.synced();
      expect(
        reader.getCell<string>(space, "output", undefined, undefined, "user")
          .get(),
      )
        .toBe("updated user value");
      expect(output.get()).toBe("updated user value");
    } finally {
      await reader.dispose();
      await writer.dispose();
      await readerStorage.close();
      await writerStorage.close();
      await server.close();
    }
  });
});
