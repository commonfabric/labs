import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "@/mod.ts";

const ref: CellRef = {
  id: "of:cache-version" as CellRef["id"],
  space: "did:key:test",
  scope: "space",
  path: [],
  schema: { type: "string" },
};

describe("CellHandle.getCacheVersion()", () => {
  it("tracks equal worker confirmations without requiring a changed-value callback", () => {
    const runtime = {
      [$conn]: () => ({ subscribe() {}, unsubscribe() {} }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const seen: unknown[] = [];
    const cancel = cell.subscribe((value) => {
      seen.push(value);
    });
    try {
      const before = cell.getCacheVersion();
      cell[$onCellUpdate]("initial");
      expect(cell.getCacheVersion()).toBeGreaterThan(before);
      expect(seen).toEqual(["initial"]);
      expect(cell.get()).toBe("initial");
    } finally {
      cancel();
    }
  });

  it("tracks successful sync and pull reads even when their values are unchanged", async () => {
    const runtime = {
      [$conn]: () => ({ request: () => Promise.resolve({ value: "initial" }) }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    for (const read of [() => cell.sync(), () => cell.pull()]) {
      const before = cell.getCacheVersion();
      await read();
      expect(cell.getCacheVersion()).toBeGreaterThan(before);
      expect(cell.get()).toBe("initial");
    }
  });

  it("keeps the cache revision when a read is refused", async () => {
    const runtime = {
      [$conn]: () => ({ request: () => Promise.reject(new Error("refused")) }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const before = cell.getCacheVersion();
    await expect(cell.sync()).rejects.toThrow("refused");
    expect(cell.getCacheVersion()).toBe(before);
    expect(cell.get()).toBe("initial");
  });

  it("keeps the cache revision when another handle invalidates an in-flight read", async () => {
    const response = Promise.withResolvers<{ value: string }>();
    const runtime = {
      [$conn]: () => ({ request: () => response.promise }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const sibling = new CellHandle(runtime, ref, "initial");
    const before = cell.getCacheVersion();
    const reading = cell.sync();
    sibling[$onCellUpdate]("newer");
    response.resolve({ value: "snapshot" });
    expect(await reading).toBe("snapshot");
    expect(cell.getCacheVersion()).toBe(before);
    expect(cell.get()).toBe("initial");
    expect(sibling.getCacheVersion()).toBeGreaterThan(before);
  });

  it("tracks local publications while a UI write's receipt alone leaves the cache unchanged", async () => {
    const committed = Promise.withResolvers<void>();
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType; awaitCommit?: boolean }) =>
          request.awaitCommit ? committed.promise : Promise.resolve(),
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const before = cell.getCacheVersion();
    await cell.set("published");
    const published = cell.getCacheVersion();
    expect(published).toBeGreaterThan(before);
    const writing = cell.setForUI("ui edit");
    expect(cell.getCacheVersion()).toBe(published);
    committed.resolve();
    await writing;
    expect(cell.getCacheVersion()).toBe(published);
    expect(cell.get()).toBe("published");
  });
});
