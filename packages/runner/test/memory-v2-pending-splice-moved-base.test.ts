// A pending tail splice over an array another session grew the same way.
//
// Two runtimes that run one piece both write its derived lists. When a list
// grows, each writes `splice {index: <old length>, add: [tail]}`. If the
// other session's identical write lands first and its frame arrives while
// this session's splice awaits its verdict, replaying the splice over the
// grown array would show the tail twice: a list no writer wrote, which the
// server never holds (it refuses the stale splice). The reader must see the
// list as it is throughout.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("pending splice moved base");
const space = signer.did();
const listSchema = { type: "array", items: { type: "string" } } as const;

type Session = { storage: EmulatedStorageManager; runtime: Runtime };

describe("a pending tail splice over an array another session grew", () => {
  let server: MemoryV2Server.Server;
  let verdicts: string[];
  let holdId: string | undefined;
  let held: PromiseWithResolvers<void>;
  let release: PromiseWithResolvers<void>;
  const sessions: Session[] = [];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    verdicts = [];
    holdId = undefined;
    held = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    // The server's own transact, with one chosen commit held at its entry
    // until the test releases it: the window a slow verdict leaves open.
    const transact = server.transact.bind(server);
    server.transact = async (...args: Parameters<typeof transact>) => {
      const [message] = args;
      const id = holdId;
      if (
        id !== undefined &&
        message.commit.operations.some((op) => "id" in op && op.id === id)
      ) {
        holdId = undefined;
        held.resolve();
        await release.promise;
      }
      const response = await transact(...args);
      verdicts.push(response.error ? response.error.name : "ok");
      return response;
    };
  });

  afterEach(async () => {
    release.resolve();
    await server.flushSessions([space]);
    await clock.settle();
    for (const session of sessions.splice(0)) {
      await session.runtime.dispose();
      await session.storage.close();
    }
    await server.close();
  });

  const connect = (): Session => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const session = { storage, runtime };
    sessions.push(session);
    return session;
  };

  const flush = async () => {
    await server.flushSessions([space]);
    await clock.settle();
  };

  const append = (session: Session, doc: string, item: string) => {
    const tx = session.runtime.edit();
    const cell = session.runtime.getCell(space, doc, listSchema, tx);
    cell.set([...(cell.get() as string[]), item]);
    return tx.commit({ holdSyncedUntilCovered: false }).verdict;
  };

  it("shows the list as it is while its splice awaits a refusal", async () => {
    const doc = "pending-splice-moved-base";
    const a = connect();
    const b = connect();
    await a.runtime.getCell(space, doc, listSchema).sync();
    const seed = a.runtime.edit();
    a.runtime.getCell(space, doc, listSchema, seed).set(["e1", "e2"]);
    expect((await seed.commit({ holdSyncedUntilCovered: false }).verdict).error)
      .toBeUndefined();
    const listB = b.runtime.getCell(space, doc, listSchema);
    await listB.sync();
    await flush();
    await b.storage.synced();
    expect(listB.get()).toEqual(["e1", "e2"]);

    const seen: unknown[] = [];
    const cancel = listB.sink((value) => {
      seen.push(JSON.parse(JSON.stringify(value ?? null)));
    });

    // B grows the list; its splice is held at the server.
    holdId = listB.getAsNormalizedFullLink().id;
    const bVerdict = append(b, doc, "e3");
    await held.promise;
    expect(listB.get()).toEqual(["e1", "e2", "e3"]);

    // A grows it the same way; that lands first, and its frame reaches B
    // while B's splice still awaits its verdict.
    expect((await append(a, doc, "e3")).error).toBeUndefined();
    await flush();
    expect(listB.get()).toEqual(["e1", "e2", "e3"]);

    release.resolve();
    expect((await bVerdict).error?.name).toBe("ConflictError");
    await flush();
    await b.runtime.idle();
    cancel();

    expect(listB.get()).toEqual(["e1", "e2", "e3"]);
    expect(seen.filter((value) => Array.isArray(value) && value.length > 3))
      .toEqual([]);
    // The server refused B's splice: the store never held the doubled tail.
    expect(verdicts).toEqual(["ok", "ok", "ConflictError"]);
  });
});
