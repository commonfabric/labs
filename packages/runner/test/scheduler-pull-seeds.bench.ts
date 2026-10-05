import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

type SchedulerInternals = {
  markDirty: (action: Action) => void;
};

function getSchedulerInternals(
  scheduler: Runtime["scheduler"],
): SchedulerInternals {
  const internal = scheduler.accessForTestingOnly;

  return {
    markDirty: (action) => internal.markAndScheduleInvalidAction(action),
  };
}

async function setupSharedSeedGraph(effectCount: number) {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx = runtime.edit();
  const source = runtime.getCell<number>(
    space,
    `bench-pull-seeds-source-${effectCount}`,
    undefined,
    tx,
  );
  source.set(1);
  const intermediate = runtime.getCell<number>(
    space,
    `bench-pull-seeds-intermediate-${effectCount}`,
    undefined,
    tx,
  );
  intermediate.set(0);

  const outputs = Array.from({ length: effectCount }, (_, index) => {
    const output = runtime.getCell<number>(
      space,
      `bench-pull-seeds-output-${effectCount}-${index}`,
      undefined,
      tx,
    );
    output.set(0);
    return output;
  });
  const effects: Action[] = [];

  await tx.commit().settled;

  const computation: Action = (actionTx) => {
    const value = source.withTx(actionTx).get() ?? 0;
    intermediate.withTx(actionTx).send(value * 10);
  };

  runtime.scheduler.subscribe(
    computation,
    {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
    },
    {},
  );

  for (const [index, output] of outputs.entries()) {
    const effect: Action = (actionTx) => {
      const value = intermediate.withTx(actionTx).get() ?? 0;
      output.withTx(actionTx).send(value + index);
    };
    effects.push(effect);

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
  }

  await runtime.scheduler.idle();

  return { runtime, storageManager, computation, effects };
}

async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) {
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench(
  "Scheduler pull - shared invalid dependency fanout (50 effects, 20 reschedules)",
  { group: "pull-shared-memo" },
  async () => {
    const { runtime, storageManager, computation } = await setupSharedSeedGraph(
      50,
    );
    const schedulerInternal = getSchedulerInternals(runtime.scheduler);

    for (let i = 0; i < 20; i++) {
      schedulerInternal.markDirty(computation);
      await runtime.scheduler.idle();
    }

    await cleanup(runtime, storageManager);
  },
);

Deno.bench(
  "Scheduler pull - shared invalid dependency fanout (200 effects, 10 reschedules)",
  { group: "pull-shared-memo" },
  async () => {
    const { runtime, storageManager, computation } = await setupSharedSeedGraph(
      200,
    );
    const schedulerInternal = getSchedulerInternals(runtime.scheduler);

    for (let i = 0; i < 10; i++) {
      schedulerInternal.markDirty(computation);
      await runtime.scheduler.idle();
    }

    await cleanup(runtime, storageManager);
  },
);
