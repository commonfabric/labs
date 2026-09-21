import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { type Options as V2StorageOptions } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-lazy-session");
const space = signer.did();
const type = "application/json" as const;

function entityListingStorage(
  serverFlags: Record<string, boolean>,
  session: Record<string, unknown>,
) {
  const storage = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://"),
  }, {
    create: () =>
      Promise.resolve({
        client: {
          serverFlags,
          close: () => Promise.resolve(),
        } as never,
        session: { subscribeAccessLoss: () => () => {}, ...session } as never,
      }),
  });
  return { storage, provider: storage.open(space) };
}

class TestEmulatedStorageManager extends EmulatedStorageManager {
  static emulateWithServerFactory(
    options: Omit<V2StorageOptions, "memoryHost" | "spaceHostMap">,
    serverFactory: () => MemoryV2Server.Server,
  ): TestEmulatedStorageManager {
    return new this(
      {
        ...options,
        memoryHost: new URL("memory://"),
      },
      serverFactory,
    );
  }

  protected constructor(
    options: V2StorageOptions,
    serverFactory: () => MemoryV2Server.Server,
  ) {
    super(options, serverFactory);
  }
}

const appliedCommitFor = (ids: URI[]): AppliedCommit => ({
  seq: 1,
  branch: "",
  revisions: ids.map((id, index) => ({
    id,
    scopeKey: "space",
    branch: "",
    seq: 1,
    opIndex: index,
    commitSeq: 1,
    op: "set",
  })),
});

