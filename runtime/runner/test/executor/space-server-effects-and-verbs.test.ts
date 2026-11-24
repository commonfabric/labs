import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import {
  effectIntentNonce,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
  streamEntriesDocId,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";

import {
  LIFECYCLE_VERB_SPACE_PARKED,
  lifecycleVerbNotDurable,
  SpaceServer,
  type SpaceServerOptions,
} from "../../src/executor/space-server.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../../src/executor/stats.ts";
import {
  stampWaveRunContext,
  type WaveCommitSink,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("effects and verbs space");
const serviceSigner = await Identity.fromPassphrase(
  "effects and verbs service",
);
const aliceSigner = await Identity.fromPassphrase("effects and verbs alice");
const targetSigner = await Identity.fromPassphrase("effects and verbs target");
const space = spaceSigner.did() as MemorySpace;
const targetSpace = targetSigner.did() as MemorySpace;

const spaceServerLog = getLogger("space-server");

/** The number of `warn` calls the space-server logger made under `key`. */
const warnings = (key: string): number =>
  spaceServerLog.countsByKey[key]?.warn ?? 0;

/** A serving-loop callback, and promises of its next calls. */
class Edges {
  #waiters: Array<{ holds: () => boolean; resolve: () => void }> = [];

  /** The callback to hand the server. */
  readonly fire = (): void => {
    this.#waiters = this.#waiters.filter((waiter) => {
      if (!waiter.holds()) return true;
      waiter.resolve();
      return false;
    });
  };

  /** Resolves on the first call from now that finds `holds` true. */
  next(holds: () => boolean = () => true): Promise<void> {
    const fired = Promise.withResolvers<void>();
    this.#waiters.push({ holds, resolve: fired.resolve });
    return fired.promise;
  }
}

/** A space served by a `SpaceServer` over one shared memory server. */
type Served = {
  server: ReturnType<typeof newSharedServer>;
  engine: Engine.Engine;
  manager: EmulatedStorageManager;
  serving: SpaceServer;
  stats: ServingLoopStats;

  /** The ends of the loop's wave cycles. */
  cycles: Edges;

  /** The loop's suspensions on its input wait. */
  rests: Edges;

  /** The reason of the tenure's park, once it has parked. */
  parked: Promise<string>;
  close: () => Promise<void>;
};

/**
 * Builds a `SpaceServer` for `space` with the space-root ensure off, so
 * nothing but what a case puts there reaches a cycle's wave.
 */
async function serve(
  options: Pick<SpaceServerOptions, "decorateWaveCommitSink"> & {
    server?: ReturnType<typeof newSharedServer>;
    facade?: (
      server: ReturnType<typeof newSharedServer>,
    ) => SpaceServerOptions["server"];
  } = {},
): Promise<Served> {
  const server = options.server ??
    newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const engine = await server.engineForSpace(space);
  const manager = EmulatedStorageManager.connectTo(server, {
    as: serviceSigner,
  });
  const stats = emptyServingLoopStats();
  const cycles = new Edges();
  const rests = new Edges();
  const parked = Promise.withResolvers<string>();
  const serving = new SpaceServer({
    space,
    engine,
    server: options.facade?.(server) ?? server,
    serviceIdentity: serviceSigner.did(),
    createRuntime: () => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      return Promise.resolve({ runtime, dispose: () => runtime.dispose() });
    },
    localSeqRef: { value: 0 },
    stats,
    ensureSpaceRoots: false,
    policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    onWaveCycle: cycles.fire,
    onLoopRest: rests.fire,
    onParked: parked.resolve,
    ...(options.decorateWaveCommitSink === undefined
      ? {}
      : { decorateWaveCommitSink: options.decorateWaveCommitSink }),
  });
  return {
    server,
    engine,
    manager,
    serving,
    stats,
    cycles,
    rests,
    parked: parked.promise,
    close: async () => {
      try {
        await serving.park("test-teardown");
        await manager.close();
      } finally {
        await server.close();
      }
    },
  };
}

/** `work`, or a rejection naming the park when the space parks first. */
const beforePark = <T>(served: Served, work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    served.parked.then((reason): never => {
      throw new Error(`the space parked first (${reason})`);
    }),
  ]);

/** What `promise` settled with so far: `pending`, its value, or its error's message. */
function settlement(promise: Promise<unknown>): { readonly now: unknown } {
  const tracked: { now: unknown } = { now: "pending" };
  promise.then(
    (value) => tracked.now = value,
    (error: Error) => tracked.now = error.message,
  );
  return tracked;
}

