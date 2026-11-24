import type { Cell } from "../src/builder/types.ts";
import type { Action, EventHandler } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import {
  benchOptions,
  benchSpace,
  cleanupSchedulerBenchEnv,
  consumeNumber,
  consumeNumbers,
  createSchedulerBenchEnv,
  numberSchema,
  objectSchema,
  runWithSchedulerTiming,
  type SchedulerBenchEnv,
} from "./scheduler-bench-helpers.ts";

/**
 * Canonical pull-scheduler event preflight benchmarks.
 *
 * The older scheduler benchmarks cover generic push-mode/index operations, and
 * push-pull-patterns.bench.ts covers real pattern map/filter/fanout behavior.
 * This file owns the 30-note failure shape:
 *
 * - 30 note creations produced 210 preflights, exactly 7 per note.
 * - Hot note handlers populated about 660 recursive reads and 330 shallow reads.
 * - The hottest root writer fanout was just over 500 direct writers.
 * - Even tiny menu handlers still paid for broad upstream graph traversal.
 */
const BROAD_FANOUT = 512;

const QUEUED_EVENT_ROUNDS = 30;
const EVENTS_PER_ROUND = 7;
const DEEP_READ_COUNT = 660;
const SHALLOW_READ_COUNT = 330;

type BroadGraph = {
  env: SchedulerBenchEnv;
  source: Cell<number>;
  target: Cell<number>;
  eventStream: Cell<number>;
  result: Cell<number>;
};

async function setupBroadGraph(
  prefix: string,
  fanout = BROAD_FANOUT,
): Promise<BroadGraph> {
  const env = createSchedulerBenchEnv();
  const { runtime } = env;
  const tx = runtime.edit();

  const source = runtime.getCell<number>(
    benchSpace,
    `${prefix}:source`,
    numberSchema,
    tx,
  );
  source.set(1);
  const shared = runtime.getCell<number>(
    benchSpace,
    `${prefix}:shared`,
    numberSchema,
    tx,
  );
  shared.set(0);
  const target = runtime.getCell<number>(
    benchSpace,
    `${prefix}:target`,
    numberSchema,
    tx,
  );
  target.set(0);
  const eventStream = runtime.getCell<number>(
    benchSpace,
    `${prefix}:event`,
    numberSchema,
    tx,
  );
  eventStream.set(0);
  const result = runtime.getCell<number>(
    benchSpace,
    `${prefix}:result`,
    numberSchema,
    tx,
  );
  result.set(0);

  const fanCells: Cell<number>[] = [];
  for (let i = 0; i < fanout; i++) {
    const cell = runtime.getCell<number>(
      benchSpace,
      `${prefix}:fan:${i}`,
      numberSchema,
      tx,
    );
    cell.set(0);
    fanCells.push(cell);
  }

  await tx.commit().settled;

  const sharedWriter: Action = (actionTx) => {
    shared.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
  };
  runtime.scheduler.subscribe(
    sharedWriter,
    {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(shared.getAsNormalizedFullLink())],
    },
    {},
  );

  for (const [index, fanCell] of fanCells.entries()) {
    const fanWriter: Action = (actionTx) => {
      fanCell.withTx(actionTx).send(
        (shared.withTx(actionTx).get() ?? 0) + index,
      );
    };
    runtime.scheduler.subscribe(
      fanWriter,
      {
        reads: [toMemorySpaceAddress(shared.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(fanCell.getAsNormalizedFullLink())],
      },
      {},
    );
  }

  const targetWriter: Action = (actionTx) => {
    let sum = 0;
    for (const fanCell of fanCells) {
      sum += fanCell.withTx(actionTx).get() ?? 0;
    }
    target.withTx(actionTx).send(sum);
  };
  runtime.scheduler.subscribe(
    targetWriter,
    {
      reads: fanCells.map((cell) =>
        toMemorySpaceAddress(cell.getAsNormalizedFullLink())
      ),
      shallowReads: [],
      writes: [toMemorySpaceAddress(target.getAsNormalizedFullLink())],
    },
    {},
  );

  await target.pull();

  return { env, source, target, eventStream, result };
}

