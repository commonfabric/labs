import { assertEquals, assertExists } from "@std/assert";
import {
  type AgentsHostCliDependencies,
  runAgentsHostCli,
} from "../src/cli.ts";
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
