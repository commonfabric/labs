import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { dataUriFromValueWithResolvedLinks } from "../src/data-uri.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { dataURISyncKey } from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();
const foreign = (await Identity.fromPassphrase("foreign opaque target")).did();

describe("data URI sync", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("sync on a data: URI cell with no links resolves without error", async () => {
    const dataURI = dataUriFromValueWithResolvedLinks({ simple: "value" });
    const cell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );
    const result = await cell.sync();
    expect(result).toBeDefined();
  });

  for (const type of ["unknown", ["unknown"]] as const) {
    it(`retains foreign handles with ${JSON.stringify(type)} schemas without syncing targets`, async () => {
      const target = runtime.getCell(
        foreign,
        "opaque-target",
        undefined,
        undefined,
        "user",
      ).key("nested");
      const schema = {
        type: "object",
        properties: {
          ref: { type, asCell: ["cell"] },
          refs: {
            type: "array",
            items: { type, asCell: ["readonly"] },
          },
        },
        required: ["ref", "refs"],
      } as const;
      const dataCell = runtime.getImmutableCell<{
        ref: Cell<unknown>;
        refs: Cell<unknown>[];
      }>(space, { ref: target, refs: [target] }, schema);
      const provider = storageManager.open(foreign);
      const originalSync = provider.sync.bind(provider);
      const synced: Array<
        { id: string; scope?: string; path: readonly string[] | undefined }
      > = [];
      provider.sync = (...args) => {
        synced.push({ id: args[0], path: args[1]?.path, scope: args[2] });
        return originalSync(...args);
      };

      await dataCell.sync();
      const value = dataCell.get({ traverseCells: true });
      const direct = dataCell.key("ref").get();
      const { space: targetSpace, scope, id, path } = target
        .getAsNormalizedFullLink();
      for (const cell of [value.ref, value.refs[0], direct]) {
        expect(cell.getAsNormalizedFullLink()).toMatchObject({
          space: targetSpace,
          scope,
          id,
          path,
        });
      }
      await storageManager.synced();
      expect(synced).toEqual([]);

      for (const valueType of ["number", ["number", "unknown"]] as const) {
        synced.length = 0;
        await dataCell.asSchema({
          type: "object",
          properties: { ref: { type: valueType, asCell: ["cell"] } },
        }).sync();
        expect(synced).toContainEqual({ id, scope: "user", path: ["nested"] });
      }
    });
  }

  it("sync on a data: URI cell containing a sigil link calls sync on the linked cell", async () => {
    // Create a real cell that we expect to be synced
    const linkedCell = runtime.getCell(space, "linked-target", undefined, tx);
    linkedCell.set({ value: "target data" });
    const linkedId = linkedCell.getAsNormalizedFullLink().id;

    // Build a sigil link pointing at the real cell
    const sigilLink = {
      "/": {
        [LINK_V1_TAG]: {
          id: linkedId,
          path: [],
        },
      },
    };

    // Create a data: URI whose value contains that link
    const dataURI = dataUriFromValueWithResolvedLinks({ ref: sigilLink });
    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    // Spy on the storage provider's sync method
    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    // The linked cell's id should have been synced
    expect(syncedIds).toContain(linkedId);
  });

  it("walks foreign inline handles locally to sync their linked inputs", async () => {
    const target = runtime.getCell(space, "inline-input", undefined, tx).key(
      "nested",
    );
    target.set(42);
    const inline = runtime.getImmutableCell(foreign, { input: target });
    const outer = runtime.getImmutableCell(space, { ref: inline }, {
      type: "object",
      properties: { ref: { type: "unknown", asCell: ["cell"] } },
    });
    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const synced: Array<
      { id: string; scope?: string; path: readonly string[] | undefined }
    > = [];
    provider.sync = (...args) => {
      synced.push({ id: args[0], path: args[1]?.path, scope: args[2] });
      return originalSync(...args);
    };
    await outer.sync();
    expect(synced).toContainEqual({
      id: target.getAsNormalizedFullLink().id,
      scope: "space",
      path: ["nested"],
    });
  });

  it("sync on a data: URI cell preserves linked cell scope", async () => {
    const linkedCell = runtime.getCell(
      space,
      "scoped-linked-target",
      undefined,
      tx,
    );
    linkedCell.set({ value: "target data" });
    const linkedId = linkedCell.getAsNormalizedFullLink().id;

    const dataURI = dataUriFromValueWithResolvedLinks({
      ref: {
        "/": {
          [LINK_V1_TAG]: {
            id: linkedId,
            path: [],
            scope: "user",
          },
        },
      },
    });
    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const synced: Array<{ id: string; scope?: string }> = [];
    provider.sync = (id: any, selector?: any, scope?: any) => {
      synced.push({ id, scope });
      return originalSync(id, selector, scope);
    };

    await dataCell.sync();

    expect(synced).toContainEqual({ id: linkedId, scope: "user" });
  });

  it("loads immutable inputs under each requested user's full session identity", async () => {
    const alice = await Identity.fromPassphrase("immutable sync Alice");
    const bob = await Identity.fromPassphrase("immutable sync Bob");
    const identities = [
      { principal: alice.did(), sessionId: "Alice first" },
      { principal: alice.did(), sessionId: "Alice second" },
      { principal: bob.did(), sessionId: "Bob first" },
    ];
    const userCell = runtime.getCell(
      space,
      "user-input",
      undefined,
      tx,
      "user",
    );
    const sessionCell = runtime.getCell(
      space,
      "session-input",
      undefined,
      tx,
      "session",
    );
    const inputs = runtime.getImmutableCell(space, { userCell, sessionCell });
    const provider = storageManager.open(space);
    const originalSync = provider.sync;
    const requests: Array<{ id: string; scope?: string; instance?: string }> =
      [];
    provider.sync = (id, _selector, scope, instance) => {
      expect(storageManager.pendingLoadAddresses()).toContainEqual({
        space,
        scope,
        id,
        scopeKey: instance,
      });
      requests.push({ id, scope, instance });
      return Promise.resolve({ ok: {} });
    };
    try {
      for (const identity of identities) {
        await storageManager.syncCell(inputs, { scopeKeyIdentity: identity });
        // An identical request shares the completed naming work.
        await storageManager.syncCell(inputs, {
          scopeKeyIdentity: { ...identity },
        });
      }
      const expected = identities.flatMap((identity) => [
        {
          id: userCell.getAsNormalizedFullLink().id,
          scope: "user",
          instance: resolveScopeKey("user", identity),
        },
        {
          id: sessionCell.getAsNormalizedFullLink().id,
          scope: "session",
          instance: resolveScopeKey("session", identity),
        },
      ]);
      expect(requests).toHaveLength(expected.length);
      expect(requests).toEqual(expect.arrayContaining(expected));
      expect(requests.filter((request) =>
        request.scope === "user" &&
        request.instance === resolveScopeKey("user", identities[0])
      )).toHaveLength(2);
    } finally {
      provider.sync = originalSync;
    }
  });

  it("sync on a data: URI cell with multiple links syncs all of them", async () => {
    const cell1 = runtime.getCell(space, "multi-1", undefined, tx);
    cell1.set("first");
    const cell2 = runtime.getCell(space, "multi-2", undefined, tx);
    cell2.set("second");

    const id1 = cell1.getAsNormalizedFullLink().id;
    const id2 = cell2.getAsNormalizedFullLink().id;

    const dataURI = dataUriFromValueWithResolvedLinks({
      a: {
        "/": {
          [LINK_V1_TAG]: { id: id1, path: [] },
        },
      },
      b: {
        "/": {
          [LINK_V1_TAG]: { id: id2, path: [] },
        },
      },
    });

    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    expect(syncedIds).toContain(id1);
    expect(syncedIds).toContain(id2);
  });

  it("sync on a data: URI cell with links in arrays syncs them", async () => {
    const cell1 = runtime.getCell(space, "arr-1", undefined, tx);
    cell1.set("item1");
    const cell2 = runtime.getCell(space, "arr-2", undefined, tx);
    cell2.set("item2");

    const id1 = cell1.getAsNormalizedFullLink().id;
    const id2 = cell2.getAsNormalizedFullLink().id;

    const dataURI = dataUriFromValueWithResolvedLinks([
      { "/": { [LINK_V1_TAG]: { id: id1, path: [] } } },
      { "/": { [LINK_V1_TAG]: { id: id2, path: [] } } },
    ]);

    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    expect(syncedIds).toContain(id1);
    expect(syncedIds).toContain(id2);
  });

  it("sync on a data: URI cell with no links does not call provider.sync", async () => {
    const dataURI = dataUriFromValueWithResolvedLinks({
      plain: "data",
      count: 42,
    });
    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    expect(syncedIds).toEqual([]);
  });

  it("sync uses cache — repeated calls share the same promise", async () => {
    const linkedCell = runtime.getCell(space, "cache-target", undefined, tx);
    linkedCell.set("cached");
    const linkedId = linkedCell.getAsNormalizedFullLink().id;

    const dataURI = dataUriFromValueWithResolvedLinks({
      ref: { "/": { [LINK_V1_TAG]: { id: linkedId, path: [] } } },
    });

    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    let syncCount = 0;
    provider.sync = (id: any, selector?: any) => {
      syncCount++;
      return originalSync(id, selector);
    };

    // Call sync twice concurrently — the cache should deduplicate
    const [r1, r2] = await Promise.all([dataCell.sync(), dataCell.sync()]);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    // The linked cell should have been synced at most once
    expect(syncCount).toBeLessThanOrEqual(1);
  });

  it("sync on a data: URI cell with nested data: URI links does not crash", async () => {
    // A data URI containing another data URI link — the inner data: link
    // should be skipped (not synced as a storage cell)
    const innerDataURI = dataUriFromValueWithResolvedLinks("inner");
    const dataURI = dataUriFromValueWithResolvedLinks({
      nested: { "/": { [LINK_V1_TAG]: { id: innerDataURI, path: [] } } },
    });

    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    // Should resolve without throwing
    const result = await dataCell.sync();
    expect(result).toBeDefined();
  });

  it("sync walks into the cell path before scanning for links", async () => {
    const linkedCell = runtime.getCell(space, "deep-target", undefined, tx);
    linkedCell.set("deep");
    const linkedId = linkedCell.getAsNormalizedFullLink().id;

    // The link is nested under "level1" > "level2"
    const dataURI = dataUriFromValueWithResolvedLinks({
      level1: {
        level2: {
          ref: {
            "/": { [LINK_V1_TAG]: { id: linkedId, path: [] } },
          },
        },
      },
    });

    // Cell with path ["level1", "level2"] — sync should walk into the
    // value at that path and find the link there
    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      ["level1", "level2"],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    provider.sync = (id: any, selector?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector);
    };

    await dataCell.sync();

    expect(syncedIds).toContain(linkedId);
  });

  it("sync stops walking when the path leaves the data URI's containers", async () => {
    const linkedCell = runtime.getCell(
      space,
      "unreachable-target",
      undefined,
      tx,
    );
    linkedCell.set("never pulled");
    const linkedId = linkedCell.getAsNormalizedFullLink().id;

    // The link sits beside the path, not under it. Walking ["count", "deeper"]
    // steps onto a number, which holds no further segments, so the walk gives
    // up before it ever reaches the link.
    const dataURI = dataUriFromValueWithResolvedLinks({
      count: 42,
      ref: { "/": { [LINK_V1_TAG]: { id: linkedId, path: [] } } },
    });
    const dataCell = runtime.getCellFromEntityId(
      space,
      dataURI,
      ["count", "deeper"],
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedIds: string[] = [];
    // deno-lint-ignore no-explicit-any
    provider.sync = (id: any, selector?: any, scope?: any) => {
      syncedIds.push(id);
      return originalSync(id, selector, scope);
    };

    expect(await dataCell.sync()).toBe(dataCell);
    expect(syncedIds).toEqual([]);
  });

  it("sync on a data: URI cell resolves to the cell it was called on", async () => {
    const dataURI = dataUriFromValueWithResolvedLinks({ simple: "value" });
    const cell = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );

    expect(await cell.sync()).toBe(cell);
    // The second call takes the memoized path. It must still hand back this
    // caller's cell: another cell would carry another transaction, and holding
    // one in the memo would keep that transaction and everything it read alive.
    expect(await cell.sync()).toBe(cell);

    const second = runtime.getCellFromEntityId(
      space,
      dataURI,
      [],
      undefined,
      tx,
    );
    expect(await second.sync()).toBe(second);
  });

  it("does not carry a data: URI sync across storage managers", async () => {
    const linkedCell = runtime.getCell(space, "cross-manager", undefined, tx);
    linkedCell.set({ value: "target data" });
    const linkedId = linkedCell.getAsNormalizedFullLink().id;
    const dataURI = dataUriFromValueWithResolvedLinks({
      ref: { "/": { [LINK_V1_TAG]: { id: linkedId, path: [] } } },
    });

    await runtime.getCellFromEntityId(space, dataURI, [], undefined, tx).sync();

    // A second manager has its own providers and its own session. It must pull
    // the link target itself rather than inherit the first manager's work.
    const otherStorageManager = StorageManager.emulate({ as: signer });
    const otherRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherStorageManager,
    });
    const otherTx = otherRuntime.edit();
    try {
      const provider = otherStorageManager.open(space);
      const originalSync = provider.sync.bind(provider);
      const syncedIds: string[] = [];
      // deno-lint-ignore no-explicit-any
      provider.sync = (id: any, selector?: any, scope?: any) => {
        syncedIds.push(id);
        return originalSync(id, selector, scope);
      };

      await otherRuntime
        .getCellFromEntityId(space, dataURI, [], undefined, otherTx)
        .sync();

      expect(syncedIds).toContain(linkedId);
    } finally {
      await otherTx.commit();
      await otherRuntime.dispose();
      await otherStorageManager.close();
    }
  });

  it("syncs a linked cell under the reader's schema, not the link's", async () => {
    const linkedCell = runtime.getCell(
      space,
      "linked-target-under-reader-schema",
      undefined,
      tx,
    );
    linkedCell.set({ name: "Ada", extra: { big: true } });
    const linkedId = linkedCell.getAsNormalizedFullLink().id;
    const wide = {
      type: "object",
      properties: {
        name: { type: "string" },
        extra: { type: "object", properties: { big: { type: "boolean" } } },
      },
    } as const;
    const narrow = {
      type: "object",
      properties: { name: { type: "string" } },
    } as const;

    // The link carries the wide schema; the reader asks for the narrow one.
    const dataCell = runtime.getImmutableCell(
      space,
      { ref: linkedCell.asSchema(wide).getAsLink({ includeSchema: true }) },
      undefined,
      tx,
    );

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const schemasByTarget = new Map<string, unknown>();
    provider.sync = (id: any, selector?: any, scope?: any) => {
      schemasByTarget.set(id, selector?.schema);
      return originalSync(id, selector, scope);
    };

    await dataCell.asSchema({
      type: "object",
      properties: { ref: narrow },
    }).sync();

    expect(schemasByTarget.get(linkedId)).toEqual(narrow);
  });
});

describe("data URI sync memo key", () => {
  const identity = {
    id: "data:application/json,{}",
    schema: undefined,
    path: [] as readonly string[],
    space,
    scope: undefined,
  };

  it("costs the same however large the data URI is", () => {
    const small = dataURISyncKey(identity);
    const huge = dataURISyncKey({
      ...identity,
      id: `data:application/json,${"x".repeat(200_000)}`,
    });
    expect(huge.length).toBe(small.length);
    expect(huge).not.toBe(small);
  });

  it("separates entries that differ in any part of their identity", () => {
    const base = dataURISyncKey(identity);
    const keys = [
      base,
      dataURISyncKey({ ...identity, id: 'data:application/json,{"a":1}' }),
      dataURISyncKey({ ...identity, schema: { type: "string" } }),
      dataURISyncKey({ ...identity, path: ["value"] }),
      dataURISyncKey({ ...identity, scope: "user" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives one identity one key", () => {
    expect(dataURISyncKey({ ...identity, path: ["a", "b"] }))
      .toBe(dataURISyncKey({ ...identity, path: ["a", "b"] }));
  });
});
