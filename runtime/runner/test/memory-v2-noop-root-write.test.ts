import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";

Deno.test("memory v2 treats an identical root write as a no-op", async () => {
  const signer = await Identity.fromPassphrase("memory-v2-noop-root-write");
  const storage = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    storageManager: storage,
    apiUrl: new URL(import.meta.url),
  });
  const space = signer.did();
  const address = {
    id: "bench:no-op-root-write" as const,
    type: "application/json" as const,
    scope: "space" as const,
    path: [],
  };

  const tx1 = runtime.edit();
  tx1.writeValueOrThrow({ ...address, space }, { foo: "bar" });
  assert((await tx1.commit().settled).ok);

  const provider = storage.open(space);
  const initialState = provider.replica.get(address) as
    | { since?: number }
    | undefined;
  assert((initialState?.since ?? 0) > 0);

  const notifications: string[] = [];
  storage.subscribe({
    next(notification) {
      notifications.push(notification.type);
      return undefined;
    },
  });

  const tx2 = runtime.edit();
  tx2.writeValueOrThrow({ ...address, space }, { foo: "bar" });
  assertEquals(Array.from(tx2.getWriteDetails?.(space) ?? []), []);
  assertEquals(txToReactivityLog(tx2).writes, []);
  assert((await tx2.commit().settled).ok);

  const finalState = provider.replica.get(address) as
    | { since?: number }
    | undefined;
  assertEquals(finalState?.since, initialState?.since);
  assertEquals(notifications, []);

  await runtime.dispose();
  await storage.close();
});

Deno.test("memory v2 no-op commits do not reopen storage for an empty native commit", async () => {
  const signer = await Identity.fromPassphrase("memory-v2-noop-commit-open");
  const storage = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    storageManager: storage,
    apiUrl: new URL(import.meta.url),
  });
  const space = signer.did();
  const address = {
    id: "bench:no-op-commit-open" as const,
    type: "application/json" as const,
    scope: "space" as const,
    path: [],
  };

  const seed = runtime.edit();
  seed.writeValueOrThrow({ ...address, space }, { foo: "bar" });
  assert((await seed.commit().settled).ok);

  const tx = runtime.edit();
  tx.writeValueOrThrow({ ...address, space }, { foo: "bar" });
  assertEquals(Array.from(tx.getWriteDetails?.(space) ?? []), []);

  const originalOpen = storage.open.bind(storage);
  let openCalls = 0;
  storage.open = ((requestedSpace) => {
    openCalls += 1;
    return originalOpen(requestedSpace);
  }) as typeof storage.open;

  try {
    assert((await tx.commit().settled).ok);
    assertEquals(openCalls, 0);
  } finally {
    storage.open = originalOpen;
    await runtime.dispose();
    await storage.close();
  }
});

Deno.test("memory v2 no-op commits skip stale-read validation when there are no effective operations", async () => {
  const signer = await Identity.fromPassphrase("memory-v2-noop-stale-read");
  const storage = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    storageManager: storage,
    apiUrl: new URL(import.meta.url),
  });
  const space = signer.did();
  const address = {
    id: "bench:no-op-stale-read" as const,
    type: "application/json" as const,
    scope: "space" as const,
    path: [] as string[],
  };

  try {
    const seed = runtime.edit();
    seed.writeValueOrThrow({ ...address, space }, { foo: "bar" });
    assert((await seed.commit().settled).ok);

    const staleNoop = runtime.edit();
    assertEquals(
      staleNoop.readValueOrThrow({ ...address, space, path: [] }),
      { foo: "bar" },
    );
    staleNoop.writeValueOrThrow({ ...address, space }, { foo: "bar" });
    assertEquals(Array.from(staleNoop.getWriteDetails?.(space) ?? []), []);

    const concurrent = runtime.edit();
    concurrent.writeValueOrThrow({ ...address, space }, { foo: "baz" });
    assert((await concurrent.commit().settled).ok);

    assert((await staleNoop.commit().settled).ok);
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});

Deno.test("memory v2 treats an identical nested write as a no-op", async () => {
  const signer = await Identity.fromPassphrase("memory-v2-noop-nested-write");
  const storage = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    storageManager: storage,
    apiUrl: new URL(import.meta.url),
  });
  const space = signer.did();
  const address = {
    id: "bench:no-op-nested-write" as const,
    type: "application/json" as const,
    scope: "space" as const,
    path: [] as string[],
  };

  try {
    const seed = runtime.edit();
    seed.writeValueOrThrow({ ...address, space }, {
      profile: { name: "Ada" },
      stats: { visits: 1 },
    });
    assert((await seed.commit().settled).ok);

    const provider = storage.open(space);
    const initialState = provider.replica.get(address) as
      | { since?: number }
      | undefined;
    assert((initialState?.since ?? 0) > 0);

    const notifications: string[] = [];
    storage.subscribe({
      next(notification) {
        notifications.push(notification.type);
        return undefined;
      },
    });

    const tx = runtime.edit();
    tx.writeValueOrThrow({
      ...address,
      space,
      path: ["stats", "visits"],
    }, 1);
    assertEquals(Array.from(tx.getWriteDetails?.(space) ?? []), []);
    assert((await tx.commit().settled).ok);

    const finalState = provider.replica.get(address) as
      | { since?: number }
      | undefined;
    assertEquals(finalState?.since, initialState?.since);
    assertEquals(notifications, []);
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});
