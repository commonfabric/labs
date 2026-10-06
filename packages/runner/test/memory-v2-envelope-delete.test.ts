import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { getDirectTransactionNativeCommit } from "../src/storage/transaction-inspection.ts";

// A memory v2 entity document is an envelope: the transaction's root value
// lives under its `value` key. Emptying that envelope and storing an empty
// envelope are the same end state, so a write that removes the last field
// has to reach storage as a document delete rather than as a stored empty
// object -- otherwise a deleted document would come back as a present,
// empty one.

const signer = await Identity.fromPassphrase("memory v2 envelope delete");
const space = signer.did();

describe("memory v2 envelope deletion", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("commits an explicit root delete as a document delete", async () => {
    const address = {
      space,
      scope: "space" as const,
      id: "of:envelope-delete" as const,
      path: [] as string[],
    };

    const seed = runtime.edit();
    seed.writeValueOrThrow(address, { name: "ToDelete", active: true });
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    tx.writeValueOrThrow(address, undefined, { delete: true });

    const commit = getDirectTransactionNativeCommit(tx, space);
    expect(commit?.operations.length).toBe(1);
    expect(commit?.operations[0].op).toBe("delete");
    expect(commit?.operations[0].id).toBe(address.id);

    expect((await tx.commit().settled).error).toBeUndefined();

    const after = runtime.edit();
    expect(after.read(address).ok?.value).toBeUndefined();
    after.abort();
  });

  it("keeps the document when the root is written as undefined", async () => {
    const address = {
      space,
      scope: "space" as const,
      id: "of:envelope-set-undefined" as const,
      path: [] as string[],
    };

    const seed = runtime.edit();
    seed.writeValueOrThrow(address, { name: "ToClear", active: true });
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    // A plain write of `undefined` stores `undefined` under the envelope's
    // `value` key. The key stays present, so the document stays present.
    tx.writeValueOrThrow(address, undefined);

    const commit = getDirectTransactionNativeCommit(tx, space);
    expect(commit?.operations.length).toBe(1);
    expect(commit?.operations[0].op).not.toBe("delete");

    expect((await tx.commit().settled).error).toBeUndefined();

    const replica = storageManager.open(space).replica;
    const document = replica.getDocument(address.id, address.scope);
    expect(document).toBeDefined();
    expect(Object.hasOwn(document!, "value")).toBe(true);
    expect(document!.value).toBeUndefined();
  });
});
