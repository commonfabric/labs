import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("storage-v2 covered pull cov");
const space = signer.did();

const counterSchema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const;

describe("storage/v2", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
  });

  afterEach(async () => {
    await writer.dispose();
    await writerStorage.close();
    await readerStorage.close();
    await server.close();
  });

  it("resolves a pull every entry of which a pull in flight covers once that pull's document is here", async () => {
    const tx = writer.edit();
    const counter = writer.getCell(space, "covered pull", counterSchema, tx);
    counter.set({ n: 1 });
    expect((await tx.commit().settled).error).toBeUndefined();
    await writerStorage.synced();
    const { id } = counter.getAsNormalizedFullLink();

    const provider = readerStorage.open(space);
    const whole = provider.sync(id, { path: [], schema: counterSchema });
    const part = provider.sync(id, {
      path: ["n"],
      schema: { type: "number" },
    });
    expect(await part).toEqual({ ok: {} });
    expect(provider.replica.getDocument?.(id)?.value).toEqual({ n: 1 });
    expect(await whole).toEqual({ ok: {} });
  });
});