describe("Memory v2 lazy session creation", () => {
  it("does not create a session for open or local transaction reads and writes", async () => {
    let sessionCreates = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, {
      create(_space: MemorySpace) {
        sessionCreates += 1;
        return Promise.resolve({
          client: { close: async () => {} } as never,
          session: {
            subscribeAccessLoss: () => () => {},
          } as never,
        });
      },
    });

    storage.open(space);

    const tx = storage.edit();
    const write = tx.write({
      space,
      id: "of:memory-v2-lazy-session-open",
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    expect(write.error).toBeUndefined();

    const read = tx.read({
      space,
      id: "of:memory-v2-lazy-session-open",
      type,
      path: ["value", "count"],
    });
    expect(read.ok?.value).toBe(1);
    expect(sessionCreates).toBe(0);

    tx.abort();
    await storage.close();
    expect(sessionCreates).toBe(0);
  });

  it("can authenticate a space without reading entity data", async () => {
    let sessionCreates = 0;
    let closes = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, {
      create(_space: MemorySpace) {
        sessionCreates++;
        return Promise.resolve({
          client: {
            close: () => {
              closes++;
              return Promise.resolve();
            },
          } as never,
          session: {
            subscribeAccessLoss: () => () => {},
          } as never,
        });
      },
    });
    const provider = storage.open(space);

    await provider.ensureSession!();
    await provider.ensureSession!();
    expect(sessionCreates).toBe(1);

    await storage.close();
    expect(closes).toBe(1);
  });

  it("creates a session lazily on the first commit", async () => {
    let sessionCreates = 0;
    let commits = 0;
    let closes = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, {
      create(_space: MemorySpace) {
        sessionCreates += 1;
        return Promise.resolve({
          client: {
            close: () => {
              closes += 1;
              return Promise.resolve();
            },
          } as never,
          session: {
            subscribeAccessLoss: () => () => {},
            transact: (commit: { operations: { id: URI }[] }) => {
              commits += 1;
              return Promise.resolve(
                appliedCommitFor(commit.operations.map((op) => op.id)),
              );
            },
          } as never,
        });
      },
    });

    const tx = storage.edit();
    const id = "of:memory-v2-lazy-session-commit" as URI;
    tx.write({
      space,
      id,
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    expect(sessionCreates).toBe(0);

    const result = await tx.commit();
    expect(result).toEqual({ ok: {} });
    expect(sessionCreates).toBe(1);
    expect(commits).toBe(1);

    await storage.close();
    expect(closes).toBe(1);
  });

  it("coalesces session creation across synchronous factory re-entry", async () => {
    let sessionCreates = 0;
    let commits = 0;
    let reentrantCommit: Promise<unknown> | undefined;
    const state: { storage?: TestStorageManager } = {};
    const sessionFactory = {
      create(_space: MemorySpace) {
        sessionCreates += 1;
        if (sessionCreates === 1) {
          const nestedTx = state.storage!.edit();
          nestedTx.write({
            space,
            id: "of:memory-v2-reentrant-session-nested" as URI,
            type,
            path: [],
          }, { value: { count: 2 } });
          reentrantCommit = nestedTx.commit();
        }
        return Promise.resolve({
          client: { close: () => Promise.resolve() } as never,
          session: {
            subscribeAccessLoss: () => () => {},
            transact: (commit: { operations: { id: URI }[] }) => {
              commits += 1;
              return Promise.resolve(
                appliedCommitFor(commit.operations.map((op) => op.id)),
              );
            },
          } as never,
        });
      },
    };
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, sessionFactory);
    state.storage = storage;

    const tx = storage.edit();
    tx.write({
      space,
      id: "of:memory-v2-reentrant-session-outer" as URI,
      type,
      path: [],
    }, { value: { count: 1 } });

    expect(await tx.commit()).toEqual({ ok: {} });
    expect(await reentrantCommit).toEqual({ ok: {} });
    expect(sessionCreates).toBe(1);
    expect(commits).toBe(2);
    await storage.close();
  });

  it("retries lazy session creation after a transient failure", async () => {
    let sessionCreates = 0;
    let commits = 0;
    let closes = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, {
      create(_space: MemorySpace) {
        sessionCreates += 1;
        if (sessionCreates === 1) {
          return Promise.reject(new Error("temporary session failure"));
        }
        return Promise.resolve({
          client: {
            close: () => {
              closes += 1;
              return Promise.resolve();
            },
          } as never,
          session: {
            subscribeAccessLoss: () => () => {},
            transact: (commit: { operations: { id: URI }[] }) => {
              commits += 1;
              return Promise.resolve(
                appliedCommitFor(commit.operations.map((op) => op.id)),
              );
            },
          } as never,
        });
      },
    });

    const firstTx = storage.edit();
    firstTx.write({
      space,
      id: "of:memory-v2-lazy-session-first-failure",
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    const first = await firstTx.commit();
    expect(first.error).toBeDefined();

    const secondTx = storage.edit();
    secondTx.write({
      space,
      id: "of:memory-v2-lazy-session-second-try" as URI,
      type,
      path: [],
    }, {
      value: { count: 2 },
    });
    const second = await secondTx.commit();

    expect(second).toEqual({ ok: {} });
    expect(sessionCreates).toBe(2);
    expect(commits).toBe(1);

    await storage.close();
    expect(closes).toBe(1);
  });
});

describe("Memory v2 entity identifier capabilities", () => {
  it("does not send identifier RPCs that the server did not advertise", async () => {
    let listCalls = 0;
    let lookupCalls = 0;
    const { storage, provider } = entityListingStorage({}, {
      listEntityIds: () => {
        listCalls++;
        return Promise.resolve({ serverSeq: 1, ids: [] });
      },
      entityIdExists: () => {
        lookupCalls++;
        return Promise.resolve({ serverSeq: 1, exists: true });
      },
    });

    try {
      expect(provider.replica.did()).toBe(space);
      expect(await provider.listEntityIds!()).toBeUndefined();
      expect(await provider.listEntityIdPage!()).toBeUndefined();
      expect(await provider.entityIdExists!("of:fid1:missing-capability"))
        .toBeUndefined();
      expect(listCalls).toBe(0);
      expect(lookupCalls).toBe(0);
    } finally {
      await storage.close();
    }
  });

  it("uses the unpaginated listing RPC for a server without pagination", async () => {
    const requests: unknown[] = [];
    const { storage, provider } = entityListingStorage({
      entityIdListing: true,
      entityIdPagination: false,
    }, {
      listEntityIds: (options?: unknown) => {
        requests.push(options);
        return Promise.resolve({
          serverSeq: 4,
          ids: ["of:fid1:legacy-a", "of:fid1:legacy-b"],
        });
      },
    });

    try {
      expect(await provider.listEntityIds!()).toEqual([
        "of:fid1:legacy-a",
        "of:fid1:legacy-b",
      ]);
      expect(await provider.listEntityIdPage!({ limit: 1 })).toBeUndefined();
      expect(requests).toEqual([undefined]);
    } finally {
      await storage.close();
    }
  });

  it("propagates an unavailable page from a paginated listing server", async () => {
    const requests: unknown[] = [];
    const { storage, provider } = entityListingStorage({
      entityIdListing: true,
      entityIdPagination: true,
    }, {
      listEntityIds: (options?: unknown) => {
        requests.push(options);
        return Promise.resolve(undefined);
      },
    });

    try {
      expect(await provider.listEntityIds!()).toBeUndefined();
      expect(requests).toEqual([{}]);
    } finally {
      await storage.close();
    }
  });
});

describe("Memory v2 lazy emulated server creation", () => {
  it("uses the manager id for every emulated space session", async () => {
    const opened: Array<{ space: string; sessionId?: string }> = [];
    const managerId = "runner-emulated-construction-session";
    const storage = TestEmulatedStorageManager.emulateWithServerFactory(
      { as: signer, id: managerId },
      () =>
        new MemoryV2Server.Server({
          authorizeSessionOpen(message) {
            opened.push({
              space: message.space,
              sessionId: message.session.sessionId,
            });
            return signer.did();
          },
          sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
          acl: { mode: "off" },
        }),
    );
    const otherSpace = "did:key:z6Mk-emulated-manager-session" as MemorySpace;

    try {
      for (const targetSpace of [space, otherSpace]) {
        const result = await storage.open(targetSpace).sync(
          "of:emulated-manager-session" as URI,
        );
        expect(result.error).toBeUndefined();
      }
      expect(opened).toEqual([
        { space, sessionId: managerId },
        { space: otherSpace, sessionId: managerId },
      ]);
    } finally {
      await storage.close();
    }
  });

  it("does not create an emulated server for local-only transaction work", async () => {
    let serverCreates = 0;
    const storage = TestEmulatedStorageManager.emulateWithServerFactory(
      { as: signer },
      () => {
        serverCreates += 1;
        return new MemoryV2Server.Server(TEST_MEMORY_SERVER_AUTH);
      },
    );

    storage.open(space);

    const tx = storage.edit();
    const write = tx.write({
      space,
      id: "of:memory-v2-lazy-emulated-server-open",
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    expect(write.error).toBeUndefined();

    const read = tx.read({
      space,
      id: "of:memory-v2-lazy-emulated-server-open",
      type,
      path: ["value", "count"],
    });
    expect(read.ok?.value).toBe(1);
    expect(serverCreates).toBe(0);

    tx.abort();
    await storage.close();
    expect(serverCreates).toBe(0);
  });

  it("creates the emulated server lazily on the first commit", async () => {
    let serverCreates = 0;
    const storage = TestEmulatedStorageManager.emulateWithServerFactory(
      { as: signer },
      () => {
        serverCreates += 1;
        return new MemoryV2Server.Server(TEST_MEMORY_SERVER_AUTH);
      },
    );

    const id = "of:memory-v2-lazy-emulated-server-commit" as URI;
    const tx = storage.edit();
    tx.write({
      space,
      id,
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    expect(serverCreates).toBe(0);

    const result = await tx.commit();
    expect(result).toEqual({ ok: {} });
    expect(serverCreates).toBe(1);

    await storage.close();
  });
});
