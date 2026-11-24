import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import {
  newRunBeaconBuffer,
  readRunBeacon,
  RunBeacon,
  type RunBeaconReading,
  type RunIdentity,
} from "../../src/executor/run-beacon.ts";
import { recordDocumentRead, recordProxyAccess } from "../../src/read-stats.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Action } from "../../src/scheduler/types.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../../src/storage/interface.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("run beacon");
const space = signer.did() as MemorySpace;

/** An action named `name`, as the builder annotates one with its module. */
const namedAction = (name: string): Action =>
  Object.assign(() => {}, { module: { name } });

/** A transaction no action is collecting the reads of. */
const UNCOUNTED_TX = { tx: {} } as unknown as IExtendedStorageTransaction;

describe("run-beacon", () => {
  let buffer: SharedArrayBuffer;
  let reported: RunIdentity[];
  let beacon: RunBeacon;

  beforeEach(() => {
    buffer = newRunBeaconBuffer();
    reported = [];
    beacon = new RunBeacon(buffer, (identity) => reported.push(identity));
  });

  describe("readRunBeacon()", () => {
    it("returns `undefined` for a beacon no run has marked", () => {
      expect(readRunBeacon(buffer)).toBeUndefined();
    });

    it("returns `undefined` for a reading the end of its run, and the start of another, overtook", () => {
      // The worker's thread runs on while the pool reads, so the run whose
      // epoch a reading took can end, and another start, before the reading
      // takes the run's number.

      const { enter, leave } = beacon.accessForTestingOnly;
      enter(space, namedAction("first"), "id-1");
      const load = Atomics.load;
      let loads = 0;
      using _load = stub(
        Atomics,
        "load",
        ((slots: Int32Array, index: number) => {
          if (++loads === 2) {
            leave();
            enter(space, namedAction("second"), "id-2");
          }
          return load(slots, index);
        }) as typeof Atomics.load,
      );

      expect(readRunBeacon(buffer)).toBeUndefined();
    });
  });

  describe("RunBeacon", () => {
    describe("instance members", () => {
      describe("forSpace()", () => {
        it("marks the beacon with the run's number while its body runs, and returns what the body returns", () => {
          const marks = beacon.forSpace(space);
          let during: RunBeaconReading | undefined;
          const returned = marks.hold(namedAction("total"), "id-1", () => {
            during = readRunBeacon(buffer);
            return 7;
          });

          expect(returned).toBe(7);
          expect(during).toEqual({ epoch: 1, run: 1, reads: 0 });
          expect(readRunBeacon(buffer)).toBeUndefined();
        });

        it("clears the mark once a body that throws has thrown", () => {
          const marks = beacon.forSpace(space);

          expect(() =>
            marks.hold(namedAction("total"), "id-1", () => {
              throw new Error("the body failed");
            })
          ).toThrow("the body failed");
          expect(readRunBeacon(buffer)).toBeUndefined();
        });

        it("posts what an action's number stands for once, before its first body runs", () => {
          const marks = beacon.forSpace(space);
          const action = namedAction("total");
          const postedBeforeBody: number[] = [];
          for (let run = 0; run < 2; run += 1) {
            marks.hold(action, "id-1", () => {
              postedBeforeBody.push(reported.length);
            });
          }

          expect(postedBeforeBody).toEqual([1, 1]);
          expect(reported).toEqual([
            { run: 1, space, action: "id-1", name: "total" },
          ]);
        });

        it("numbers each run of a served handler for an event afresh, and posts the event with it", () => {
          const marks = beacon.forSpace(space);
          const handler = namedAction("bump");
          const event = { sidecarId: "of:sidecar", eventId: "evt-1", seq: 4 };
          const runs: (number | undefined)[] = [];
          for (let run = 0; run < 2; run += 1) {
            marks.hold(handler, "id-1", () => {
              runs.push(readRunBeacon(buffer)?.run);
            }, event);
          }

          expect(runs).toEqual([1, 2]);
          expect(reported).toEqual([
            { run: 1, space, action: "id-1", name: "bump", event },
            { run: 2, space, action: "id-1", name: "bump", event },
          ]);
        });

        it("marks only the outermost of runs started inside one another", () => {
          const marks = beacon.forSpace(space);
          let inner: RunBeaconReading | undefined;
          let afterInner: RunBeaconReading | undefined;
          marks.hold(namedAction("outer"), "id-1", () => {
            marks.hold(namedAction("inner"), "id-2", () => {
              inner = readRunBeacon(buffer);
            });
            afterInner = readRunBeacon(buffer);
          });

          expect(inner).toEqual({ epoch: 1, run: 1, reads: 0 });
          expect(afterInner).toEqual({ epoch: 1, run: 1, reads: 0 });
          expect(reported.map(({ name }) => name)).toEqual(["outer"]);
          expect(readRunBeacon(buffer)).toBeUndefined();
        });

        it("names an action by the scheduler's id, with its module or pattern name and its piece where it carries them", () => {
          const marks = beacon.forSpace(space);
          marks.hold(namedAction("by-module"), "id-1", () => {});
          marks.hold(
            Object.assign(() => {}, {
              pattern: { name: "by-pattern" },
              schedulerObservationIdentity: { pieceRootId: "of:piece" },
            }) as Action,
            "id-2",
            () => {},
          );
          marks.hold(() => {}, "id-3", () => {});

          expect(reported).toEqual([
            { run: 1, space, action: "id-1", name: "by-module" },
            {
              run: 2,
              space,
              action: "id-2",
              name: "by-pattern",
              piece: "of:piece",
            },
            { run: 3, space, action: "id-3" },
          ]);
        });

        it("names the space of the runtime that marks", () => {
          const other = "did:key:z6MkRunBeaconOther" as MemorySpace;
          beacon.forSpace(other).hold(namedAction("total"), "id-1", () => {});

          expect(reported).toEqual([
            { run: 1, space: other, action: "id-1", name: "total" },
          ]);
        });
      });

      describe("countReads()", () => {
        it("counts the reads the read sites record into the live run, from none at each run, until it is stopped", () => {
          const stop = beacon.countReads();
          const marks = beacon.forSpace(space);
          const reads: (number | undefined)[] = [];
          try {
            for (let run = 0; run < 2; run += 1) {
              marks.hold(namedAction("total"), "id-1", () => {
                recordProxyAccess(UNCOUNTED_TX);
                recordDocumentRead({}, {});
                reads.push(readRunBeacon(buffer)?.reads);
              });
            }
          } finally {
            stop();
          }
          marks.hold(namedAction("total"), "id-1", () => {
            recordProxyAccess(UNCOUNTED_TX);
            reads.push(readRunBeacon(buffer)?.reads);
          });

          expect(reads).toEqual([2, 2, 0]);
        });
      });
    });
  });

  describe("with a runtime's scheduler", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        runBeacon: beacon.forSpace(space),
      });
    });

    afterEach(async () => {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    });

    it("marks the body of each reactive action run, named by the action", async () => {
      const setup = runtime.edit();
      const input = runtime.getCell<number>(
        space,
        "beacon-input",
        undefined,
        setup,
      );
      input.set(1);
      await setup.commit().settled;
      const during: (RunBeaconReading | undefined)[] = [];
      const reader: Action = Object.assign(
        (tx: IExtendedStorageTransaction) => {
          during.push(readRunBeacon(buffer));
          input.withTx(tx).get();
        },
        { module: { name: "reader" } },
      );
      runtime.scheduler.subscribe(reader, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.idle();

      expect(during).toEqual([{ epoch: 1, run: 1, reads: 0 }]);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ run: 1, space, name: "reader" });
      expect(readRunBeacon(buffer)).toBeUndefined();
    });

    it("marks the body of a handler's run with no event where the event has no durable entry", async () => {
      const setup = runtime.edit();
      const cell = runtime.getCell(
        space,
        "beacon-stream",
        {
          type: "object",
          properties: { stream: { asCell: ["stream"] } },
        } as const satisfies JSONSchema,
        setup,
      );
      cell.set({});
      await setup.commit().settled;
      const stream = cell.key("stream");
      const during: (RunBeaconReading | undefined)[] = [];
      runtime.scheduler.addEventHandler(
        () => {
          during.push(readRunBeacon(buffer));
        },
        stream.getAsNormalizedFullLink(),
      );
      stream.send({ clicked: true });
      await runtime.idle();

      expect(during).toHaveLength(1);
      expect(during[0]?.epoch).toBe(1);
      expect(reported).toHaveLength(1);
      expect(reported[0].event).toBeUndefined();
      expect(readRunBeacon(buffer)).toBeUndefined();
    });
  });
});
