/**
 * A query that runs again while the commit of its first run is still in
 * transit. Two sessions share one memory server: the query's runtime, whose
 * transport holds that commit until the case releases it, and a second
 * runtime that writes the document the query read, so the server refuses the
 * held commit as stale on its own terms.
 */

import { expect } from "@std/expect";

import { isFabricPlainObject } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { parseClientMessage } from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { defineIndexedCollections } from "../src/builtins/indexed-collection/definition.ts";
import { maintenanceRevisionCell } from "../src/builtins/indexed-collection/maintenance.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { SessionFactory } from "../src/storage/v2.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

type QueryState = {
  pending?: boolean;
  error?: unknown;
  result?: Array<Record<string, unknown>>;
};

/**
 * Opens sessions on `server` whose transport, once `holdNext()` has been
 * called, holds the next commit it is asked to send until `release()` sends
 * it, and records the error the server answers that commit with.
 */
class HeldCommitSessionFactory implements SessionFactory {
  readonly #server: MemoryV2Server.Server;
  #holding = false;
  #send: (() => void) | undefined;
  #requestId: string | undefined;
  readonly #held = Promise.withResolvers<void>();
  readonly #answered = Promise.withResolvers<{ name?: unknown } | undefined>();

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** Resolves once a commit is held. */
  get held(): Promise<void> {
    return this.#held.promise;
  }

  /** Resolves to the error the server answered the held commit with, if any. */
  get answered(): Promise<{ name?: unknown } | undefined> {
    return this.#answered.promise;
  }

  /** Holds the next commit sent. */
  holdNext(): void {
    this.#holding = true;
  }

  /** Sends the held commit. */
  release(): void {
    const send = this.#send;
    this.#send = undefined;
    send?.();
  }

  async create(id: string, signer?: Signer) {
    const base = MemoryV2Client.loopback(this.#server);
    const transport: MemoryV2Client.Transport = {
      send: (payload: string) => {
        const message = parseClientMessage(payload, {
          commitLabelTableV1: true,
        });
        if (this.#holding && message?.type === "transact") {
          this.#holding = false;
          this.#requestId = message.requestId;
          this.#send = () => void base.send(payload);
          this.#held.resolve();
          return Promise.resolve();
        }
        return base.send(payload);
      },
      close: () => base.close(),
      setReceiver: (receive) =>
        base.setReceiver((payload) => {
          const received = this.#requestId === undefined
            ? undefined
            : decodeMemoryBoundary(payload);
          if (
            isFabricPlainObject(received) && received.type === "response" &&
            received.requestId === this.#requestId
          ) {
            this.#answered.resolve(
              received.error as { name?: unknown } | undefined,
            );
          }
          receive(payload);
        }),
      setCloseReceiver: (receive) => base.setCloseReceiver?.(receive),
    };
    const client = await MemoryV2Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport,
    });
    const session = await client.mount(
      id as MemorySpace,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

describe("sqlite-query-overlapping-runs", () => {
  let space: MemorySpace;
  let server: MemoryV2Server.Server;
  let sessions: HeldCommitSessionFactory;
  let manager: TestStorageManager;
  let runtime: Runtime;
  let otherManager: EmulatedStorageManager;
  let other: Runtime;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      `sqlite-query-overlapping-runs-${crypto.randomUUID()}`,
    );
    space = signer.did();
    server = newSharedServer();
    sessions = new HeldCommitSessionFactory(server);
    manager = TestStorageManager.create(
      { as: signer, memoryHost: new URL("memory://") },
      sessions,
    );
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    otherManager = EmulatedStorageManager.connectTo(server, { as: signer });
    other = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherManager,
    });
  });

  afterEach(async () => {
    await other.dispose();
    await otherManager.close();
    await runtime.dispose();
    await manager.close();
    await server.close();
  });

  it("links its result into its output when a run that overlapped its refused first run sent nothing", async () => {
    // The query is over an indexed collection, so each run reads the
    // collection's maintenance revision, which the other runtime writes here
    // as toolshed's collection host does, and which is no part of the
    // request a run sends. The second run, which follows that write, asks
    // what the first asked and writes what the first wrote, and this runtime
    // sends none of it, since the first run's writes are what it holds. The
    // server then refuses the first run, which read the revision before the
    // other runtime wrote it.
    const { tables, index } = defineIndexedCollections({
      topics: { columns: { title: "text" } },
    });
    const db = { id: `overlapping-runs-${crypto.randomUUID()}`, tables, index };
    const seed = runtime.edit();
    seed.recordSqliteWrite!(space, {
      op: "sqlite",
      db: { id: db.id, tables },
      sql: "INSERT INTO collection_meta (key, value) VALUES (?, ?)",
      params: ["note", "hello"],
    });
    maintenanceRevisionCell(runtime, space, db.id, seed).set("first");
    expect((await seed.commit().settled).error).toBeUndefined();
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const p = cf.pattern(() =>
      cf.sqliteQuery({
        db,
        sql: "SELECT value FROM collection_meta",
        // deno-lint-ignore no-explicit-any
      } as any)
    );
    const setup = runtime.edit();
    const result = runtime.run(
      setup,
      p,
      {},
      runtime.getCell(space, "result", p.resultSchema, setup),
    ) as Cell<QueryState>;
    expect((await setup.commit().settled).error).toBeUndefined();

    sessions.holdNext();
    const cancel = result.sink(() => {});
    try {
      await sessions.held;
      await other.editWithRetry((tx) => {
        maintenanceRevisionCell(other, space, db.id, tx).set("second");
      });
      await waitForCellValue<string>(
        runtime,
        maintenanceRevisionCell(runtime, space, db.id),
        (revision) => revision === "second",
      );
      await runtime.idle();
      sessions.release();
      expect((await sessions.answered)?.name).toBe("ConflictError");
      await runtime.settled();
    } finally {
      cancel();
    }

    const state = result.get();
    expect(state?.pending).toBe(false);
    expect(state?.error).toBeUndefined();
    expect(state?.result?.map((row) => ({ ...row }))).toEqual([
      { value: "hello" },
    ]);
  });
});
