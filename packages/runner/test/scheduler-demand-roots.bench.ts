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
  runWithSchedulerTiming,
  type SchedulerBenchEnv,
} from "./scheduler-bench-helpers.ts";

const DEMAND_EFFECT_COUNT = 24;
const DEMAND_ROUNDS = 10;
const CHILD_EFFECT_COUNT = 12;

type DemandGraph = {
  env: SchedulerBenchEnv;
  source: Cell<number>;
  output: Cell<number>;
  effectOutputs: Cell<number>[];
};

async function setupDemandGraph(
  prefix: string,
  effectCount = 0,
): Promise<DemandGraph> {
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
  const intermediate = runtime.getCell<number>(
    benchSpace,
    `${prefix}:intermediate`,
    numberSchema,
    tx,
  );
  intermediate.set(0);
  const output = runtime.getCell<number>(
    benchSpace,
    `${prefix}:output`,
    numberSchema,
    tx,
  );
  output.set(0);
  const effectOutputs: Cell<number>[] = [];
  for (let i = 0; i < effectCount; i++) {
    const effectOutput = runtime.getCell<number>(
      benchSpace,
      `${prefix}:effect:${i}`,
      numberSchema,
      tx,
    );
    effectOutput.set(0);
    effectOutputs.push(effectOutput);
  }
  await tx.commit().settled;

  const intermediateAction: Action = (actionTx) => {
    intermediate.withTx(actionTx).send(
      (source.withTx(actionTx).get() ?? 0) * 2,
    );
  };
  const outputAction: Action = (actionTx) => {
    output.withTx(actionTx).send(
      (intermediate.withTx(actionTx).get() ?? 0) + 1,
    );
  };
  runtime.scheduler.subscribe(
    intermediateAction,
    {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
    },
    {},
  );
  runtime.scheduler.subscribe(
    outputAction,
    {
      reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
    },
    {},
  );

  for (const [index, effectOutput] of effectOutputs.entries()) {
    const effect: Action = (actionTx) => {
      effectOutput.withTx(actionTx).send(
        (output.withTx(actionTx).get() ?? 0) + index,
      );
    };
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectOutput.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
  }

  if (effectOutputs.length > 0) {
    await runtime.scheduler.idle();
  } else {
    await output.pull();
  }

  return { env, source, output, effectOutputs };
}

async function setSource(graph: DemandGraph, value: number) {
  const tx = graph.env.runtime.edit();
  graph.source.withTx(tx).send(value);
  await tx.commit().settled;
}

Deno.bench(
  "Scheduler demand roots - effect demand root",
  benchOptions("scheduler-demand-roots", true),
  async () => {
    await runWithSchedulerTiming(
      "demand roots: effect demand root",
      async (resetMeasuredTiming) => {
        const graph = await setupDemandGraph(
          "demand-effect",
          DEMAND_EFFECT_COUNT,
        );

        resetMeasuredTiming();
        for (let round = 0; round < DEMAND_ROUNDS; round++) {
          await setSource(graph, round + 2);
          await graph.env.runtime.scheduler.idle();
          consumeNumbers(graph.effectOutputs.map((cell) => cell.get()));
        }

        await cleanupSchedulerBenchEnv(graph.env);
      },
    );
  },
);

Deno.bench(
  "Scheduler demand roots - event demand root",
  benchOptions("scheduler-demand-roots"),
  async () => {
    await runWithSchedulerTiming(
      "demand roots: event demand root",
      async (resetMeasuredTiming) => {
        const graph = await setupDemandGraph("demand-event", 0);
        const setupTx = graph.env.runtime.edit();
        const eventStream = graph.env.runtime.getCell<number>(
          benchSpace,
          "demand-event:event",
          numberSchema,
          setupTx,
        );
        eventStream.set(0);
        const result = graph.env.runtime.getCell<number>(
          benchSpace,
          "demand-event:result",
          numberSchema,
          setupTx,
        );
        result.set(0);
        await setupTx.commit().settled;

        const handler: EventHandler = (handlerTx, event: number) => {
          result.withTx(handlerTx).send(
            (graph.output.withTx(handlerTx).get() ?? 0) + event,
          );
        };
        const populateDependencies = (depTx: IExtendedStorageTransaction) => {
          graph.output.withTx(depTx).get();
        };
        graph.env.runtime.scheduler.addEventHandler(
          handler,
          eventStream.getAsNormalizedFullLink(),
          populateDependencies,
        );

        resetMeasuredTiming();
        for (let round = 0; round < DEMAND_ROUNDS; round++) {
          await setSource(graph, round + 2);
          graph.env.runtime.scheduler.queueEvent(
            eventStream.getAsNormalizedFullLink(),
            round,
          );
          await result.pull();
          consumeNumber(result.get());
        }

        await cleanupSchedulerBenchEnv(graph.env);
      },
    );
  },
);

