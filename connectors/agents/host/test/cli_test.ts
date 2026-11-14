import { assertEquals, assertExists } from "@std/assert";
import {
  type AgentsHostCliDependencies,
  defaultAgentsHostCliDependencies,
  runAgentsHostCli,
} from "../src/cli.ts";
import { AGENTS_HOST_USAGE } from "../src/cli-options.ts";
import type { RunningAgentsHost } from "../src/start.ts";
import { join } from "@std/path";

async function writeConfig(
  collectionIntervalMs?: number,
): Promise<{ directory: string; path: string }> {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agents.jsonc");
  const interval = collectionIntervalMs === undefined
    ? {}
    : { collectionIntervalMs };
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      schema: "commonfabric.agents-host.config",
      ownerDid: "did:key:test-owner",
      ...interval,
      sources: [{
        id: "codex",
        driver: "codex-app-server",
        enabled: true,
      }],
    }),
  );
  return { directory, path };
}

function args(configPath: string): string[] {
  return [
    "--config",
    configPath,
    "--api-url",
    "https://fabric.example.test",
    "--identity",
    "./operator.key",
    "--space",
    "agent-space",
  ];
}

function fakeRunningHost(options: {
  stop: (reason?: string) => Promise<void>;
  synchronize?: (reason?: string) => Promise<number>;
  commandProducers?: RunningAgentsHost["commandProducers"];
}): RunningAgentsHost {
  return {
    initialSessionCount: 2,
    spaceDid: "did:key:space",
    debugPieceId: "debug-piece",
    commandProducers: options.commandProducers ?? [],
    ledgerPath: "/state/command-ledger.json",
    host: {
      health: () => ({
        target: {
          cells: {
            commands: "command-cell",
            receipts: "receipt-cell",
          },
        },
      }),
      synchronize: options.synchronize ?? (() => Promise.resolve(2)),
    },
    stop: options.stop,
  } as unknown as RunningAgentsHost;
}