function addTargetReadingHandler(graph: BroadGraph) {
  const { env, target, eventStream, result } = graph;
  const handler: EventHandler = (handlerTx, event: number) => {
    const value = target.withTx(handlerTx).get() ?? 0;
    result.withTx(handlerTx).send(value + event);
  };
  const populateDependencies = (depTx: IExtendedStorageTransaction) => {
    target.withTx(depTx).get();
  };

  env.runtime.scheduler.addEventHandler(
    handler,
    eventStream.getAsNormalizedFullLink(),
    populateDependencies,
  );
}

Deno.bench(
  "Scheduler event preflight - clean event over broad graph",
  benchOptions("scheduler-event-preflight", true),
  async () => {
    await runWithSchedulerTiming(
      "event preflight: clean event over broad graph",
      async (resetMeasuredTiming) => {
        const graph = await setupBroadGraph("preflight-clean");
        addTargetReadingHandler(graph);

        resetMeasuredTiming();
        graph.env.runtime.scheduler.queueEvent(
          graph.eventStream.getAsNormalizedFullLink(),
          1,
        );
        await graph.result.pull();
        consumeNumber(graph.result.get());

        await cleanupSchedulerBenchEnv(graph.env);
      },
    );
  },
);

Deno.bench(
  "Scheduler event preflight - event waits on transitive invalid writer",
  benchOptions("scheduler-event-preflight"),
  async () => {
    await runWithSchedulerTiming(
      "event preflight: waits on transitive invalid writer",
      async (resetMeasuredTiming) => {
        const graph = await setupBroadGraph("preflight-invalid", 1);
        addTargetReadingHandler(graph);

        const updateTx = graph.env.runtime.edit();
        graph.source.withTx(updateTx).send(2);
        await updateTx.commit().settled;

        resetMeasuredTiming();
        graph.env.runtime.scheduler.queueEvent(
          graph.eventStream.getAsNormalizedFullLink(),
          5,
        );
        await graph.result.pull();
        consumeNumber(graph.result.get());

        await cleanupSchedulerBenchEnv(graph.env);
      },
    );
  },
);

Deno.bench(
  "Scheduler event preflight - note-shaped 30x7 clean events",
  benchOptions("scheduler-event-preflight"),
  async () => {
    await runWithSchedulerTiming(
      "event preflight: note-shaped 30x7 clean events",
      async (resetMeasuredTiming) => {
        const graph = await setupBroadGraph("preflight-queued");
        const resultCells: Cell<number>[] = [];
        const eventStreams: Cell<number>[] = [];
        const setupTx = graph.env.runtime.edit();

        for (let i = 0; i < EVENTS_PER_ROUND; i++) {
          const eventStream = graph.env.runtime.getCell<number>(
            benchSpace,
            `preflight-queued:event:${i}`,
            numberSchema,
            setupTx,
          );
          eventStream.set(0);
          const result = graph.env.runtime.getCell<number>(
            benchSpace,
            `preflight-queued:result:${i}`,
            numberSchema,
            setupTx,
          );
          result.set(0);
          eventStreams.push(eventStream);
          resultCells.push(result);
        }
        await setupTx.commit().settled;

        for (let i = 0; i < EVENTS_PER_ROUND; i++) {
          const eventStream = eventStreams[i];
          const result = resultCells[i];
          const handler: EventHandler = (handlerTx, event: number) => {
            const value = graph.target.withTx(handlerTx).get() ?? 0;
            result.withTx(handlerTx).send(value + event);
          };
          graph.env.runtime.scheduler.addEventHandler(
            handler,
            eventStream.getAsNormalizedFullLink(),
            (depTx) => graph.target.withTx(depTx).get(),
          );
        }

        resetMeasuredTiming();
        for (let round = 0; round < QUEUED_EVENT_ROUNDS; round++) {
          for (let i = 0; i < EVENTS_PER_ROUND; i++) {
            graph.env.runtime.scheduler.queueEvent(
              eventStreams[i].getAsNormalizedFullLink(),
              round + i,
            );
          }
          await graph.env.runtime.scheduler.idle();
        }
        consumeNumbers(resultCells.map((cell) => cell.get()));

        await cleanupSchedulerBenchEnv(graph.env);
      },
    );
  },
);

