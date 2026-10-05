import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type Cell, entityIdFrom, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { linkSqliteDiskSource } from "../lib/piece.ts";
import { deriveDiskHandleId } from "../lib/sqlite-source.ts";

const signer = await Identity.fromPassphrase("cf-sqlite-link-seed");
const config = {
  apiUrl: "https://example.com",
  identity: "/unused.key",
  space: signer.did(),
};

/**
 * `cf piece link sqlite:` end to end, through the real
 * `linkSqliteDiskSource` — the seam the pure `diskHandleSeed` tests cannot
 * reach. What they cannot see is the `sync()` and the `get()` that feed the
 * decision: with either one wrong the helper is handed `undefined` every time
 * and re-seeds an empty contract over a declared one, exactly the silent
 * label downgrade this path exists to prevent.
 */
describe("linkSqliteDiskSource handle seeding", () => {
  const DISK_PATH = "/tmp/cf-sqlite-link-seed-fixture.db";
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let warnings: string[];
  let originalWarn: typeof console.warn;
  let linkCalls: unknown[][];
  let registered: Array<[string, string]>;
  let deps: { loadPieces: () => Promise<unknown> };

  const handleCell = (): Cell<unknown> =>
    runtime.getCellFromEntityId(
      signer.did(),
      entityIdFrom(deriveDiskHandleId(signer.did(), DISK_PATH)),
    );

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    linkCalls = [];
    registered = [];
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    const provider = runtime.storageManager.open(signer.did()) as {
      registerSqliteDiskSource?: (id: string, path: string) => Promise<void>;
    };
    // The registration talks to a server this test does not run; the seam
    // under test is the handle write that precedes it.
    provider.registerSqliteDiskSource = (id: string, path: string) => {
      registered.push([id, path]);
      return Promise.resolve();
    };

    const pieces = {
      runtime,
      getSpace: () => signer.did(),
      link: (...args: unknown[]) => {
        linkCalls.push(args);
        return Promise.resolve();
      },
      synced: () => Promise.resolve(),
    };
    deps = { loadPieces: () => Promise.resolve(pieces) };
  });

  afterEach(async () => {
    console.warn = originalWarn;
    // The emulated storage manager holds a loopback server, so it is closed
    // whether or not disposing the runtime rejected — otherwise one failing
    // teardown leaks a server into every test that follows it.
    try {
      await runtime?.dispose();
    } finally {
      await storageManager?.close();
    }
  });

  const link = () =>
    linkSqliteDiskSource(
      config as never,
      DISK_PATH,
      "piece",
      ["db"],
      undefined,
      {
        ...deps,
        resolvePieceAddress: (_pieces: never, token: string) =>
          Promise.resolve(token),
      } as never,
    );

  it("seeds an empty contract on a first link", async () => {
    await link();
    const handle = handleCell();
    await handle.pull();
    expect(handle.get()).toEqual({
      id: deriveDiskHandleId(signer.did(), DISK_PATH),
      tables: {},
      rev: 0,
    });
    expect(registered).toEqual([[
      deriveDiskHandleId(signer.did(), DISK_PATH),
      DISK_PATH,
    ]]);
    expect(linkCalls.length).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("keeps a declared contract on a re-link, and says that it did", async () => {
    const id = deriveDiskHandleId(signer.did(), DISK_PATH);
    const declared = {
      id,
      tables: {
        records: {
          properties: { body: { ifc: { confidentiality: ["finance"] } } },
        },
      },
      owner: "did:key:z6MkOwner",
      scope: "user",
      rev: 7,
    };
    const seed = runtime.edit();
    handleCell().withTx(seed).set(declared);
    expect((await seed.commit().settled).error).toBeUndefined();

    await link();

    const handle = handleCell();
    await handle.pull();
    expect(handle.get()).toEqual(declared);
    expect(warnings).toEqual([
      "cf piece link: kept the existing contract, 1 table " +
      "(re-linking does not reset it)",
    ]);
    // The rest of the link still happens — only the seed write is skipped.
    expect(registered.length).toBe(1);
    expect(linkCalls.length).toBe(1);
  });

  it("repairs a handle whose id names a different source, and says that it did", async () => {
    // The handle sits at the id this (space, path) derives, so a stored `id`
    // that names something else is corrupt: a query following it reaches the
    // wrong registry entry, and an id-presence check would leave it there.
    // Repairing the id carries the declared contract across rather than
    // lowering every column's read label to nothing.
    const declared = {
      records: {
        properties: { body: { ifc: { confidentiality: ["finance"] } } },
      },
    };
    const seed = runtime.edit();
    handleCell().withTx(seed).set(
      { id: "of:fid1:another-source", tables: declared, rev: 7 } as never,
    );
    expect((await seed.commit().settled).error).toBeUndefined();

    await link();

    const handle = handleCell();
    await handle.pull();
    // The labels travel; `rev` counted a source this handle never was, so it
    // starts over.
    expect(handle.get()).toEqual({
      id: deriveDiskHandleId(signer.did(), DISK_PATH),
      tables: declared,
      rev: 0,
    });
    expect(warnings).toEqual([
      "cf piece link: repaired an unusable handle id, keeping the existing " +
      "contract, 1 table",
    ]);
    expect(registered.length).toBe(1);
    expect(linkCalls.length).toBe(1);
  });

  it("re-seeds a handle whose stored value carries no id", async () => {
    // Not a usable handle: `readDbRef` refuses a value whose `id` is not a
    // string, so a doc in this state must be seeded rather than preserved.
    const seed = runtime.edit();
    handleCell().withTx(seed).set({ tables: {} } as never);
    expect((await seed.commit().settled).error).toBeUndefined();

    await link();

    const handle = handleCell();
    await handle.pull();
    expect((handle.get() as { id?: string }).id).toBe(
      deriveDiskHandleId(signer.did(), DISK_PATH),
    );
    expect(warnings).toEqual([]);
  });
});
