import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import {
  loadProfileOwnerDocuments,
  profileOwnerAt,
} from "../src/profile-owner.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("profile-owner");
const space = signer.did();

describe("profile-owner", () => {
  let server: ReturnType<typeof newSharedServer>;
  const opened: { runtime: Runtime; storage: EmulatedStorageManager }[] = [];

  /** A runtime over its own session of the shared server. */
  const session = (): Runtime => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    opened.push({ runtime, storage });
    return runtime;
  };

  beforeEach(() => {
    server = newSharedServer();
  });

  afterEach(async () => {
    for (const { runtime, storage } of opened.splice(0)) {
      await runtime.dispose();
      await storage.close();
    }
    await server.close();
  });

  /** Stores each of `values` in the document its key names, through `runtime`. */
  const store = async (
    runtime: Runtime,
    values: (cell: (cause: string) => Cell<unknown>) => Record<
      string,
      unknown
    >,
  ): Promise<void> => {
    const tx = runtime.edit();
    const cell = (cause: string) =>
      runtime.getCell<unknown>(space, cause, undefined, tx);
    for (const [cause, value] of Object.entries(values(cell))) {
      cell(cause).setRaw(value as never);
    }
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.storageManager.synced();
  };

  describe("loadProfileOwnerDocuments()", () => {
    it("loads each document the profile's name resolves through", async () => {
      await store(session(), (cell) => ({
        profile: { name: cell("first hop").getAsLink() },
        "first hop": cell("second hop").getAsLink(),
        "second hop": "Sam",
      }));
      const reader = session();
      const second = reader.getCell<unknown>(space, "second hop");
      expect(second.getRaw()).toBeUndefined();

      await loadProfileOwnerDocuments(
        reader,
        reader.getCell<unknown>(space, "profile"),
      );

      expect(second.getRaw()).toBe("Sam");
    });

    it("loads nothing past a profile whose links run in a cycle", async () => {
      await store(session(), (cell) => ({
        "cycle a": cell("cycle b").getAsLink(),
        "cycle b": cell("cycle a").getAsLink(),
      }));
      const reader = session();
      const profile = reader.getCell<unknown>(space, "cycle a");

      await loadProfileOwnerDocuments(reader, profile);

      const tx = reader.edit();
      try {
        expect(profileOwnerAt(reader, tx, profile)).toBeUndefined();
      } finally {
        tx.abort();
      }
    });
  });
});
