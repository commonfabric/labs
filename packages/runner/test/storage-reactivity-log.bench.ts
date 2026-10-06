import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  ignoreReadForScheduling,
  markReadAsAttemptedWrite,
} from "../src/storage/reactivity-log.ts";
import { txToReactivityLog } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("storage-reactivity-log-bench");
const space = signer.did();

const setup = () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  return { storageManager, runtime };
};

const cleanup = async (
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await runtime.dispose();
  await storageManager.close();
};

Deno.bench(
  "Storage reactivity log - txToReactivityLog after mixed activity",
  async () => {
    const { runtime, storageManager } = setup();
    try {
      const tx = runtime.edit();
      tx.writeValueOrThrow({
        space,
        scope: "space",
        id: "of:reactivity-log-bench",
        path: [],
      }, {
        count: 0,
        nested: { value: 1, label: "bench" },
        list: Array.from({ length: 10 }, (_, index) => ({ index })),
      });

      for (let index = 0; index < 50; index += 1) {
        tx.readValueOrThrow({
          space,
          scope: "space",
          id: "of:reactivity-log-bench",
          path: ["count"],
        });
        tx.read({
          space,
          scope: "space",
          id: "of:reactivity-log-bench",
          path: ["nested", "value"],
        }, { nonRecursive: true });
        tx.read({
          space,
          scope: "space",
          id: "of:reactivity-log-bench",
          path: ["nested"],
        }, { meta: ignoreReadForScheduling });
        tx.read({
          space,
          scope: "space",
          id: "of:reactivity-log-bench",
          path: ["list"],
        }, { meta: markReadAsAttemptedWrite });
        tx.writeValueOrThrow({
          space,
          scope: "space",
          id: "of:reactivity-log-bench",
          path: ["count"],
        }, index);
      }

      txToReactivityLog(tx);
      await tx.commit().settled;
    } finally {
      await cleanup(runtime, storageManager);
    }
  },
);

Deno.bench(
  "Storage reactivity log - repeated direct hook reads",
  async () => {
    const { runtime, storageManager } = setup();
    try {
      const tx = runtime.edit();
      tx.writeValueOrThrow({
        space,
        scope: "space",
        id: "of:reactivity-log-repeat",
        path: [],
      }, {
        count: 0,
        nested: { value: 1 },
      });

      for (let index = 0; index < 50; index += 1) {
        tx.readValueOrThrow({
          space,
          scope: "space",
          id: "of:reactivity-log-repeat",
          path: ["nested", "value"],
        });
        tx.writeValueOrThrow({
          space,
          scope: "space",
          id: "of:reactivity-log-repeat",
          path: ["count"],
        }, index);
      }

      for (let index = 0; index < 100; index += 1) {
        tx.getReactivityLog?.();
      }

      await tx.commit().settled;
    } finally {
      await cleanup(runtime, storageManager);
    }
  },
);
