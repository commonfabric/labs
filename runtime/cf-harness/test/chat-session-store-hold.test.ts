/**
 * A SQLite chat session store is held by the process that opens it for as
 * long as that handle stays open. A second process pointed at the same
 * database is refused at open rather than recovered over, so the turns the
 * first is still running are never marked interrupted from outside; a
 * database whose holder has exited is taken over and recovered exactly as an
 * unheld one is.
 */

import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Database } from "@db/sqlite";

import { createHarnessChatSessionStatus } from "../src/contracts/interactive-chat.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type { RunHarnessTranscriptOptions } from "../src/prompt-loop.ts";
import {
  HarnessChatStoreAliasedError,
  HarnessChatStoreHeldError,
  type HarnessChatStoreHolder,
} from "../src/session-store.ts";
import {
  openSqliteHarnessChatSessionStore,
  type SqliteHarnessChatSessionStore,
  sqliteHarnessChatSessionStoreHolderPath,
} from "../src/sqlite-session-store.ts";
import { makeResult, nextIsoNow } from "./support/session-store-fixtures.ts";

const completingPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
  runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
});

const noPromptLoop: HarnessInteractivePromptLoopFactory = () => {
  throw new Error("this service runs no model");
};

/**
 * A prompt loop that reports when a turn reaches it and completes the turn
 * only when the test says so, which is how a turn is held in `running` for
 * as long as a case needs without a timer.
 */
const suspendedPromptLoop = () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<string>();
  return {
    createPromptLoop: () => ({
      runTranscript: (options: RunHarnessTranscriptOptions) => {
        entered.resolve();
        return released.promise.then((text) => makeResult(options, text));
      },
    }),
    entered: entered.promise,
    release: (finalAssistantText: string) =>
      released.resolve(finalAssistantText),
  };
};