Deno.bench(
  "Scheduler event preflight - deep read-populated handler",
  benchOptions("scheduler-event-preflight"),
  async () => {
    await runWithSchedulerTiming(
      "event preflight: deep read-populated handler",
      async (resetMeasuredTiming) => {
        const env = createSchedulerBenchEnv();
        const { runtime } = env;
        const tx = runtime.edit();
        const shared = runtime.getCell<number>(
          benchSpace,
          "preflight-deep:shared",
          numberSchema,
          tx,
        );
        shared.set(1);
        const eventStream = runtime.getCell<number>(
          benchSpace,
          "preflight-deep:event",
          numberSchema,
          tx,
        );
        eventStream.set(0);
        const result = runtime.getCell<number>(
          benchSpace,
          "preflight-deep:result",
          numberSchema,
          tx,
        );
        result.set(0);

        const deepReadCells: Cell<number>[] = [];
        const shallowReadCells: Cell<{ payload: { value: number } }>[] = [];
        for (let i = 0; i < DEEP_READ_COUNT; i++) {
          const cell = runtime.getCell<number>(
            benchSpace,
            `preflight-deep:read:${i}`,
            numberSchema,
            tx,
          );
          cell.set(i);
          deepReadCells.push(cell);
        }
        for (let i = 0; i < SHALLOW_READ_COUNT; i++) {
          const cell = runtime.getCell<{ payload: { value: number } }>(
            benchSpace,
            `preflight-deep:shallow:${i}`,
            objectSchema,
            tx,
          );
          cell.set({ payload: { value: i } });
          shallowReadCells.push(cell);
        }
        await tx.commit().settled;

        for (const [index, cell] of deepReadCells.entries()) {
          const writer: Action = (actionTx) => {
            cell.withTx(actionTx).send(
              (shared.withTx(actionTx).get() ?? 0) + index,
            );
          };
          runtime.scheduler.subscribe(
            writer,
            {
              reads: [toMemorySpaceAddress(shared.getAsNormalizedFullLink())],
              shallowReads: [],
              writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
            },
            {},
          );
        }

        for (const [index, cell] of shallowReadCells.entries()) {
          const writer: Action = (actionTx) => {
            cell.withTx(actionTx).key("payload").send({
              value: (shared.withTx(actionTx).get() ?? 0) + index,
            });
          };
          runtime.scheduler.subscribe(
            writer,
            {
              reads: [toMemorySpaceAddress(shared.getAsNormalizedFullLink())],
              shallowReads: [],
              writes: [
                toMemorySpaceAddress(
                  cell.key("payload").getAsNormalizedFullLink(),
                ),
              ],
            },
            {},
          );
        }

        const handler: EventHandler = (handlerTx, event: number) => {
          let sum = event;
          for (const cell of deepReadCells) {
            sum += cell.withTx(handlerTx).get() ?? 0;
          }
          result.withTx(handlerTx).send(sum);
        };
        const populateDependencies = (depTx: IExtendedStorageTransaction) => {
          for (const cell of deepReadCells) {
            cell.withTx(depTx).get();
          }
          for (const cell of shallowReadCells) {
            cell.withTx(depTx).key("payload").getRaw({ nonRecursive: true });
          }
        };

        runtime.scheduler.addEventHandler(
          handler,
          eventStream.getAsNormalizedFullLink(),
          populateDependencies,
        );

        resetMeasuredTiming();
        runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
        await result.pull();
        consumeNumber(result.get());

        await cleanupSchedulerBenchEnv(env);
      },
    );
  },
);
