import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { CellScope, EntityDocument } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";

type TestProvider = {
  get(uri: string): EntityDocument | undefined;
  send(
    batch: {
      uri: string;
      value: EntityDocument | undefined;
    }[],
  ): Promise<
    {
      ok?: Record<PropertyKey, never>;
      error?: { name?: string; message?: string };
    }
  >;
  sync(uri: string, selector?: unknown, scope?: CellScope): Promise<unknown>;
};

const signer = await Identity.fromPassphrase("memory-v2-emulation");
const space = signer.did();

describe("Memory v2 emulation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let cell: Cell<{ hello: string }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    cell = runtime.getCell(space, "memory-v2-emulation-cell", undefined, tx);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await storageManager.close();
    await clock.settle();
  });

  it("persists and reloads documents through the runtime cutover seam", async () => {
    cell.set({ hello: "world" });

    await tx.commit().settled;
    await runtime.idle();

    const provider = storageManager.open(space) as unknown as TestProvider;
    await provider.sync(cell.getAsNormalizedFullLink().id);
    await storageManager.synced();

    const persisted = provider.get(cell.getAsNormalizedFullLink().id);

    expect(persisted?.value).toEqual({ hello: "world" });
  });

  it("preserves raw provider documents, including non-value metadata", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const uri = `of:memory-v2-labels-${Date.now()}` as const;

    const result = await provider.send([{
      uri,
      value: {
        value: { hello: "labels" },
        labels: { confidentiality: ["confidential"] },
      },
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      value: { hello: "labels" },
      labels: { confidentiality: ["confidential"] },
    });
  });

  it("passes declared cell scope to provider syncs", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const originalSync = provider.sync.bind(provider);
    const syncs: Array<{ uri: string; scope?: CellScope }> = [];
    provider.sync = async (uri, selector, scope) => {
      syncs.push({ uri, scope });
      return await originalSync(uri, selector, scope);
    };

    const scopedCell = runtime.getCellFromLink({
      space,
      id: "of:memory-v2-scoped-sync",
      path: [],
      scope: "user",
    });

    await storageManager.syncCell(scopedCell);

    expect(syncs).toEqual([{
      uri: "of:memory-v2-scoped-sync",
      scope: "user",
    }]);
  });

  it("preserves root objects whose data is exactly a value key on provider sends", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const uri = `of:memory-v2-value-only-${Date.now()}` as const;

    const result = await provider.send([{
      uri,
      value: {
        value: {
          value: "hello",
        },
      },
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      value: {
        value: "hello",
      },
    });
  });

  it("preserves root objects whose data includes a value key plus siblings", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const uri = `of:memory-v2-value-siblings-${Date.now()}` as const;

    const result = await provider.send([{
      uri,
      value: {
        value: {
          value: "hello",
          other: "data",
        },
      },
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      value: {
        value: "hello",
        other: "data",
      },
    });
  });

  it("stores source-only provider sends as source-only documents", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const uri = `of:memory-v2-source-only-${Date.now()}` as const;

    const result = await provider.send([{
      uri,
      value: {
        source: { "/": "process:1" },
      },
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      source: { "/": "process:1" },
    });
  });

  it("deletes provider documents only when the batch value is undefined", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const uri = `of:memory-v2-delete-${Date.now()}` as const;

    const seed = await provider.send([{
      uri,
      value: {
        value: { hello: "world" },
      },
    }]);
    expect(seed).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      value: { hello: "world" },
    });

    const result = await provider.send([{
      uri,
      value: undefined,
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toBeUndefined();
  });
});
