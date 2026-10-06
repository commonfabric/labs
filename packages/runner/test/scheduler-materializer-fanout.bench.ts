import type { Cell, JSONSchema } from "../src/builder/types.ts";
import type { Action } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
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
import { benchDiagnostic } from "./bench-diagnostics.ts";

const benchDiagnosticsEnabled = Deno.env.get("BENCH_DIAGNOSTICS") === "1";

const FANOUT_SIZES = [100, 1000] as const;

const recordNumberSchema = {
  type: "object",
  additionalProperties: numberSchema,
} as const satisfies JSONSchema;

type MaterializerFanoutGraph = {
  env: SchedulerBenchEnv;
  source: Cell<number>;
  target: Cell<Record<string, number>>;
  readerRuns: number[];
  getMaterializerRuns: () => number;
};

async function setupMaterializerFanoutGraph(
  prefix: string,
  fanout: number,
): Promise<MaterializerFanoutGraph> {
  const env = createSchedulerBenchEnv();
  const { runtime } = env;
  const tx = runtime.edit();

  const source = runtime.getCell<number>(
    benchSpace,
    `${prefix}:source`,
    numberSchema,
    tx,
  );
  source.set(0);

  const target = runtime.getCell<Record<string, number>>(
    benchSpace,
    `${prefix}:target`,
    recordNumberSchema,
    tx,
  );
  target.set(Object.fromEntries(
    Array.from({ length: fanout }, (_, index) => [`k${index}`, 0]),
  ));
  await tx.commit().settled;

  let materializerRuns = 0;
  const materializer = Object.assign(
    (actionTx: IExtendedStorageTransaction) => {
      materializerRuns++;
      const next = { ...target.withTx(actionTx).get() };
      next.k0 = source.withTx(actionTx).get() ?? 0;
      target.withTx(actionTx).set(next);
    },
    {
      materializerWriteEnvelopes: [target.getAsNormalizedFullLink()],
    },
  ) as Action & {
    materializerWriteEnvelopes: ReturnType<
      typeof target.getAsNormalizedFullLink
    >[];
  };

  runtime.scheduler.subscribe(materializer, {
    reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
    shallowReads: [],
    writes: [],
  });

  const readerRuns = Array.from({ length: fanout }, () => 0);
  for (let index = 0; index < fanout; index++) {
    const key = `k${index}`;
    const reader: Action = (actionTx) => {
      readerRuns[index]++;
      target.withTx(actionTx).key(key).get();
    };
    runtime.scheduler.subscribe(reader, { isEffect: true });
  }

  await runtime.scheduler.idle();
  materializerRuns = 0;
  readerRuns.fill(0);

  return {
    env,
    source,
    target,
    readerRuns,
    getMaterializerRuns: () => materializerRuns,
  };
}

type StaticWriteGraph = {
  env: SchedulerBenchEnv;
  source: Cell<number>;
  target: Cell<number>;
  effectRuns: { value: number };
  getComputationRuns: () => number;
};

async function setupStaticWriteGraph(
  prefix: string,
): Promise<StaticWriteGraph> {
  const env = createSchedulerBenchEnv();
  const { runtime } = env;
  const tx = runtime.edit();
  const source = runtime.getCell<number>(
    benchSpace,
    `${prefix}:source`,
    numberSchema,
    tx,
  );
  source.set(0);
  const target = runtime.getCell<number>(
    benchSpace,
    `${prefix}:target`,
    numberSchema,
    tx,
  );
  target.set(0);
  await tx.commit().settled;

  let computationRuns = 0;
  const computation: Action = (actionTx) => {
    computationRuns++;
    target.withTx(actionTx).set(source.withTx(actionTx).get() ?? 0);
  };
  runtime.scheduler.subscribe(computation, {
    reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
    shallowReads: [],
    writes: [toMemorySpaceAddress(target.getAsNormalizedFullLink())],
  });

  const effectRuns = { value: 0 };
  const effect: Action = (actionTx) => {
    effectRuns.value++;
    target.withTx(actionTx).get();
  };
  runtime.scheduler.subscribe(effect, { isEffect: true });
  await runtime.scheduler.idle();
  computationRuns = 0;
  effectRuns.value = 0;

  return {
    env,
    source,
    target,
    effectRuns,
    getComputationRuns: () => computationRuns,
  };
}

async function updateSource(
  env: SchedulerBenchEnv,
  source: Cell<number>,
  value: number,
) {
  const tx = env.runtime.edit();
  source.withTx(tx).set(value);
  await tx.commit().settled;
}

for (const fanout of FANOUT_SIZES) {
  Deno.bench(
    `Scheduler materializer fanout - broad side write with ${fanout} readers`,
    benchOptions("scheduler-materializer-fanout", fanout === FANOUT_SIZES[0]),
    async () => {
      await runWithSchedulerTiming(
        `materializer fanout: ${fanout} narrow readers`,
        async (resetMeasuredTiming) => {
          const graph = await setupMaterializerFanoutGraph(
            `materializer:${fanout}`,
            fanout,
          );

          resetMeasuredTiming();
          await updateSource(graph.env, graph.source, 1);
          await graph.env.runtime.scheduler.idle();

          const totalReaderRuns = graph.readerRuns.reduce(
            (sum, count) => sum + count,
            0,
          );
          if (benchDiagnosticsEnabled) {
            benchDiagnostic(
              `materializer fanout ${fanout}: materializerRuns=${graph.getMaterializerRuns()}, readerRuns=${totalReaderRuns}`,
            );
          }
          consumeNumber(graph.target.get().k0);

          await cleanupSchedulerBenchEnv(graph.env);
        },
      );
    },
  );
}

Deno.bench(
  "Scheduler materializer fanout - static declared write control",
  benchOptions("scheduler-materializer-fanout"),
  async () => {
    await runWithSchedulerTiming(
      "materializer fanout: static declared write control",
      async (resetMeasuredTiming) => {
        const graph = await setupStaticWriteGraph("materializer-static");

        resetMeasuredTiming();
        await updateSource(graph.env, graph.source, 1);
        await graph.env.runtime.scheduler.idle();

        if (benchDiagnosticsEnabled) {
          benchDiagnostic(
            `static declared write: computationRuns=${graph.getComputationRuns()}, effectRuns=${graph.effectRuns.value}`,
          );
        }
        consumeNumber(graph.target.get());

        await cleanupSchedulerBenchEnv(graph.env);
      },
    );
  },
);