/**
 * A sink over `sink` whose next `commitWave` after `arm()` throws `error`.
 */
function throwingSink(
  sink: WaveCommitSink,
  error: Error,
): { sink: WaveCommitSink; arm: () => void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    sink: new Proxy(sink, {
      get(target, property) {
        if (property === "commitWave" && armed) {
          return () => {
            armed = false;
            return Promise.reject(error);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

/**
 * A verb that writes its name to a space document of that name, then runs
 * `afterSeal` with the serving runtime.
 */
const markerVerb = (
  name: string,
  afterSeal: (runtime: Runtime) => unknown = () => {},
) => ({
  name,
  run: async (runtime: Runtime) => {
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: `test-verb/${name}`,
      kind: "bookkeeping",
    });
    runtime.getCell<string>(space, name, undefined).withTx(tx).set(name);
    expect((await tx.commit().settled).error).toBeUndefined();
    await afterSeal(runtime);
    return name;
  },
});

/** A runtime of alice's over `server`, as a client of the served space. */
function clientRuntime(
  server: ReturnType<typeof newSharedServer>,
): { runtime: Runtime; close: () => Promise<void> } {
  const manager = EmulatedStorageManager.connectTo(server, { as: aliceSigner });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
    experimental: { serverExecution: true },
  });
  return {
    runtime,
    close: async () => {
      await runtime.dispose();
      await manager.close();
    },
  };
}

/** The stored value of the space document `cause` names, or `undefined`. */
const storedMarker = (
  served: Served,
  runtime: Runtime,
  cause: string,
): unknown =>
  Engine.read(served.engine, {
    id: runtime.getCell<string>(space, cause, undefined)
      .getAsNormalizedFullLink().id,
  })?.value;

/**
 * Writes, as alice, an instance of the effects document holding one entry
 * and its ack mark — what the retirement scan finds retirable.
 */
async function seedAckedEffect(
  server: ReturnType<typeof newSharedServer>,
): Promise<void> {
  const { runtime, close } = clientRuntime(server);
  try {
    const nonce = effectIntentNonce("evt-acked", "of:acked-target");
    const tx = runtime.edit();
    runtime.getCellFromLink<SessionEffectsDocValue>({
      space,
      id: SERVER_EXECUTION_EFFECTS_DOC_ID,
      scope: "session",
      path: [],
    }).withTx(tx).set({
      entries: [{
        nonce,
        kind: "navigate",
        args: { target: { id: "of:acked-target", path: [] } },
        issuedIn: null,
      }],
      acks: { [nonce]: true },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
  } finally {
    await close();
  }
}

/** How many effects instances in `engine` hold acked entries to retire. */
const retirable = (engine: Engine.Engine): number =>
  Engine.selectRetirableEffectsInstances(engine).length;

/**
 * Makes the serving runtime's next transaction that writes the effects
 * document fail as `fault` says: its write throws, its seal is refused, or
 * its seal throws. Resolves once the fault has fired.
 */
function failNextRetirement(
  manager: EmulatedStorageManager,
  fault: "write" | "seal-refused" | "seal-thrown",
): Promise<void> {
  const fired = Promise.withResolvers<void>();
  let armed = true;
  const edit = manager.edit.bind(manager);
  manager.edit = () => {
    const tx = edit();
    if (!armed) return tx;
    let writesEffects = false;
    const write = tx.write.bind(tx);
    tx.write = (address, value) => {
      if (armed && address.id === SERVER_EXECUTION_EFFECTS_DOC_ID) {
        writesEffects = true;
        if (fault === "write") {
          armed = false;
          fired.resolve();
          throw new Error("the store refused the retirement write");
        }
      }
      return write(address, value);
    };
    const sealInto = tx.sealInto!.bind(tx);
    tx.sealInto = (sink) => {
      if (!armed || !writesEffects) return sealInto(sink);
      armed = false;
      fired.resolve();
      if (fault === "seal-thrown") {
        return Promise.reject(new Error("the seal threw"));
      }
      return Promise.resolve({
        error: {
          name: "StorageTransactionAborted",
          message: "the seal refused the retirement",
          reason: new Error("seal refused"),
        },
      });
    };
    return tx;
  };
  return fired.promise;
}

/**
 * Makes the first `times` statements `engine` prepares whose text matches
 * `sql` throw. Resolves once the last of them has thrown.
 */
function failStatements(
  engine: Engine.Engine,
  sql: RegExp,
  times: number,
): { failed: Promise<void>; [Symbol.dispose]: () => void } {
  const failed = Promise.withResolvers<void>();
  let remaining = times;
  const prepare = engine.database.prepare.bind(engine.database);
  const prepareStub = stub(engine.database, "prepare", (text: string) => {
    if (remaining > 0 && sql.test(text)) {
      remaining -= 1;
      if (remaining === 0) failed.resolve();
      throw new Error("the store failed the statement");
    }
    return prepare(text);
  });
  return {
    failed: failed.promise,
    [Symbol.dispose]: () => prepareStub.restore(),
  };
}

describe("SpaceServer", () => {
  describe("lifecycleVerbNotDurable()", () => {
    const committed = { kind: "committed" } as const;

    it("returns `undefined` for a verb that sealed nothing, whatever was served", () => {
      expect(lifecycleVerbNotDurable([], undefined)).toBeUndefined();
      expect(
        lifecycleVerbNotDurable([], {
          wave: "served",
          outcome: { aborted: "lease-lost", dispositions: [] },
        }),
      ).toBeUndefined();
    });

    it("returns `undefined` when every contribution committed in the served wave", () => {
      expect(
        lifecycleVerbNotDurable(
          [{ wave: "served", index: 0 }, { wave: "served", index: 2 }],
          {
            wave: "served",
            outcome: {
              dispositions: [committed, { kind: "dropped" }, committed],
            },
          },
        ),
      ).toBeUndefined();
    });

    it("names an unserved wave when no wave or another wave was served", () => {
      const contributions = [{ wave: "carrying", index: 0 }];
      expect(lifecycleVerbNotDurable(contributions, undefined)).toBe(
        "the wave carrying its writes was not committed",
      );
      expect(
        lifecycleVerbNotDurable(contributions, {
          wave: "other",
          outcome: { dispositions: [committed] },
        }),
      ).toBe("the wave carrying its writes was not committed");
    });

    it("names the abort when the served wave aborted", () => {
      expect(
        lifecycleVerbNotDurable([{ wave: "served", index: 0 }], {
          wave: "served",
          outcome: { aborted: "space-deleted", dispositions: [committed] },
        }),
      ).toBe("the wave carrying its writes aborted (space-deleted)");
    });

    it("names the disposition of the first contribution that did not commit", () => {
      expect(
        lifecycleVerbNotDurable(
          [{ wave: "served", index: 0 }, { wave: "served", index: 1 }],
          {
            wave: "served",
            outcome: {
              dispositions: [committed, {
                kind: "partially-dropped",
                droppedOps: 1,
              }],
            },
          },
        ),
      ).toBe("a contribution of its was partially-dropped at the wave commit");
    });

    it("throws when the served wave's outcome has no disposition for a contribution", () => {
      expect(() =>
        lifecycleVerbNotDurable(
          [{ wave: "served", index: 0 }, { wave: "served", index: 1 }],
          { wave: "served", outcome: { dispositions: [committed] } },
        )
      ).toThrow("the wave commit gave no disposition for contribution 1");
    });
  });

  describe("instance members", () => {
    describe("runLifecycleVerb()", () => {
      it("rejects the verbs a park leaves unrun, batched and queued alike, after the verb that parked ran", async () => {
        const served = await serve();
        try {
          expect(await served.serving.activate()).toBe(true);
          const ran: string[] = [];
          let parking: Promise<void> | undefined;
          let queuedMeanwhile: { readonly now: unknown } | undefined;
          const parks = settlement(served.serving.runLifecycleVerb({
            name: "park",
            run: () => {
              ran.push("park");
              // Queued while the batch runs, so it waits for the next cycle.
              queuedMeanwhile = settlement(served.serving.runLifecycleVerb(
                markerVerb("queued-meanwhile", () => ran.push("queued")),
              ));
              parking = served.serving.park("parked-by-verb");
              return Promise.resolve("parked");
            },
          }));
          const batched = settlement(served.serving.runLifecycleVerb(
            markerVerb("batched", () => ran.push("batched")),
          ));
          await served.cycles.next(() => ran.length > 0);
          await parking;
          expect(await served.parked).toBe("parked-by-verb");
          expect(ran).toEqual(["park"]);
          expect(parks.now).toBe("parked");
          expect(batched.now).toBe(LIFECYCLE_VERB_SPACE_PARKED);
          expect(queuedMeanwhile?.now).toBe(LIFECYCLE_VERB_SPACE_PARKED);
        } finally {
          await served.close();
        }
      });

      it("rejects a verb with the error of a wave commit that threw, and parks the space", async () => {
        let throwing: ReturnType<typeof throwingSink> | undefined;
        const served = await serve({
          decorateWaveCommitSink: (sink) => {
            throwing = throwingSink(sink, new Error("the sink lost the store"));
            return throwing.sink;
          },
        });
        const alice = clientRuntime(served.server);
        try {
          expect(await served.serving.activate()).toBe(true);
          const verb = settlement(served.serving.runLifecycleVerb(
            markerVerb("unlanded", () => throwing!.arm()),
          ));
          expect(await served.parked).toBe("loop-failed");
          expect(verb.now).toBe("the sink lost the store");
          expect(served.serving.active).toBe(false);
          expect(storedMarker(served, alice.runtime, "unlanded"))
            .toBeUndefined();
        } finally {
          await alice.close();
          await served.close();
        }
      });

      it("rejects a verb whose write a concurrent write dropped at the wave commit, and keeps serving", async () => {
        const served = await serve();
        const alice = clientRuntime(served.server);
        try {
          expect(await served.serving.activate()).toBe(true);
          // A client writes the verb's document after the verb sealed its
          // write and before the wave commits, so the commit drops it.
          await expect(served.serving.runLifecycleVerb(
            markerVerb("contested", async () => {
              const written = await alice.runtime.editWithRetry((tx) => {
                alice.runtime.getCell<string>(space, "contested", undefined)
                  .withTx(tx).set("client");
              });
              expect(written.error).toBeUndefined();
            }),
          )).rejects.toThrow(
            "a contribution of its was dropped at the wave commit",
          );
          expect(served.stats.lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
          expect(storedMarker(served, alice.runtime, "contested")).toBe(
            "client",
          );

          // The tenure survives: the next verb's write lands.
          expect(
            await served.serving.runLifecycleVerb(markerVerb("landed")),
          ).toBe("landed");
          expect(served.serving.active).toBe(true);
          expect(storedMarker(served, alice.runtime, "landed")).toBe("landed");
        } finally {
          await alice.close();
          await served.close();
        }
      });

      it("announces as warm only the space-scoped documents a verb wrote", async () => {
        const announced: Array<ReadonlyArray<{ id: string }>> = [];
        const served = await serve({
          facade: (server) =>
            new Proxy(server, {
              get(target, property) {
                const value = Reflect.get(target, property);
                if (property === "noteExecutorCommit") {
                  return (
                    notice: Parameters<typeof target.noteExecutorCommit>[0],
                  ) => {
                    if (notice.warm === true) announced.push(notice.writes);
                    return target.noteExecutorCommit(notice);
                  };
                }
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
        });
        try {
          expect(await served.serving.activate()).toBe(true);
          const sessionNote = "of:verb-session-note";
          const ids = await served.serving.runLifecycleVerb({
            name: "mixed-scopes",
            run: async (runtime) => {
              const scoped = runtime.edit();
              stampWaveRunContext(scoped, {
                actionId: "test-verb/session-note",
                kind: "bookkeeping",
                scopeKeyIdentity: {
                  principal: aliceSigner.did(),
                  sessionId: "verb-session",
                },
              });
              runtime.getCellFromLink<string>({
                space,
                id: sessionNote,
                scope: "session",
                path: [],
              }).withTx(scoped).set("session");
              expect((await scoped.commit().settled).error).toBeUndefined();
              const spaceNote = runtime.getCell<string>(
                space,
                "verb-space-note",
                undefined,
              );
              const plain = runtime.edit();
              stampWaveRunContext(plain, {
                actionId: "test-verb/space-note",
                kind: "bookkeeping",
              });
              spaceNote.withTx(plain).set("space");
              expect((await plain.commit().settled).error).toBeUndefined();
              return { spaceNote: spaceNote.getAsNormalizedFullLink().id };
            },
            demandRoots: ({ spaceNote }) => [spaceNote],
          });
          expect(announced.length).toBe(1);
          const writes = announced[0].map(({ id }) => id);
          expect(writes).toContain(ids.spaceNote);
          expect(writes).not.toContain(sessionNote);
          // The session-scoped write committed with the verb's wave; it is
          // the scope that keeps it out of the announcement.
          const [scopeKey] = (served.engine.database.prepare(
            `SELECT scope_key FROM head WHERE id = :id`,
          ).all({ id: sessionNote }) as Array<{ scope_key: string }>)
            .map((row) => row.scope_key);
          expect(scopeKey).toMatch(/^session:/);
        } finally {
          await served.close();
        }
      });
    });

    describe("activate()", () => {
      it("keeps the acked-effect retirement owed when the scan fails, and retires the entry on a later cycle", async () => {
        const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
        await seedAckedEffect(server);
        const served = await serve({ server });
        try {
          using fault = failStatements(
            served.engine,
            /FROM head\s+WHERE branch = :branch AND id = :id AND op != 'delete'/,
            1,
          );
          const before = warnings("effects-scan-failed");
          const firstCycle = served.cycles.next();
          const rest = served.rests.next();
          expect(await served.serving.activate()).toBe(true);
          await fault.failed;
          await firstCycle;
          expect(warnings("effects-scan-failed")).toBe(before + 1);
          expect(retirable(served.engine)).toBe(1);
          // The owed retirement keeps the loop from resting until it lands.
          await beforePark(served, rest);
          expect(retirable(served.engine)).toBe(0);
          expect(warnings("effects-scan-failed")).toBe(before + 1);
        } finally {
          await served.close();
        }
      });

      for (
        const [fault, failure, key] of [
          ["write", "write throws", "effects-retirement-failed"],
          ["seal-refused", "seal is refused", "effects-retirement-seal-failed"],
          ["seal-thrown", "seal throws", "effects-retirement-seal-failed"],
        ] as const
      ) {
        it(`retires an acked entry on a later cycle when the first retirement's ${failure}`, async () => {
          const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
          await seedAckedEffect(server);
          const served = await serve({ server });
          try {
            const [instance] = Engine.selectRetirableEffectsInstances(
              served.engine,
            );
            const failed = failNextRetirement(served.manager, fault);
            const before = warnings(key);
            const firstCycle = served.cycles.next();
            const rest = served.rests.next();
            expect(await served.serving.activate()).toBe(true);
            await failed;
            await firstCycle;
            expect(warnings(key)).toBe(before + 1);
            expect(retirable(served.engine)).toBe(1);
            // The owed retirement keeps the loop from resting until it lands.
            await beforePark(served, rest);
            expect(retirable(served.engine)).toBe(0);
            expect(warnings(key)).toBe(before + 1);
            expect(
              Engine.readState(served.engine, {
                id: SERVER_EXECUTION_EFFECTS_DOC_ID,
                scopeKey: instance.scopeKey,
              })?.document?.value,
            ).toEqual({ entries: [], acks: {} });
          } finally {
            await served.close();
          }
        });
      }

      it("keeps an outbound append whose drain failed, and delivers it on a later cycle", async () => {
        const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
        const engine = await server.engineForSpace(space);
        const stream = { id: "of:drain-retry-stream", path: ["events"] };
        const sidecar = streamEntriesDocId(stream);
        insertExecutionOutboxRows(engine, {
          branch: "",
          createdSeq: 1,
          rows: [{
            targetSpace,
            targetStream: sidecar,
            targetStreamLink: stream,
            eventId: "evt-drain-retry",
            payload: { n: 1 },
            sessionlessSpaceScope: true,
            capabilityRef: "cap-drain-retry",
          }],
        });
        const pending = () =>
          selectPendingExecutionOutboxRows(engine, { branch: "" }).length;
        const delivered = async () =>
          ((Engine.read(await server.engineForSpace(targetSpace), {
            id: sidecar,
          })?.value as { entries?: unknown[] } | undefined)?.entries ?? [])
            .length;
        const served = await serve({ server });
        try {
          // The activation's re-send fails first, which owes the first
          // cycle a drain; that drain fails too.
          using fault = failStatements(
            engine,
            /SELECT[\s\S]*FROM execution_outbox/,
            2,
          );
          const before = warnings("append-drain-failed");
          const firstCycle = served.cycles.next();
          const firstRest = served.rests.next();
          expect(await served.serving.activate()).toBe(true);
          await fault.failed;
          await firstCycle;
          expect(warnings("append-drain-failed")).toBe(before + 1);
          expect(pending()).toBe(1);
          expect(await delivered()).toBe(0);

          // Any later cycle drains the row the failed drain kept.
          await beforePark(served, firstRest);
          const rest = served.rests.next();
          served.serving.noteDemandChanged();
          await beforePark(served, rest);
          expect(pending()).toBe(0);
          expect(await delivered()).toBe(1);
          expect(warnings("append-drain-failed")).toBe(before + 1);
        } finally {
          await served.close();
        }
      });
    });
  });
});
