import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type ClientCommit,
  commitPreconditionValueHash,
  resolveScopeKey,
} from "@commonfabric/memory/v2";

import * as MemoryV2Client from "@commonfabric/memory/v2/client";

import { Runtime } from "../../src/runtime.ts";
import { getCommitLocalSeq } from "../../src/storage/commit-identity.ts";
import { restrictToLocalReads } from "../../src/storage/local-read-policy.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import type { SpaceReplica } from "../../src/storage/v2.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("local session documents");
const space = signer.did();

describe("local-session-documents", () => {
  it("reads and writes session state without opening a server connection", async () => {
    let connections = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("http://localhost:65535"),
    }, {
      create() {
        connections++;
        throw new Error("Session state must stay local");
      },
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: { localSessionDocuments: true, serverExecution: false },
    });
    try {
      const cell = runtime.getCell<number>(
        space,
        "count",
        undefined,
        undefined,
        "session",
      );
      await cell.sync();
      expect(cell.get()).toBeUndefined();
      const localRead = runtime.edit();
      restrictToLocalReads(localRead.tx);
      expect(cell.withTx(localRead).get()).toBeUndefined();
      localRead.abort();
      for (const value of [1, 2]) {
        const tx = runtime.edit();
        cell.withTx(tx).set(value);
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(cell.get()).toBe(value);
      }
      const pin = runtime.edit();
      pin.addCommitPrecondition!(space, {
        kind: "entity-value-hash",
        id: cell.getAsNormalizedFullLink().id,
        scope: "session",
        valueHash: commitPreconditionValueHash(2),
      });
      cell.withTx(pin).set(3);
      expect((await pin.commit().settled).error).toBeUndefined();
      expect(cell.get()).toBe(3);

      const stale = runtime.edit();
      stale.addCommitPrecondition!(space, {
        kind: "entity-value-hash",
        id: cell.getAsNormalizedFullLink().id,
        scope: "session",
        valueHash: commitPreconditionValueHash(2),
      });
      cell.withTx(stale).set(4);
      expect((await stale.commit().settled).error?.name).toBe("ConflictError");
      expect(cell.get()).toBe(3);
      await storage.synced();
      expect(connections).toBe(0);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("synchronizes foreign session instances while keeping its own instance local", async () => {
    let connections = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("https://default.test"),
    }, {
      create() {
        connections++;
        throw new Error("Foreign instance reached the server connection");
      },
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: { localSessionDocuments: true, serverExecution: false },
    });
    try {
      const cell = runtime.getCell<number>(
        space,
        "instances",
        undefined,
        undefined,
        "session",
      );
      const id = cell.getAsNormalizedFullLink().id;
      const own = runtime.scopeKeyIdentity;
      const foreign = { ...own, sessionId: "another-session" };
      const ownKey = resolveScopeKey("session", own);
      const foreignKey = resolveScopeKey("session", foreign);
      const replica = storage.open(space).replica as SpaceReplica;
      expect(replica.hasLocalDocumentCoverage(id, "session", own)).toBe(true);
      expect(replica.hasLocalDocumentCoverage(id, "session", foreign)).toBe(
        false,
      );
      expect((await replica.sync(id, undefined, "session", ownKey)).error)
        .toBeUndefined();
      expect(connections).toBe(0);
      const tx = runtime.edit();
      cell.withTx(tx).set(1);
      expect((await tx.commit().settled).error).toBeUndefined();
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 0,
        toSeq: 5,
        upserts: [ownKey, foreignKey].map((scopeKey) => ({
          branch: "",
          id,
          scope: "session",
          scopeKey,
          seq: 5,
          doc: { value: 2 },
        })),
        removes: [],
      }, "integrate");
      expect(cell.get()).toBe(1);
      expect(replica.getDocument(id, "session", foreign)?.value).toBe(2);
      expect(replica.hasLocalDocumentCoverage(id, "session", foreign)).toBe(
        true,
      );
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 5,
        toSeq: 6,
        upserts: [],
        removes: [ownKey, foreignKey].map((scopeKey) => ({
          branch: "",
          id,
          scope: "session",
          scopeKey,
        })),
      }, "integrate");
      expect(cell.get()).toBe(1);
      expect(replica.getDocument(id, "session", foreign)).toBeUndefined();
      expect(storage.registerSpaceHostDetailed(space, "https://hinted.test"))
        .toEqual({ accepted: true });
      await storage.crossSpaceSettled();
      const replacement = storage.open(space).replica as SpaceReplica;
      expect(replacement).not.toBe(replica);
      expect(cell.get()).toBe(1);
      expect(replacement.hasLocalDocumentCoverage(id, "session", foreign)).toBe(
        false,
      );
      expect(
        (await replacement.sync(id, undefined, "session", foreignKey)).error,
      ).toBeDefined();
      expect(connections).toBe(1);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  for (const serverExecution of [false, true]) {
    it(`refuses conflicting execution modes on a shared manager (${serverExecution})`, async () => {
      const storage = EmulatedStorageManager.emulate({ as: signer });
      const first = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: { localSessionDocuments: true, serverExecution },
      });
      let second: Runtime | undefined;
      try {
        expect(() => {
          second = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: storage,
            experimental: {
              localSessionDocuments: true,
              serverExecution: !serverExecution,
            },
          });
        }).toThrow("Session document policy is already configured");
        storage.setLocalSessionDocuments(!serverExecution);
      } finally {
        await second?.dispose();
        await first.dispose();
        await storage.close();
      }
    });
  }

  it("preserves session documents and local origins across a route replacement", async () => {
    let connections = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("https://default.test"),
    }, {
      create() {
        connections++;
        throw new Error("Local state must not open a connection");
      },
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: {
        localSessionDocuments: true,
        serverExecution: false,
        commitPreconditions: true,
      },
    });
    try {
      const cell = runtime.getCell<number>(
        space,
        "route-count",
        undefined,
        undefined,
        "session",
      );
      const seed = runtime.edit();
      cell.withTx(seed).set(1);
      expect((await seed.commit().settled).error).toBeUndefined();
      const originLocalSeq = getCommitLocalSeq(seed.tx, space)!;
      const previous = storage.open(space).replica;
      expect(storage.registerSpaceHostDetailed(space, "https://hinted.test"))
        .toEqual({ accepted: true });
      await storage.crossSpaceSettled();
      expect(storage.open(space).replica).not.toBe(previous);
      expect(cell.get()).toBe(1);
      const guarded = runtime.edit();
      guarded.addCommitPrecondition!(space, {
        kind: "origin-committed",
        originLocalSeq,
      });
      cell.withTx(guarded).set(2);
      expect((await guarded.commit().settled).error).toBeUndefined();
      expect(getCommitLocalSeq(guarded.tx, space)).toBeGreaterThan(
        originLocalSeq,
      );
      expect(cell.get()).toBe(2);
      expect(connections).toBe(0);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("rejects a guard on an early-rejected local origin without sending it", async () => {
    const server = newSharedServer();
    const repairing = Promise.withResolvers<void>();
    const repaired = Promise.withResolvers<void>();
    let sends = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("https://default.test"),
    }, {
      async create(space, signer, options) {
        const client = await MemoryV2Client.connect({
          transport: MemoryV2Client.loopback(server),
        });
        const session = await client.mount(
          space,
          options,
          testPrincipalSessionOpenAuthFactory(signer),
        );
        session.transact = (commit) => {
          sends++;
          return Promise.reject({
            name: "ConflictError",
            message: "controlled rejection",
            readyToRetry: () => {
              repairing.resolve();
              return repaired.promise.then(() => {
                (storage.open(space).replica as SpaceReplica)
                  .accessForTestingOnly
                  .noteCaughtUpLocalSeq(commit.localSeq);
              });
            },
          });
        };
        return { client, session };
      },
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: {
        localSessionDocuments: true,
        serverExecution: false,
        commitPreconditions: true,
      },
    });
    try {
      const session = runtime.getCell<number>(
        space,
        "rejected-count",
        undefined,
        undefined,
        "session",
      );
      const shared = runtime.getCell<number>(space, "rejected-shared");
      const parent = runtime.edit();
      session.withTx(parent).set(1);
      shared.withTx(parent).set(1);
      const parentCommit = parent.commit();
      await repairing.promise;
      const child = runtime.edit();
      session.withTx(child).set(session.withTx(child).get() + 1);
      const childCommit = child.commit();
      const originLocalSeq = getCommitLocalSeq(child.tx, space)!;
      repaired.resolve();
      expect((await parentCommit.settled).error?.name).toBe("ConflictError");
      expect((await childCommit.settled).error?.name).toBe("ConflictError");
      const guarded = runtime.edit();
      guarded.addCommitPrecondition!(space, {
        kind: "origin-committed",
        originLocalSeq,
      });
      session.withTx(guarded).set(3);
      expect((await guarded.commit().settled).error?.name).toBe(
        "PreconditionFailedError",
      );
      expect(sends).toBe(1);
    } finally {
      repaired.resolve();
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });

  for (const stale of [false, true]) {
    it(`validates shared reads used by a session write under server execution (stale ${stale})`, async () => {
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
        experimental: {
          localSessionDocuments: true,
          serverExecution: true,
          commitPreconditions: true,
        },
      });
      try {
        const seed = writer.edit();
        writer.getCell<number>(space, "shared-read", undefined, seed).set(1);
        expect((await seed.commit().settled).error).toBeUndefined();
        const shared = reader.getCell<number>(space, "shared-read");
        if (!stale) await shared.sync();
        const tx = reader.edit();
        expect(shared.withTx(tx).get()).toBe(stale ? undefined : 1);
        const local = reader.getCell<number>(
          space,
          "shared-read-output",
          undefined,
          undefined,
          "session",
        );
        local.withTx(tx).set(2);
        expect((await tx.commit().settled).error?.name).toBe(
          stale ? "ConflictError" : undefined,
        );
        expect(local.get()).toBe(stale ? undefined : 2);
        if (!stale) {
          const guarded = reader.edit();
          guarded.addCommitPrecondition!(space, {
            kind: "origin-committed",
            originLocalSeq: getCommitLocalSeq(tx.tx, space)!,
          });
          local.withTx(guarded).set(3);
          expect((await guarded.commit().settled).error).toBeUndefined();
          expect(local.get()).toBe(3);
        }
      } finally {
        await reader.dispose();
        await writer.dispose();
        await readerStorage.close();
        await writerStorage.close();
        await server.close();
      }
    });
  }

  for (const stale of [false, true]) {
    it(`confirms shared reads used by a session write under client execution (stale ${stale})`, async () => {
      // The session write stays on the replica, and the commit carrying its
      // shared reads travels with no operations. A verdict refusing a read
      // rolls the session write back, whether a handler or a derivation made
      // it.

      const server = newSharedServer();
      const commits: ClientCommit[] = [];
      const transact = server.transact.bind(server);
      server.transact = (...args: Parameters<typeof transact>) => {
        commits.push(args[0].commit);
        return transact(...args);
      };
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
        experimental: {
          localSessionDocuments: true,
          serverExecution: false,
          commitPreconditions: true,
        },
      });
      try {
        const seed = writer.edit();
        writer.getCell<number>(space, "shared-read", undefined, seed).set(1);
        expect((await seed.commit().settled).error).toBeUndefined();
        const sent = commits.length;
        const shared = reader.getCell<number>(space, "shared-read");
        if (!stale) await shared.sync();
        const tx = reader.edit();
        expect(shared.withTx(tx).get()).toBe(stale ? undefined : 1);
        const local = reader.getCell<number>(
          space,
          "shared-read-output",
          undefined,
          undefined,
          "session",
        );
        local.withTx(tx).set(2);
        expect((await tx.commit().settled).error?.name).toBe(
          stale ? "ConflictError" : undefined,
        );
        expect(local.get()).toBe(stale ? undefined : 2);
        expect(commits).toHaveLength(sent + 1);
        expect(commits[sent].operations).toEqual([]);
        const scopes = new Set(
          [...commits[sent].reads.confirmed, ...commits[sent].reads.pending]
            .map((read) => read.scope ?? "space"),
        );
        expect([...scopes]).toEqual(["space"]);
      } finally {
        await reader.dispose();
        await writer.dispose();
        await readerStorage.close();
        await writerStorage.close();
        await server.close();
      }
    });
  }

  for (const rejected of [false, true]) {
    it(`settles a session write over a shared pending layer with that layer's commit (${rejected ? "rejects" : "succeeds"})`, async () => {
      // The session write read the shared document through the optimistic
      // layer of a commit still awaiting its verdict. It travels with no
      // operations, and settles as that commit's verdict decides.

      const server = newSharedServer();
      const commits: ClientCommit[] = [];
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const transact = server.transact.bind(server);
      server.transact = async (...args: Parameters<typeof transact>) => {
        commits.push(args[0].commit);
        entered.resolve();
        await release.promise;
        return await transact(...args);
      };
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: {
          localSessionDocuments: true,
          serverExecution: false,
          commitPreconditions: true,
        },
      });
      try {
        const session = runtime.getCell<number>(
          space,
          "layered-count",
          undefined,
          undefined,
          "session",
        );
        const shared = runtime.getCell<number>(space, "layered-count");
        const origin = runtime.edit();
        shared.withTx(origin).set(3);
        if (rejected) {
          origin.addCommitPrecondition!(space, {
            kind: "origin-committed",
            originLocalSeq: 999999,
          });
        }
        const originCommit = origin.commit();
        await entered.promise;
        const dependent = runtime.edit();
        session.withTx(dependent).set(shared.withTx(dependent).get() + 10);
        const dependentCommit = dependent.commit();
        expect(session.get()).toBe(13);
        release.resolve();
        expect((await originCommit.settled).error?.name).toBe(
          rejected ? "PreconditionFailedError" : undefined,
        );
        expect((await dependentCommit.settled).error?.name).toBe(
          rejected ? "ConflictError" : undefined,
        );
        expect(shared.get()).toBe(rejected ? undefined : 3);
        expect(session.get()).toBe(rejected ? undefined : 13);
        expect(commits).toHaveLength(2);
        expect(commits[1].operations).toEqual([]);
      } finally {
        release.resolve();
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }

  it("rejects a waiting blind session write when its route is replaced", async () => {
    const started = Promise.withResolvers<void>();
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("https://default.test"),
    }, {
      create(_space, _signer, _options, signal) {
        started.resolve();
        return new Promise((_, reject) => {
          const abort = () => reject(signal?.reason ?? new Error("aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: { localSessionDocuments: true, serverExecution: false },
    });
    try {
      const local = runtime.getCell<number>(
        space,
        "waiting-local",
        undefined,
        undefined,
        "session",
      );
      const seed = runtime.edit();
      local.withTx(seed).set(1);
      expect((await seed.commit().settled).error).toBeUndefined();
      const replica = storage.open(space).replica;
      const id = local.getAsNormalizedFullLink().id;
      const mixed = replica.commitNative!({
        operations: [
          {
            op: "set",
            id,
            type: "application/json",
            scope: "session",
            value: { value: 2 },
          },
          {
            op: "set",
            id: "of:waiting-shared",
            type: "application/json",
            scope: "space",
            value: { value: 3 },
          },
        ],
      });
      await started.promise;
      const blind = replica.commitNative!({
        operations: [
          {
            op: "set",
            id,
            type: "application/json",
            scope: "session",
            value: { value: 4 },
          },
        ],
      });
      expect(local.get()).toBe(4);
      expect(storage.registerSpaceHostDetailed(space, "https://hint.test"))
        .toEqual({ accepted: true });
      await storage.crossSpaceSettled();
      expect((await mixed).error?.name).toBe("ConflictError");
      expect((await blind).error?.name).toBe("ConflictError");
      expect(local.get()).toBe(1);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("rolls back local session writes when the shared commit is rejected", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: {
        localSessionDocuments: true,
        serverExecution: false,
        commitPreconditions: true,
      },
    });
    try {
      const session = runtime.getCell<number>(
        space,
        "count",
        undefined,
        undefined,
        "session",
      );
      const shared = runtime.getCell<number>(space, "count");
      const seed = runtime.edit();
      session.withTx(seed).set(1);
      expect((await seed.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      session.withTx(tx).set(2);
      shared.withTx(tx).set(3);
      tx.addCommitPrecondition!(space, {
        kind: "origin-committed",
        originLocalSeq: 999999,
      });
      expect((await tx.commit().settled).error?.name).toBe(
        "PreconditionFailedError",
      );
      expect(session.get()).toBe(1);
      expect(shared.get()).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  for (const dependentScope of ["session", "mixed"]) {
    for (const rejected of [false, true]) {
      it(`settles ${dependentScope} dependants and guarded writes when a mixed commit ${rejected ? "rejects" : "succeeds"}`, async () => {
        const server = newSharedServer();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const transact = server.transact.bind(server);
        server.transact = async (...args: Parameters<typeof transact>) => {
          entered.resolve();
          await release.promise;
          return await transact(...args);
        };
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
          experimental: {
            localSessionDocuments: true,
            serverExecution: false,
            commitPreconditions: true,
          },
        });
        try {
          const session = runtime.getCell<number>(
            space,
            "dependent-count",
            undefined,
            undefined,
            "session",
          );
          const shared = runtime.getCell<number>(space, "dependent-count");
          const seed = runtime.edit();
          session.withTx(seed).set(1);
          expect((await seed.commit().settled).error).toBeUndefined();

          const mixed = runtime.edit();
          session.withTx(mixed).set(2);
          shared.withTx(mixed).set(3);
          if (rejected) {
            mixed.addCommitPrecondition!(space, {
              kind: "origin-committed",
              originLocalSeq: 999999,
            });
          }
          const mixedCommit = mixed.commit();
          await entered.promise;
          expect(session.get()).toBe(2);

          const dependent = runtime.edit();
          const next = session.withTx(dependent);
          next.set(next.get() + 1);
          if (dependentScope === "mixed") {
            runtime.getCell<number>(
              space,
              "dependent-shared",
              undefined,
              dependent,
            )
              .set(5);
          }
          const dependentCommit = dependent.commit();
          expect(session.get()).toBe(3);
          const originLocalSeq = getCommitLocalSeq(dependent.tx, space);
          expect(originLocalSeq).toBeDefined();
          const guarded = runtime.edit();
          guarded.addCommitPrecondition!(space, {
            kind: "origin-committed",
            originLocalSeq: originLocalSeq!,
          });
          const guardedOutput = runtime.getCell<number>(space, "guarded-count");
          guardedOutput.withTx(guarded).set(4);
          const guardedCommit = guarded.commit();
          const valueGuarded = runtime.edit();
          valueGuarded.addCommitPrecondition!(space, {
            kind: "entity-value-hash",
            id: session.getAsNormalizedFullLink().id,
            scope: "session",
            valueHash: commitPreconditionValueHash(3),
          });
          const valueGuardedOutput = runtime.getCell<number>(
            space,
            "value-guarded-count",
          );
          valueGuardedOutput.withTx(valueGuarded).set(6);
          const valueGuardedCommit = valueGuarded.commit();
          release.resolve();

          expect((await mixedCommit.settled).error?.name).toBe(
            rejected ? "PreconditionFailedError" : undefined,
          );
          expect((await dependentCommit.settled).error?.name).toBe(
            rejected ? "ConflictError" : undefined,
          );
          expect((await guardedCommit.settled).error?.name).toBe(
            rejected ? "PreconditionFailedError" : undefined,
          );
          expect(session.get()).toBe(rejected ? 1 : 3);
          expect(shared.get()).toBe(rejected ? undefined : 3);
          expect(guardedOutput.get()).toBe(rejected ? undefined : 4);
          expect((await valueGuardedCommit.settled).error?.name).toBe(
            rejected ? "ConflictError" : undefined,
          );
          expect(valueGuardedOutput.get()).toBe(rejected ? undefined : 6);
        } finally {
          release.resolve();
          await runtime.dispose();
          await storage.close();
          await server.close();
        }
      });
    }
  }

  it("checks a committed session-only origin locally before writing shared state", async () => {
    const server = newSharedServer();
    const commits: ClientCommit[] = [];
    const transact = server.transact.bind(server);
    server.transact = (...args: Parameters<typeof transact>) => {
      commits.push(args[0].commit);
      return transact(...args);
    };
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: {
        localSessionDocuments: true,
        serverExecution: false,
        commitPreconditions: true,
      },
    });
    try {
      const session = runtime.getCell<number>(
        space,
        "origin",
        undefined,
        undefined,
        "session",
      );
      const shared = runtime.getCell<number>(space, "origin");
      const origin = runtime.edit();
      session.withTx(origin).set(1);
      expect((await origin.commit().settled).error).toBeUndefined();
      const originLocalSeq = getCommitLocalSeq(origin.tx, space);
      expect(originLocalSeq).toBeDefined();
      const guarded = runtime.edit();
      guarded.addCommitPrecondition!(space, {
        kind: "origin-committed",
        originLocalSeq: originLocalSeq!,
      });
      shared.withTx(guarded).set(2);
      expect((await guarded.commit().settled).error).toBeUndefined();
      expect(shared.get()).toBe(2);
      expect(commits).toHaveLength(1);
      expect(commits[0].preconditions ?? []).toEqual([]);
    } finally {
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });

  for (const rejected of [false, true]) {
    it(`keeps a blind session write visible when an older mixed commit ${rejected ? "rejects" : "succeeds"}`, async () => {
      const server = newSharedServer();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const transact = server.transact.bind(server);
      server.transact = async (...args: Parameters<typeof transact>) => {
        entered.resolve();
        await release.promise;
        return await transact(...args);
      };
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: {
          localSessionDocuments: true,
          serverExecution: false,
          commitPreconditions: true,
        },
      });
      try {
        const session = runtime.getCell<number>(
          space,
          "blind-count",
          undefined,
          undefined,
          "session",
        );
        const shared = runtime.getCell<number>(space, "blind-count");
        const mixed = runtime.edit();
        session.withTx(mixed).set(1);
        shared.withTx(mixed).set(10);
        if (rejected) {
          mixed.addCommitPrecondition!(space, {
            kind: "origin-committed",
            originLocalSeq: 999999,
          });
        }
        const mixedCommit = mixed.commit();
        await entered.promise;
        const blindCommit = storage.open(space).replica.commitNative!({
          operations: [{
            op: "set",
            id: session.getAsNormalizedFullLink().id,
            type: "application/json",
            scope: "session",
            value: { value: 2 },
          }],
        });
        expect(session.get()).toBe(2);
        release.resolve();
        expect((await mixedCommit.settled).error?.name).toBe(
          rejected ? "PreconditionFailedError" : undefined,
        );
        expect((await blindCommit).error).toBeUndefined();
        expect(session.get()).toBe(2);
        expect(shared.get()).toBe(rejected ? undefined : 10);
      } finally {
        release.resolve();
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }

  for (const localSessionDocuments of [undefined, false, true]) {
    for (const serverExecution of [false, true]) {
      it(
        localSessionDocuments === true
          ? `exports session documents only when server execution is enabled (${serverExecution})`
          : `synchronizes session documents with local storage ${localSessionDocuments} and server execution ${serverExecution}`,
        async () => {
          const server = newSharedServer();
          const commits: ClientCommit[] = [];
          const transact = server.transact.bind(server);
          server.transact = (...args: Parameters<typeof transact>) => {
            commits.push(args[0].commit);
            return transact(...args);
          };
          const storage = EmulatedStorageManager.connectTo(server, {
            as: signer,
          });
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: storage,
            experimental: { localSessionDocuments, serverExecution },
          });
          try {
            const session = runtime.getCell<number>(
              space,
              "count",
              undefined,
              undefined,
              "session",
            );
            const shared = runtime.getCell<number>(space, "count");
            const user = runtime.getCell<number>(
              space,
              "count",
              undefined,
              undefined,
              "user",
            );
            const tx = runtime.edit();
            session.withTx(tx).set(1);
            shared.withTx(tx).set(2);
            user.withTx(tx).set(3);
            expect((await tx.commit().settled).error).toBeUndefined();
            expect(session.get()).toBe(1);
            expect(shared.get()).toBe(2);
            expect(user.get()).toBe(3);

            const next = runtime.edit();
            shared.withTx(next).set(session.withTx(next).get() + 4);
            expect((await next.commit().settled).error).toBeUndefined();
            expect(shared.get()).toBe(5);
            await storage.synced();
            const scopes = commits.flatMap((commit) =>
              commit.operations.flatMap((op) =>
                "id" in op ? [op.scope ?? "space"] : []
              )
            );
            expect(scopes).toContain("space");
            expect(scopes).toContain("user");
            expect(scopes.includes("session")).toBe(
              localSessionDocuments !== true || serverExecution,
            );
            const reads = commits.flatMap((
              commit,
            ) => [...commit.reads.confirmed, ...commit.reads.pending]);
            expect(reads.some((read) => read.scope === "session")).toBe(
              localSessionDocuments !== true || serverExecution,
            );
          } finally {
            await runtime.dispose();
            await storage.close();
            await server.close();
          }
        },
      );
    }
  }
});