const withDatabaseUrl = async (
  run: (url: URL) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await run(toFileUrl(join(dir, "chat.sqlite")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const holder = (instanceId: string): HarnessChatStoreHolder => ({
  instanceId,
  pid: Deno.pid,
  heldSince: "2026-09-15T00:00:00.000Z",
});

const readHolderFile = async (url: URL): Promise<unknown> =>
  JSON.parse(
    await Deno.readTextFile(
      await sqliteHarnessChatSessionStoreHolderPath(url),
    ),
  );

/** The error an opening of `url` rejects with, or `undefined` if it opens. */
const refusalOf = (url: URL): Promise<unknown> =>
  openSqliteHarnessChatSessionStore({ url }).then(
    (store) => {
      store.close();
      return undefined;
    },
    (error: unknown) => error,
  );

/**
 * A connection of the test's own on the database, holding nothing and
 * writing nothing, for `PRAGMA data_version`: the reading moves once any
 * other connection commits.
 */
const observe = (
  url: URL,
): { dataVersion: () => number; close: () => void } => {
  const database = new Database(fromFileUrl(url), { readonly: true });
  return {
    dataVersion: () =>
      (database.prepare("PRAGMA data_version").get() as {
        data_version: number;
      }).data_version,
    close: () => database.close(),
  };
};

/** Records a session in the store with `turnId` still running in it. */
const saveRunningTurn = (
  store: SqliteHarnessChatSessionStore,
  sessionId: string,
  turnId: string,
): void => {
  const turn = {
    turnId,
    status: "running" as const,
    startedAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
  const session = {
    ...createHarnessChatSessionStatus({
      sessionId,
      createdAt: "2026-09-15T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
    }),
    status: "turn_running" as const,
    activeTurnId: turnId,
    activeTurn: turn,
  };
  store.saveSession({ session, transcript: [] });
  store.saveTurn({
    sessionId,
    turn,
    input: { text: "Still working" },
    policy: session.policy,
  });
};

/**
 * Leaves the database at `url` holding a running turn and held by no one,
 * as a process that exited without closing leaves it.
 */
const seedRunningTurn = async (url: URL): Promise<void> => {
  const store = await openSqliteHarnessChatSessionStore({ url });
  saveRunningTurn(store, "session-1", "turn-1");
  store.close();
};

/** Reads `stream` up to its first newline and returns that line. */
const readFirstLine = async (
  stream: ReadableStream<Uint8Array>,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.split("\n")[0];
};

/**
 * Starts a process that holds the database at `url` as `instanceId`, and
 * returns once it reports the hold; `kill()` ends it without a chance to
 * close anything.
 */
const spawnHolder = async (
  url: URL,
  instanceId: string,
): Promise<{ pid: number; kill: () => Promise<void> }> => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      fromFileUrl(
        new URL("./support/hold-chat-session-store.ts", import.meta.url),
      ),
      fromFileUrl(url),
      instanceId,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  expect(JSON.parse(await readFirstLine(child.stdout))).toEqual({
    held: true,
  });
  return {
    pid: child.pid,
    kill: async () => {
      child.kill("SIGKILL");
      const status = await child.status;
      expect(status.signal).toBe("SIGKILL");
      await child.stdin.close();
      await child.stdout.cancel();
    },
  };
};

describe("chat session store hold", () => {
  describe("openSqliteHarnessChatSessionStore()", () => {
    it("holds an unheld database and writes the holder beside it", async () => {
      await withDatabaseUrl(async (url) => {
        const store = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-1"),
        });
        try {
          expect(await readHolderFile(url)).toEqual(holder("instance-1"));
        } finally {
          store.close();
        }
      });
    });

    it("names this process in the holder it writes when given none", async () => {
      await withDatabaseUrl(async (url) => {
        const store = await openSqliteHarnessChatSessionStore({ url });
        try {
          expect(await readHolderFile(url)).toEqual({
            instanceId: expect.any(String),
            pid: Deno.pid,
            heldSince: expect.any(String),
          });
        } finally {
          store.close();
        }
      });
    });

    it("refuses a database another handle holds, naming the holder, without touching it", async () => {
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-1"),
        });
        const observer = observe(url);
        try {
          saveRunningTurn(first, "session-1", "turn-1");
          const before = observer.dataVersion();

          const refusal = await refusalOf(url);

          expect(refusal).toBeInstanceOf(HarnessChatStoreHeldError);
          expect((refusal as HarnessChatStoreHeldError).holder).toEqual(
            holder("instance-1"),
          );
          expect((refusal as HarnessChatStoreHeldError).store).toBe(
            await Deno.realPath(fromFileUrl(url)),
          );
          expect((refusal as HarnessChatStoreHeldError).message).toBe(
            `cf-harness chat session store ${await Deno.realPath(
              fromFileUrl(url),
            )} is held by another live process: instance instance-1, pid ${Deno.pid}, since 2026-09-15T00:00:00.000Z`,
          );
          expect(observer.dataVersion()).toBe(before);
          expect(first.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "running",
          );
          expect(await readHolderFile(url)).toEqual(holder("instance-1"));

          // The holder's own writes go on, and a commit is what the reading
          // above would have shown.
          first.saveSession({
            session: createHarnessChatSessionStatus({
              sessionId: "session-2",
              createdAt: "2026-09-15T00:00:00.000Z",
              workspace: { hostPath: "/workspace" },
            }),
            transcript: [],
          });
          expect(observer.dataVersion()).not.toBe(before);
        } finally {
          observer.close();
          first.close();
        }
      });
    });

    it("refuses a database held under another spelling of its path", async () => {
      // The link is on the database file itself, so a hold file placed beside
      // each spelling would be two different files.
      const dir = await Deno.makeTempDir();
      try {
        const first = await openSqliteHarnessChatSessionStore({
          url: toFileUrl(join(dir, "real.sqlite")),
          holder: holder("instance-1"),
        });
        try {
          await Deno.symlink(
            join(dir, "real.sqlite"),
            join(dir, "alias.sqlite"),
          );
          const refusal = await refusalOf(toFileUrl(join(dir, "alias.sqlite")));
          expect(refusal).toBeInstanceOf(HarnessChatStoreHeldError);
          expect((refusal as HarnessChatStoreHeldError).holder).toEqual(
            holder("instance-1"),
          );
          expect((refusal as HarnessChatStoreHeldError).store).toBe(
            await Deno.realPath(join(dir, "real.sqlite")),
          );
        } finally {
          first.close();
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("refuses a database with more than one name, under every name", async () => {
      // A hard link shares the file but not the name the hold file is placed
      // beside, so neither name is admitted while the link stands.
      const dir = await Deno.makeTempDir();
      try {
        const first = await openSqliteHarnessChatSessionStore({
          url: toFileUrl(join(dir, "real.sqlite")),
          holder: holder("instance-1"),
        });
        try {
          await Deno.link(join(dir, "real.sqlite"), join(dir, "alias.sqlite"));
          for (const name of ["alias.sqlite", "real.sqlite"]) {
            const refusal = await refusalOf(toFileUrl(join(dir, name)));
            expect(refusal).toBeInstanceOf(HarnessChatStoreAliasedError);
            expect((refusal as HarnessChatStoreAliasedError).names).toBe(2);
            expect((refusal as HarnessChatStoreAliasedError).store).toBe(
              await Deno.realPath(join(dir, name)),
            );
          }
          saveRunningTurn(first, "session-1", "turn-1");
          expect(first.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "running",
          );
        } finally {
          first.close();
        }
        await Deno.remove(join(dir, "alias.sqlite"));
        const again = await openSqliteHarnessChatSessionStore({
          url: toFileUrl(join(dir, "real.sqlite")),
        });
        again.close();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("refuses a database with more than one name to another process while the holder is alive", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const first = await openSqliteHarnessChatSessionStore({
          url: toFileUrl(join(dir, "real.sqlite")),
          holder: holder("instance-1"),
        });
        try {
          await Deno.link(join(dir, "real.sqlite"), join(dir, "alias.sqlite"));
          const child = await new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              "-A",
              fromFileUrl(
                new URL(
                  "./support/hold-chat-session-store.ts",
                  import.meta.url,
                ),
              ),
              join(dir, "alias.sqlite"),
              "instance-2",
            ],
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
          }).output();
          expect(child.code).toBe(1);
          expect(new TextDecoder().decode(child.stdout)).toBe("");
          expect(new TextDecoder().decode(child.stderr)).toContain(
            "HarnessChatStoreAliasedError",
          );
          expect(await readHolderFile(toFileUrl(join(dir, "real.sqlite"))))
            .toEqual(holder("instance-1"));
          saveRunningTurn(first, "session-1", "turn-1");
          expect(first.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "running",
          );
        } finally {
          first.close();
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("refuses without naming a holder where the record beside a held database is not one", async () => {
      // A record cut off mid-write is not JSON; one that parses is still not
      // a holder unless it has a holder's shape.
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-1"),
        });
        try {
          for (const record of ["{", "42"]) {
            await Deno.writeTextFile(
              await sqliteHarnessChatSessionStoreHolderPath(url),
              record,
            );
            const refusal = await refusalOf(url);
            expect(refusal).toBeInstanceOf(HarnessChatStoreHeldError);
            expect((refusal as HarnessChatStoreHeldError).holder)
              .toBeUndefined();
            expect((refusal as HarnessChatStoreHeldError).message).toBe(
              `cf-harness chat session store ${await Deno.realPath(
                fromFileUrl(url),
              )} is held by another live process`,
            );
          }
        } finally {
          first.close();
        }
      });
    });

    it("holds a database once the handle holding it has closed, and writes to it", async () => {
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-1"),
        });
        first.close();
        const second = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-2"),
        });
        try {
          expect(await readHolderFile(url)).toEqual(holder("instance-2"));
          saveRunningTurn(second, "session-1", "turn-1");
          expect(second.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "running",
          );
        } finally {
          second.close();
        }
      });
    });

    it("keeps the hold until the database connection has closed", async () => {
      // The probe runs inside the connection's own `close()`, where a hold
      // released ahead of it would already be free to take.
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-1"),
        });
        const holderPath = await sqliteHarnessChatSessionStoreHolderPath(url);
        const database = first.database;
        const closeDatabase = database.close.bind(database);
        let heldWhileClosing: boolean | undefined;
        database.close = () => {
          const probe = Deno.openSync(holderPath, { read: true, write: true });
          try {
            heldWhileClosing = !probe.tryLockSync(true);
          } finally {
            probe.close();
          }
          closeDatabase();
        };

        first.close();

        expect(heldWhileClosing).toBe(true);
        const second = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-2"),
        });
        second.close();
      });
    });

    it("releases a database it held but could not open", async () => {
      await withDatabaseUrl(async (url) => {
        await Deno.writeTextFile(fromFileUrl(url), "not a database");
        await expect(openSqliteHarnessChatSessionStore({ url })).rejects
          .toThrow("not a database");
        const file = await Deno.open(
          await sqliteHarnessChatSessionStoreHolderPath(url),
          { read: true, write: true },
        );
        try {
          expect(await file.tryLock(true)).toBe(true);
        } finally {
          file.close();
        }
      });
    });

    it("leaves the turn a live service is running as `running`", async () => {
      await withDatabaseUrl(async (url) => {
        const first = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-live"),
        });
        const loop = suspendedPromptLoop();
        const live = new HarnessInteractiveChatService({
          createPromptLoop: loop.createPromptLoop,
          now: nextIsoNow(),
          sessionStore: first,
        });
        try {
          await live.initializeFromStore();
          const session = await live.startSession("req-session", {
            sessionId: "session-1",
            workspace: { hostPath: "/workspace" },
          });
          expect(session.ok).toBe(true);
          const turn = await live.startTurn("req-turn", {
            sessionId: "session-1",
            turnId: "turn-1",
            input: { text: "Keep working" },
          });
          expect(turn.ok).toBe(true);
          await loop.entered;
          expect(first.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "running",
          );

          expect(await refusalOf(url)).toBeInstanceOf(
            HarnessChatStoreHeldError,
          );

          expect(first.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "running",
          );
          loop.release("Done.");
          await live.waitForTurn("session-1", "turn-1");
          expect(first.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "completed",
          );
        } finally {
          first.close();
        }
      });
    });
  });

  describe("HarnessInteractiveChatService.initializeFromStore()", () => {
    it("takes over a database whose holder has died and settles the turn it left running", async () => {
      await withDatabaseUrl(async (url) => {
        await seedRunningTurn(url);
        const died = await spawnHolder(url, "instance-died");
        expect(await readHolderFile(url)).toEqual({
          instanceId: "instance-died",
          pid: died.pid,
          heldSince: expect.any(String),
        });
        await died.kill();

        const store = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-next"),
        });
        try {
          const service = new HarnessInteractiveChatService({
            createPromptLoop: noPromptLoop,
            now: nextIsoNow(),
            sessionStore: store,
          });
          await service.initializeFromStore();

          const turn = store.getTurn("session-1", "turn-1");
          expect(turn?.turn.status).toBe("failed");
          expect(turn?.turn.error?.details).toEqual({
            terminalReason: "process_interrupted",
            priorStatus: "running",
          });
          expect(await readHolderFile(url)).toEqual(holder("instance-next"));
        } finally {
          store.close();
        }
      });
    });

    it("settles the running turn of a database no process ever held", async () => {
      await withDatabaseUrl(async (url) => {
        await seedRunningTurn(url);
        await Deno.remove(await sqliteHarnessChatSessionStoreHolderPath(url));

        const store = await openSqliteHarnessChatSessionStore({
          url,
          holder: holder("instance-next"),
        });
        try {
          const service = new HarnessInteractiveChatService({
            createPromptLoop: noPromptLoop,
            now: nextIsoNow(),
            sessionStore: store,
          });
          await service.initializeFromStore();

          const turn = store.getTurn("session-1", "turn-1");
          expect(turn?.turn.status).toBe("failed");
          expect(turn?.turn.error?.details).toEqual({
            terminalReason: "process_interrupted",
            priorStatus: "running",
          });
          expect(service.status("session-1").sessions[0].activeTurnId)
            .toBeUndefined();
          expect(
            service.listEvents({ sessionId: "session-1" }).events.map((
              event,
            ) => event.event.kind),
          ).toEqual(["turn_failed"]);
          expect(await readHolderFile(url)).toEqual(holder("instance-next"));
        } finally {
          store.close();
        }
      });
    });

    it("runs its own turns after taking a database, and keeps it across its own reinitialization", async () => {
      await withDatabaseUrl(async (url) => {
        await seedRunningTurn(url);
        const store = await openSqliteHarnessChatSessionStore({ url });
        try {
          const service = new HarnessInteractiveChatService({
            createPromptLoop: completingPromptLoop,
            now: nextIsoNow(),
            sessionStore: store,
          });
          await service.initializeFromStore();

          const session = await service.startSession("req-session", {
            sessionId: "session-2",
            workspace: { hostPath: "/workspace" },
          });
          expect(session.ok).toBe(true);
          const turn = await service.startTurn("req-turn", {
            sessionId: "session-2",
            turnId: "turn-2",
            input: { text: "Carry on" },
          });
          expect(turn.ok).toBe(true);
          await service.waitForTurn("session-2", "turn-2");
          expect(store.getTurn("session-2", "turn-2")?.turn.status).toBe(
            "completed",
          );

          await service.initializeFromStore();

          expect(store.getTurn("session-2", "turn-2")?.turn.status).toBe(
            "completed",
          );
          expect(store.getTurn("session-1", "turn-1")?.turn.status).toBe(
            "failed",
          );
        } finally {
          store.close();
        }
      });
    });
  });
});