Deno.bench(
  "Scheduler demand roots - mixed effect and event roots",
  benchOptions("scheduler-demand-roots"),
  async () => {
    await runWithSchedulerTiming(
      "demand roots: mixed effect and event roots",
      async (resetMeasuredTiming) => {
        const graph = await setupDemandGraph(
          "demand-mixed",
          DEMAND_EFFECT_COUNT,
        );
        const setupTx = graph.env.runtime.edit();
        const eventStream = graph.env.runtime.getCell<number>(
          benchSpace,
          "demand-mixed:event",
          numberSchema,
          setupTx,
        );
        eventStream.set(0);
        const result = graph.env.runtime.getCell<number>(
          benchSpace,
          "demand-mixed:result",
          numberSchema,
          setupTx,
        );
        result.set(0);
        await setupTx.commit().settled;

        const handler: EventHandler = (handlerTx, event: number) => {
          result.withTx(handlerTx).send(
            (graph.output.withTx(handlerTx).get() ?? 0) + event,
          );
        };
        graph.env.runtime.scheduler.addEventHandler(
          handler,
          eventStream.getAsNormalizedFullLink(),
          (depTx) => graph.output.withTx(depTx).get(),
        );

        resetMeasuredTiming();
        for (let round = 0; round < DEMAND_ROUNDS; round++) {
          await setSource(graph, round + 2);
          graph.env.runtime.scheduler.queueEvent(
            eventStream.getAsNormalizedFullLink(),
            round,
          );
          await result.pull();
          await graph.env.runtime.scheduler.idle();
          consumeNumber(result.get());
          consumeNumbers(graph.effectOutputs.map((cell) => cell.get()));
        }

        await cleanupSchedulerBenchEnv(graph.env);
      },
    );
  },
);

Deno.bench(
  "Scheduler demand roots - parent clears generated children",
  benchOptions("scheduler-demand-roots"),
  async () => {
    await runWithSchedulerTiming(
      "demand roots: parent clears generated children",
      async (resetMeasuredTiming) => {
        const env = createSchedulerBenchEnv();
        const { runtime } = env;
        const tx = runtime.edit();
        const source = runtime.getCell<number>(
          benchSpace,
          "demand-parent:source",
          numberSchema,
          tx,
        );
        source.set(1);
        const parentOutput = runtime.getCell<number>(
          benchSpace,
          "demand-parent:output",
          numberSchema,
          tx,
        );
        parentOutput.set(0);
        const childOutputs: Cell<number>[] = [];
        for (let i = 0; i < CHILD_EFFECT_COUNT; i++) {
          const childOutput = runtime.getCell<number>(
            benchSpace,
            `demand-parent:child:${i}`,
            numberSchema,
            tx,
          );
          childOutput.set(0);
          childOutputs.push(childOutput);
        }
        await tx.commit().settled;

        const childCancels: Array<() => void> = [];
        const parentEffect: Action = (actionTx) => {
          for (const cancel of childCancels.splice(0)) {
            cancel();
          }

          const value = source.withTx(actionTx).get() ?? 0;
          parentOutput.withTx(actionTx).send(value);

          for (const [index, childOutput] of childOutputs.entries()) {
            const childEffect: Action = (childTx) => {
              childOutput.withTx(childTx).send(
                (parentOutput.withTx(childTx).get() ?? 0) + index,
              );
            };
            childCancels.push(
              runtime.scheduler.subscribe(
                childEffect,
                {
                  reads: [
                    toMemorySpaceAddress(
                      parentOutput.getAsNormalizedFullLink(),
                    ),
                  ],
                  shallowReads: [],
                  writes: [
                    toMemorySpaceAddress(childOutput.getAsNormalizedFullLink()),
                  ],
                },
                { isEffect: true },
              ),
            );
          }
        };

        runtime.scheduler.subscribe(
          parentEffect,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(parentOutput.getAsNormalizedFullLink()),
            ],
          },
          { isEffect: true },
        );
        await runtime.scheduler.idle();

        resetMeasuredTiming();
        for (let round = 0; round < 8; round++) {
          const updateTx = runtime.edit();
          source.withTx(updateTx).send(round + 2);
          await updateTx.commit().settled;
          await runtime.scheduler.idle();
          consumeNumbers(childOutputs.map((cell) => cell.get()));
        }

        for (const cancel of childCancels.splice(0)) {
          cancel();
        }
        await cleanupSchedulerBenchEnv(env);
      },
    );
  },
);
