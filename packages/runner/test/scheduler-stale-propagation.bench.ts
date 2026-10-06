import type { Cell } from "../src/builder/types.ts";
import type { Action } from "../src/scheduler.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import {
  benchOptions,
  benchSpace,
  cleanupSchedulerBenchEnv,
  consumeNumber,
  createSchedulerBenchEnv,
  numberSchema,
  runWithSchedulerTiming,
  type SchedulerBenchEnv,
} from "./scheduler-bench-helpers.ts";

const UPDATE_ROUNDS = 12;
const WIDE_FANOUT = 64;

async function setNumber(
  env: SchedulerBenchEnv,
  cell: Cell<number>,
  value: number,
) {
  const tx = env.runtime.edit();
  cell.withTx(tx).send(value);
  await tx.commit().settled;
}

Deno.bench(
  "Scheduler stale propagation - chain",
  benchOptions("scheduler-stale-propagation", true),
  async () => {
    await runWithSchedulerTiming(
      "stale propagation: chain",
      async (resetMeasuredTiming) => {
        const env = createSchedulerBenchEnv();
        const { runtime } = env;
        const tx = runtime.edit();
        const source = runtime.getCell<number>(
          benchSpace,
          "stale-chain:source",
          numberSchema,
          tx,
        );
        source.set(1);
        const a = runtime.getCell<number>(
          benchSpace,
          "stale-chain:a",
          numberSchema,
          tx,
        );
        a.set(0);
        const b = runtime.getCell<number>(
          benchSpace,
          "stale-chain:b",
          numberSchema,
          tx,
        );
        b.set(0);
        const c = runtime.getCell<number>(
          benchSpace,
          "stale-chain:c",
          numberSchema,
          tx,
        );
        c.set(0);
        const sink = runtime.getCell<number>(
          benchSpace,
          "stale-chain:sink",
          numberSchema,
          tx,
        );
        sink.set(0);
        await tx.commit().settled;

        const actionA: Action = (actionTx) => {
          a.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
        };
        const actionB: Action = (actionTx) => {
          b.withTx(actionTx).send((a.withTx(actionTx).get() ?? 0) + 1);
        };
        const actionC: Action = (actionTx) => {
          c.withTx(actionTx).send((b.withTx(actionTx).get() ?? 0) + 1);
        };
        const effect: Action = (actionTx) => {
          sink.withTx(actionTx).send(c.withTx(actionTx).get() ?? 0);
        };

        runtime.scheduler.subscribe(
          actionA,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(a.getAsNormalizedFullLink())],
          },
          {},
        );
        runtime.scheduler.subscribe(
          actionB,
          {
            reads: [toMemorySpaceAddress(a.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
          },
          {},
        );
        runtime.scheduler.subscribe(
          actionC,
          {
            reads: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(c.getAsNormalizedFullLink())],
          },
          {},
        );
        runtime.scheduler.subscribe(
          effect,
          {
            reads: [toMemorySpaceAddress(c.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
          },
          { isEffect: true },
        );
        await sink.pull();

        resetMeasuredTiming();
        for (let round = 0; round < UPDATE_ROUNDS; round++) {
          await setNumber(env, source, round + 2);
          await sink.pull();
          consumeNumber(sink.get());
        }

        await cleanupSchedulerBenchEnv(env);
      },
    );
  },
);

Deno.bench(
  "Scheduler stale propagation - diamond",
  benchOptions("scheduler-stale-propagation"),
  async () => {
    await runWithSchedulerTiming(
      "stale propagation: diamond",
      async (resetMeasuredTiming) => {
        const env = createSchedulerBenchEnv();
        const { runtime } = env;
        const tx = runtime.edit();
        const source = runtime.getCell<number>(
          benchSpace,
          "stale-diamond:source",
          numberSchema,
          tx,
        );
        source.set(1);
        const left = runtime.getCell<number>(
          benchSpace,
          "stale-diamond:left",
          numberSchema,
          tx,
        );
        left.set(0);
        const right = runtime.getCell<number>(
          benchSpace,
          "stale-diamond:right",
          numberSchema,
          tx,
        );
        right.set(0);
        const merged = runtime.getCell<number>(
          benchSpace,
          "stale-diamond:merged",
          numberSchema,
          tx,
        );
        merged.set(0);
        const sink = runtime.getCell<number>(
          benchSpace,
          "stale-diamond:sink",
          numberSchema,
          tx,
        );
        sink.set(0);
        await tx.commit().settled;

        const leftAction: Action = (actionTx) => {
          left.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) * 2);
        };
        const rightAction: Action = (actionTx) => {
          right.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) * 3);
        };
        const mergeAction: Action = (actionTx) => {
          merged.withTx(actionTx).send(
            (left.withTx(actionTx).get() ?? 0) +
              (right.withTx(actionTx).get() ?? 0),
          );
        };
        const effect: Action = (actionTx) => {
          sink.withTx(actionTx).send(merged.withTx(actionTx).get() ?? 0);
        };

        runtime.scheduler.subscribe(
          leftAction,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(left.getAsNormalizedFullLink())],
          },
          {},
        );
        runtime.scheduler.subscribe(
          rightAction,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(right.getAsNormalizedFullLink())],
          },
          {},
        );
        runtime.scheduler.subscribe(
          mergeAction,
          {
            reads: [
              toMemorySpaceAddress(left.getAsNormalizedFullLink()),
              toMemorySpaceAddress(right.getAsNormalizedFullLink()),
            ],
            shallowReads: [],
            writes: [toMemorySpaceAddress(merged.getAsNormalizedFullLink())],
          },
          {},
        );
        runtime.scheduler.subscribe(
          effect,
          {
            reads: [toMemorySpaceAddress(merged.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
          },
          { isEffect: true },
        );
        await sink.pull();

        resetMeasuredTiming();
        for (let round = 0; round < UPDATE_ROUNDS; round++) {
          await setNumber(env, source, round + 2);
          await sink.pull();
          consumeNumber(sink.get());
        }

        await cleanupSchedulerBenchEnv(env);
      },
    );
  },
);