function dependencies(options: {
  start: AgentsHostCliDependencies["start"];
  logs?: string[];
  errors?: string[];
  listeners?: Map<Deno.Signal, () => void>;
  scheduleEvery?: AgentsHostCliDependencies["scheduleEvery"];
}): AgentsHostCliDependencies {
  const listeners = options.listeners ?? new Map();
  return {
    readEnv: () => undefined,
    start: options.start,
    addSignalListener: (signal, listener) => {
      listeners.set(signal, listener);
    },
    removeSignalListener: (signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
    scheduleEvery: options.scheduleEvery ?? (() => () => undefined),
    log: (...values) => options.logs?.push(values.map(String).join(" ")),
    error: (...values) => options.errors?.push(values.map(String).join(" ")),
  };
}

Deno.test("SIGTERM drains a running host without aborting its owner signal", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const ready = Promise.withResolvers<void>();
    const stopped: Array<string | undefined> = [];
    let ownerSignal: AbortSignal | undefined;
    const running = fakeRunningHost({
      stop: (reason) => {
        stopped.push(reason);
        return Promise.resolve();
      },
    });
    const deps = dependencies({
      listeners,
      logs: [],
      start: ((options) => {
        ownerSignal = options.signal;
        return Promise.resolve(running);
      }) as AgentsHostCliDependencies["start"],
    });
    const originalLog = deps.log;
    deps.log = (...values) => {
      originalLog(...values);
      if (String(values[0]).startsWith("Ready;")) ready.resolve();
    };

    const result = runAgentsHostCli(args(path), deps);
    await ready.promise;
    assertExists(ownerSignal);
    assertEquals(ownerSignal.aborted, false);
    listeners.get("SIGTERM")?.();
    assertEquals(ownerSignal.aborted, false);

    assertEquals(await result, 0);
    assertEquals(stopped, ["SIGTERM"]);
    assertEquals(listeners.size, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the CLI reports each bound command producer", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const ready = Promise.withResolvers<void>();
    const logs: string[] = [];
    const running = fakeRunningHost({
      stop: () => Promise.resolve(),
      commandProducers: [{
        id: "workbench",
        piece: "fid1:workbench",
        commandCellId: "fid1:workbench-commands",
      }],
    });
    const deps = dependencies({
      listeners,
      logs,
      start: (() =>
        Promise.resolve(running)) as AgentsHostCliDependencies["start"],
    });
    const originalLog = deps.log;
    deps.log = (...values) => {
      originalLog(...values);
      if (String(values[0]).startsWith("Ready;")) ready.resolve();
    };

    const result = runAgentsHostCli(args(path), deps);
    await ready.promise;
    listeners.get("SIGTERM")?.();

    assertEquals(await result, 0);
    assertEquals(
      logs.filter((line) => line.startsWith("Command producer ")),
      [
        "Command producer workbench: fid1:workbench-commands (piece fid1:workbench)",
      ],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SIGINT aborts host startup and removes signal listeners", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const started = Promise.withResolvers<AbortSignal>();
    const deps = dependencies({
      listeners,
      start: ((options) => {
        const signal = options.signal!;
        started.resolve(signal);
        return new Promise((_resolve, reject) => {
          const rejectForAbort = () => reject(signal.reason);
          if (signal.aborted) rejectForAbort();
          else signal.addEventListener("abort", rejectForAbort, { once: true });
        });
      }) as AgentsHostCliDependencies["start"],
    });

    const result = runAgentsHostCli(args(path), deps);
    const ownerSignal = await started.promise;
    listeners.get("SIGINT")?.();

    assertEquals(await result, 0);
    assertEquals(ownerSignal.aborted, true);
    assertEquals(listeners.size, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a startup failure after a signal returns a failing exit code", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const started = Promise.withResolvers<AbortSignal>();
    const errors: string[] = [];
    const deps = dependencies({
      listeners,
      errors,
      start: ((options) => {
        const signal = options.signal!;
        started.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("startup cleanup rejected")),
            { once: true },
          );
        });
      }) as AgentsHostCliDependencies["start"],
    });

    const result = runAgentsHostCli(args(path), deps);
    await started.promise;
    listeners.get("SIGINT")?.();

    assertEquals(await result, 1);
    assertEquals(
      errors.some((message) => message.includes("startup cleanup rejected")),
      true,
    );
    assertEquals(listeners.size, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a signal-driven shutdown failure returns a failing exit code", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const ready = Promise.withResolvers<void>();
    const errors: string[] = [];
    const running = fakeRunningHost({
      stop: () => Promise.reject(new Error("final health failed")),
    });
    const deps = dependencies({
      listeners,
      errors,
      start: (() =>
        Promise.resolve(running)) as AgentsHostCliDependencies["start"],
    });
    const originalLog = deps.log;
    deps.log = (...values) => {
      originalLog(...values);
      if (String(values[0]).startsWith("Ready;")) ready.resolve();
    };

    const result = runAgentsHostCli(args(path), deps);
    await ready.promise;
    listeners.get("SIGTERM")?.();

    assertEquals(await result, 1);
    assertEquals(
      errors.some((message) => message.includes("final health failed")),
      true,
    );
    assertEquals(listeners.size, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("long-running mode requests periodic collection and cancels its schedule", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const ready = Promise.withResolvers<void>();
    const scheduled = Promise.withResolvers<() => void>();
    const collection = Promise.withResolvers<string | undefined>();
    let scheduleCancelled = 0;
    const running = fakeRunningHost({
      stop: () => Promise.resolve(),
      synchronize: (reason) => {
        collection.resolve(reason);
        return Promise.resolve(3);
      },
    });
    const deps = dependencies({
      listeners,
      logs: [],
      scheduleEvery: (intervalMs, callback) => {
        assertEquals(intervalMs, 15 * 60 * 1_000);
        scheduled.resolve(callback);
        return () => scheduleCancelled++;
      },
      start: (() =>
        Promise.resolve(running)) as AgentsHostCliDependencies["start"],
    });
    const originalLog = deps.log;
    deps.log = (...values) => {
      originalLog(...values);
      if (String(values[0]).startsWith("Ready;")) ready.resolve();
    };

    const result = runAgentsHostCli(args(path), deps);
    await ready.promise;
    const tick = await scheduled.promise;
    tick();
    assertEquals(await collection.promise, "periodic");
    listeners.get("SIGTERM")?.();

    assertEquals(await result, 0);
    assertEquals(scheduleCancelled, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a zero collection interval disables periodic collection", async () => {
  const { directory, path } = await writeConfig(0);
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const ready = Promise.withResolvers<void>();
    const running = fakeRunningHost({
      stop: () => Promise.resolve(),
    });
    const deps = dependencies({
      listeners,
      logs: [],
      scheduleEvery: () => {
        throw new Error("periodic collection should remain disabled");
      },
      start: (() =>
        Promise.resolve(running)) as AgentsHostCliDependencies["start"],
    });
    const originalLog = deps.log;
    deps.log = (...values) => {
      originalLog(...values);
      if (String(values[0]).startsWith("Ready;")) ready.resolve();
    };

    const result = runAgentsHostCli(args(path), deps);
    await ready.promise;
    listeners.get("SIGTERM")?.();

    assertEquals(await result, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("shutdown starts while an active periodic collection drains", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const ready = Promise.withResolvers<void>();
    const scheduled = Promise.withResolvers<() => void>();
    const collectionStarted = Promise.withResolvers<void>();
    const releaseCollection = Promise.withResolvers<void>();
    const stopCalled = Promise.withResolvers<void>();
    const running = fakeRunningHost({
      stop: () => {
        stopCalled.resolve();
        return Promise.resolve();
      },
      synchronize: async () => {
        collectionStarted.resolve();
        await releaseCollection.promise;
        return 3;
      },
    });
    const deps = dependencies({
      listeners,
      logs: [],
      scheduleEvery: (_intervalMs, callback) => {
        scheduled.resolve(callback);
        return () => undefined;
      },
      start: (() =>
        Promise.resolve(running)) as AgentsHostCliDependencies["start"],
    });
    const originalLog = deps.log;
    deps.log = (...values) => {
      originalLog(...values);
      if (String(values[0]).startsWith("Ready;")) ready.resolve();
    };

    const result = runAgentsHostCli(args(path), deps);
    await ready.promise;
    const tick = await scheduled.promise;
    tick();
    await collectionStarted.promise;
    listeners.get("SIGTERM")?.();
    await stopCalled.promise;
    releaseCollection.resolve();

    assertEquals(await result, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("--help prints the usage and starts no host", async () => {
  const logs: string[] = [];
  const deps = dependencies({
    logs,
    start: (() => {
      throw new Error("help must not start a host");
    }) as AgentsHostCliDependencies["start"],
  });

  assertEquals(await runAgentsHostCli(["--help"], deps), 0);
  assertEquals(logs, [AGENTS_HOST_USAGE]);
});

Deno.test("--once publishes one collection and stops without commands", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const logs: string[] = [];
    const stopped: Array<string | undefined> = [];
    let acceptCommands: boolean | undefined;
    const running = fakeRunningHost({
      stop: (reason) => {
        stopped.push(reason);
        return Promise.resolve();
      },
    });
    const deps = dependencies({
      listeners,
      logs,
      scheduleEvery: () => {
        throw new Error("a single collection must not schedule more");
      },
      start: ((options) => {
        acceptCommands = options.acceptCommands;
        return Promise.resolve(running);
      }) as AgentsHostCliDependencies["start"],
    });

    assertEquals(await runAgentsHostCli([...args(path), "--once"], deps), 0);
    assertEquals(acceptCommands, false);
    assertEquals(stopped, ["once-complete"]);
    assertEquals(logs.includes("Debug view piece: debug-piece"), true);
    assertEquals(logs.some((line) => line.startsWith("Ready;")), false);
    assertEquals(listeners.size, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SIGHUP queues at most one follow-up collection after startup", async () => {
  const { directory, path } = await writeConfig(0);
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const logs: string[] = [];
    const errors: string[] = [];
    const reasons: Array<string | undefined> = [];
    const firstCollection = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondCollection = Promise.withResolvers<void>();
    const running = fakeRunningHost({
      stop: () => Promise.resolve(),
      synchronize: async (reason) => {
        reasons.push(reason);
        if (reasons.length === 1) {
          firstCollection.resolve();
          await releaseFirst.promise;
          return 4;
        }
        secondCollection.resolve();
        throw new Error("provider unavailable");
      },
    });
    const deps = dependencies({
      listeners,
      logs,
      errors,
      start: (async () => {
        startEntered.resolve();
        await releaseStart.promise;
        return running;
      }) as AgentsHostCliDependencies["start"],
    });
    const originalLog = deps.log;
    deps.log = (...values) => {
      originalLog(...values);
      if (String(values[0]).startsWith("Ready;")) ready.resolve();
    };

    const result = runAgentsHostCli(args(path), deps);
    await startEntered.promise;
    listeners.get("SIGHUP")?.();
    assertEquals(logs, ["Ignoring SIGHUP while startup is still in progress"]);
    releaseStart.resolve();
    await ready.promise;

    listeners.get("SIGHUP")?.();
    await firstCollection.promise;
    listeners.get("SIGHUP")?.();
    listeners.get("SIGHUP")?.();
    assertEquals(
      logs.filter((line) => line.startsWith("SIGHUP received")),
      [
        "SIGHUP received; one follow-up full collection is pending",
        "SIGHUP received; the pending full collection already covers it",
      ],
    );
    releaseFirst.resolve();
    await secondCollection.promise;
    listeners.get("SIGTERM")?.();

    assertEquals(await result, 0);
    assertEquals(reasons, ["SIGHUP", "SIGHUP"]);
    assertEquals(
      logs.includes("SIGHUP collection completed with 4 sessions"),
      true,
    );
    assertEquals(errors, [
      "SIGHUP collection failed: Error: provider unavailable",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a failure after startup stops the host and reports both failures", async () => {
  const { directory, path } = await writeConfig();
  try {
    const listeners = new Map<Deno.Signal, () => void>();
    const errors: string[] = [];
    const stopped: Array<string | undefined> = [];
    const running = fakeRunningHost({
      stop: (reason) => {
        stopped.push(reason);
        return Promise.reject(new Error("cleanup rejected"));
      },
    });
    running.host.health = () => {
      throw new Error("health unavailable");
    };
    const deps = dependencies({
      listeners,
      errors,
      start: (() =>
        Promise.resolve(running)) as AgentsHostCliDependencies["start"],
    });

    assertEquals(await runAgentsHostCli(args(path), deps), 1);
    assertEquals(stopped, ["cli-error"]);
    assertEquals(errors, [
      "Agent host cleanup failed: Error: cleanup rejected",
      "Agent host failed: health unavailable",
    ]);
    assertEquals(listeners.size, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the default schedule repeats until it is cancelled", async () => {
  // The test's resource sanitizer fails the test if the interval outlives
  // the cancellation.
  const twoTicks = Promise.withResolvers<void>();
  let ticks = 0;
  const cancel = defaultAgentsHostCliDependencies.scheduleEvery(1, () => {
    ticks++;
    if (ticks === 2) twoTicks.resolve();
  });
  await twoTicks.promise;
  cancel();
});