Deno.bench(
  "Scheduler stale propagation - wide fanout",
  benchOptions("scheduler-stale-propagation"),
  async () => {
    await runWithSchedulerTiming(
      "stale propagation: wide fanout",
      async (resetMeasuredTiming) => {
        const env = createSchedulerBenchEnv();
        const { runtime } = env;
        const tx = runtime.edit();
        const source = runtime.getCell<number>(
          benchSpace,
          "stale-wide:source",
          numberSchema,
          tx,
        );
        source.set(1);
        const hub = runtime.getCell<number>(
          benchSpace,
          "stale-wide:hub",
          numberSchema,
          tx,
        );
        hub.set(0);
        const leaves: Cell<number>[] = [];
        for (let i = 0; i < WIDE_FANOUT; i++) {
          const leaf = runtime.getCell<number>(
            benchSpace,
            `stale-wide:leaf:${i}`,
            numberSchema,
            tx,
          );
          leaf.set(0);
          leaves.push(leaf);
        }
        const sink = runtime.getCell<number>(
          benchSpace,
          "stale-wide:sink",
          numberSchema,
          tx,
        );
        sink.set(0);
        await tx.commit().settled;

        const hubAction: Action = (actionTx) => {
          hub.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
        };
        runtime.scheduler.subscribe(
          hubAction,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(hub.getAsNormalizedFullLink())],
          },
          {},
        );

        for (const [index, leaf] of leaves.entries()) {
          const leafAction: Action = (actionTx) => {
            leaf.withTx(actionTx).send(
              (hub.withTx(actionTx).get() ?? 0) + index,
            );
          };
          runtime.scheduler.subscribe(
            leafAction,
            {
              reads: [toMemorySpaceAddress(hub.getAsNormalizedFullLink())],
              shallowReads: [],
              writes: [toMemorySpaceAddress(leaf.getAsNormalizedFullLink())],
            },
            {},
          );
        }

        const effect: Action = (actionTx) => {
          let sum = 0;
          for (const leaf of leaves) {
            sum += leaf.withTx(actionTx).get() ?? 0;
          }
          sink.withTx(actionTx).send(sum);
        };
        runtime.scheduler.subscribe(
          effect,
          {
            reads: leaves.map((leaf) =>
              toMemorySpaceAddress(leaf.getAsNormalizedFullLink())
            ),
            shallowReads: [],
            writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
          },
          { isEffect: true },
        );
        await sink.pull();

        resetMeasuredTiming();
        for (let round = 0; round < 8; round++) {
          await setNumber(env, source, round + 2);
          await sink.pull();
          consumeNumber(sink.get());
        }

        await cleanupSchedulerBenchEnv(env);
      },
    );
  },
);

Deno.bench(
  "Scheduler stale propagation - dynamic deps",
  benchOptions("scheduler-stale-propagation"),
  async () => {
    await runWithSchedulerTiming(
      "stale propagation: dynamic deps",
      async (resetMeasuredTiming) => {
        const env = createSchedulerBenchEnv();
        const { runtime } = env;
        const tx = runtime.edit();
        const selector = runtime.getCell<number>(
          benchSpace,
          "stale-dynamic:selector",
          numberSchema,
          tx,
        );
        selector.set(0);
        const sourceA = runtime.getCell<number>(
          benchSpace,
          "stale-dynamic:source-a",
          numberSchema,
          tx,
        );
        sourceA.set(1);
        const sourceB = runtime.getCell<number>(
          benchSpace,
          "stale-dynamic:source-b",
          numberSchema,
          tx,
        );
        sourceB.set(10);
        const output = runtime.getCell<number>(
          benchSpace,
          "stale-dynamic:output",
          numberSchema,
          tx,
        );
        output.set(0);
        const sink = runtime.getCell<number>(
          benchSpace,
          "stale-dynamic:sink",
          numberSchema,
          tx,
        );
        sink.set(0);
        await tx.commit().settled;

        const action: Action = (actionTx) => {
          const useB = (selector.withTx(actionTx).get() ?? 0) % 2 === 1;
          const source = useB ? sourceB : sourceA;
          output.withTx(actionTx).send(source.withTx(actionTx).get() ?? 0);
        };
        const effect: Action = (actionTx) => {
          sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
        };

        runtime.scheduler.subscribe(
          action,
          {
            reads: [
              toMemorySpaceAddress(selector.getAsNormalizedFullLink()),
              toMemorySpaceAddress(sourceA.getAsNormalizedFullLink()),
            ],
            shallowReads: [],
            writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
          },
          {},
        );
        runtime.scheduler.subscribe(
          effect,
          {
            reads: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
          },
          { isEffect: true },
        );
        await sink.pull();

        resetMeasuredTiming();
        for (let round = 0; round < UPDATE_ROUNDS; round++) {
          const updateTx = runtime.edit();
          selector.withTx(updateTx).send(round);
          sourceA.withTx(updateTx).send(round + 2);
          sourceB.withTx(updateTx).send(round + 20);
          await updateTx.commit().settled;
          await sink.pull();
          consumeNumber(sink.get());
        }

        await cleanupSchedulerBenchEnv(env);
      },
    );
  },
);

Deno.bench(
  "Scheduler stale propagation - unchanged recompute",
  benchOptions("scheduler-stale-propagation"),
  async () => {
    await runWithSchedulerTiming(
      "stale propagation: unchanged recompute",
      async (resetMeasuredTiming) => {
        const env = createSchedulerBenchEnv();
        const { runtime } = env;
        const tx = runtime.edit();
        const source = runtime.getCell<number>(
          benchSpace,
          "stale-unchanged:source",
          numberSchema,
          tx,
        );
        source.set(1);
        const stable = runtime.getCell<number>(
          benchSpace,
          "stale-unchanged:stable",
          numberSchema,
          tx,
        );
        stable.set(0);
        const sink = runtime.getCell<number>(
          benchSpace,
          "stale-unchanged:sink",
          numberSchema,
          tx,
        );
        sink.set(0);
        await tx.commit().settled;

        const stableAction: Action = (actionTx) => {
          source.withTx(actionTx).get();
          stable.withTx(actionTx).send(1);
        };
        const effect: Action = (actionTx) => {
          sink.withTx(actionTx).send(stable.withTx(actionTx).get() ?? 0);
        };

        runtime.scheduler.subscribe(
          stableAction,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(stable.getAsNormalizedFullLink())],
          },
          {},
        );
        runtime.scheduler.subscribe(
          effect,
          {
            reads: [toMemorySpaceAddress(stable.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
          },
          { isEffect: true },
        );
        await sink.pull();

        resetMeasuredTiming();
        for (let round = 0; round < UPDATE_ROUNDS; round++) {
          await setNumber(env, source, round + 2);
          await sink.pull();
          consumeNumber(sink.get());
        }

        await cleanupSchedulerBenchEnv(env);
      },
    );
  },
);
