import type { AgentFabricRuntime } from "../src/fabric-runtime.ts";
import type { AgentsHost } from "../src/host.ts";
import type { AgentsHostProcessLock } from "../src/process-lock.ts";
import {
  RunningAgentsHost,
  startAgentsHost,
  type StartAgentsHostDependencies,
} from "../src/start.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import type { CommandLedger } from "@commonfabric/agents-connector/command-ledger";
import type { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";

Deno.test("RunningAgentsHost settles runtime work before disposal", async () => {
  const events: string[] = [];
  const host = {
    stop: () => {
      events.push("host.stop");
      return Promise.resolve();
    },
  } as unknown as AgentsHost;
  const fabric = {
    graphRuntime: {
      dispose: () => {
        events.push("graph-runtime.dispose");
        return Promise.resolve();
      },
    },
    runtime: {
      settled: (rounds?: number) => {
        events.push(`runtime.settled:${rounds}`);
        return Promise.resolve();
      },
      storageManager: {
        synced: () => {
          events.push("storage.synced");
          return Promise.resolve();
        },
      },
      dispose: () => {
        events.push("runtime.dispose");
        return Promise.resolve();
      },
    },
    spaceDid: "did:key:test",
  } as unknown as AgentFabricRuntime;
  const processLocks = [{
    release: () => {
      events.push("lock.release");
      return Promise.resolve();
    },
  }] as unknown as AgentsHostProcessLock[];
  const running = new RunningAgentsHost({
    host,
    fabric,
    initialSessionCount: 0,
    ledgerPath: "/tmp/agents-host-test-ledger",
    processLocks,
  });

  await running.stop();

  assertEquals(events, [
    "host.stop",
    "runtime.settled:Infinity",
    "storage.synced",
    "graph-runtime.dispose",
    "runtime.dispose",
    "lock.release",
  ]);
});

Deno.test("RunningAgentsHost reports every shutdown failure", async () => {
  const host = {
    stop: () => Promise.reject(new Error("host stop failed")),
  } as unknown as AgentsHost;
  const fabric = {
    graphRuntime: {
      dispose: () => Promise.reject(new Error("graph dispose failed")),
    },
    runtime: {
      settled: () => Promise.reject(new Error("settle failed")),
      storageManager: {
        synced: () => Promise.reject(new Error("sync failed")),
      },
      dispose: () => Promise.reject(new Error("dispose failed")),
    },
    spaceDid: "did:key:test",
  } as unknown as AgentFabricRuntime;
  const running = new RunningAgentsHost({
    host,
    fabric,
    initialSessionCount: 0,
    ledgerPath: "/tmp/agents-host-test-ledger",
    processLocks: [{
      release: () => Promise.reject(new Error("lock release failed")),
    }] as unknown as AgentsHostProcessLock[],
  });

  const first = running.stop("test-shutdown");
  assertEquals(running.stop(), first);
  await assertRejects(
    () => first,
    AggregateError,
    "host stop failed; settle failed; sync failed; graph dispose failed; dispose failed; lock release failed",
  );
});

function startHarness(options: {
  events?: string[];
  hostStart?: (
    options: Parameters<AgentsHost["start"]>[0],
  ) => Promise<number>;
  hostStop?: AgentsHost["stop"];
  claimStorage?: () => Promise<void>;
  commandsAreBound?: () => boolean;
  runtimeSettled?: () => Promise<void>;
  graphRuntimeDispose?: () => Promise<void>;
  runtimeDispose?: () => Promise<void>;
  releaseLock?: (path: string) => Promise<void>;
} = {}): {
  dependencies: StartAgentsHostDependencies;
  events: string[];
} {
  const events = options.events ?? [];
  const target = {
    claimStorage: options.claimStorage ?? (() => {
      events.push("target.claimStorage");
      return Promise.resolve();
    }),
    commandsAreBound: options.commandsAreBound ?? (() => true),
  } as unknown as AgentFabricTarget;
  const fabric = {
    graphRuntime: {
      dispose: options.graphRuntimeDispose ?? (() => {
        events.push("graph-runtime.dispose");
        return Promise.resolve();
      }),
    },
    runtime: {
      settled: options.runtimeSettled ?? (() => {
        events.push("runtime.settled");
        return Promise.resolve();
      }),
      storageManager: { synced: () => Promise.resolve() },
      dispose: options.runtimeDispose ?? (() => {
        events.push("runtime.dispose");
        return Promise.resolve();
      }),
    },
    manager: {},
    target,
    spaceDid: "did:key:space",
    ownerDid: "did:key:owner",
  } as unknown as AgentFabricRuntime;
  const host = {
    start: options.hostStart ?? (() => {
      events.push("host.start");
      return Promise.resolve(3);
    }),
    stop: options.hostStop ?? ((reason: string) => {
      events.push(`host.stop:${reason}`);
      return Promise.resolve();
    }),
  } as unknown as AgentsHost;
  return {
    events,
    dependencies: {
      openFabric: () => {
        events.push("fabric.open");
        return Promise.resolve(fabric);
      },
      targetLockPath: () => Promise.resolve("/state/target.lock"),
      acquireProcessLock: (path) => {
        events.push(`lock.acquire:${path}`);
        return Promise.resolve({
          release: () => {
            events.push(`lock.release:${path}`);
            return options.releaseLock?.(path) ?? Promise.resolve();
          },
        });
      },
      ledgerPath: () => Promise.resolve("/state/ledger.json"),
      deployDebugView: () => {
        events.push("debug.deploy");
        return Promise.resolve("debug-piece");
      },
      bindCommandProducers: (_manager, _target, producers) => {
        events.push(`producers.bind:${producers.map((p) => p.id).join(",")}`);
        return Promise.resolve(producers.map((producer) => ({
          id: producer.id,
          piece: producer.piece,
          commandCellId: `queue-${producer.id}`,
        })));
      },
      openLedger: () => {
        events.push("ledger.open");
        return Promise.resolve({} as CommandLedger);
      },
      describeTarget: () => ({}) as never,
      createHost: () => host,
    },
  };
}

function startOptions(signal?: AbortSignal) {
  return {
    apiUrl: "https://fabric.example.test",
    identityPath: "/identity.key",
    ownerDid: "did:key:owner",
    space: "agent-space",
    sources: [],
    signal,
  };
}

Deno.test("startAgentsHost opens the target and returns a stoppable host", async () => {
  const { dependencies, events } = startHarness();
  const running = await startAgentsHost(startOptions(), dependencies);

  assertEquals(running.initialSessionCount, 3);
  assertEquals(running.debugPieceId, "debug-piece");
  assertEquals(running.ledgerPath, "/state/ledger.json");
  assertEquals(running.spaceDid, "did:key:space");
  await running.stop("finished");
  assertEquals(events, [
    "fabric.open",
    "lock.acquire:/state/target.lock",
    "target.claimStorage",
    "lock.acquire:/state/ledger.json.lock",
    "debug.deploy",
    "ledger.open",
    "host.start",
    "host.stop:finished",
    "runtime.settled",
    "graph-runtime.dispose",
    "runtime.dispose",
    "lock.release:/state/ledger.json.lock",
    "lock.release:/state/target.lock",
  ]);
});

Deno.test("startAgentsHost can finish startup after health ownership", async () => {
  const releaseStart = Promise.withResolvers<number>();
  const ownership = Promise.withResolvers<void>();
  const harness = startHarness({
    hostStart: (options) => {
      options?.onHealthOwnership?.();
      ownership.resolve();
      return releaseStart.promise;
    },
  });

  const starting = startAgentsHost(
    { ...startOptions(), debugView: false, acceptCommands: false },
    harness.dependencies,
  );
  await ownership.promise;
  releaseStart.resolve(7);
  const running = await starting;

  assertEquals(running.initialSessionCount, 7);
  assertEquals(running.debugPieceId, undefined);
  assertEquals(harness.events.includes("debug.deploy"), false);
  await running.stop();
});

Deno.test("startAgentsHost cleans up a failed storage claim", async () => {
  const harness = startHarness({
    claimStorage: () => Promise.reject(new Error("storage claim failed")),
  });

  await assertRejects(
    () => startAgentsHost(startOptions(), harness.dependencies),
    Error,
    "storage claim failed",
  );
  assertEquals(harness.events, [
    "fabric.open",
    "lock.acquire:/state/target.lock",
    "runtime.settled",
    "graph-runtime.dispose",
    "runtime.dispose",
    "lock.release:/state/target.lock",
  ]);
});

Deno.test("startAgentsHost cancels unowned startup work", async () => {
  const controller = new AbortController();
  const hostStarted = Promise.withResolvers<void>();
  const harness = startHarness({
    hostStart: (options) => {
      hostStarted.resolve();
      const signal = options?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      });
    },
    hostStop: (reason, options) => {
      harness.events.push(`host.stop:${reason}:${options?.publishHealth}`);
      return Promise.resolve();
    },
  });
  const reason = new Error("cancel startup");
  const starting = startAgentsHost(
    startOptions(controller.signal),
    harness.dependencies,
  );
  await hostStarted.promise;
  controller.abort(reason);

  await assertRejects(() => starting, Error, "cancel startup");
  assertEquals(
    harness.events.includes("host.stop:startup-cancelled:false"),
    true,
  );
  assertEquals(harness.events.includes("runtime.dispose"), true);
  expect(harness.events).toContain("graph-runtime.dispose");
});

Deno.test("startAgentsHost reports cleanup failures with startup failure", async () => {
  const harness = startHarness({
    claimStorage: () => Promise.reject(new Error("storage claim failed")),
    runtimeSettled: () => Promise.reject(new Error("settle failed")),
    graphRuntimeDispose: () =>
      Promise.reject(new Error("graph dispose failed")),
    runtimeDispose: () => Promise.reject(new Error("dispose failed")),
    releaseLock: () => Promise.reject(new Error("unlock failed")),
  });

  await assertRejects(
    () => startAgentsHost(startOptions(), harness.dependencies),
    AggregateError,
    "storage claim failed; settle failed; graph dispose failed; dispose failed; unlock failed",
  );
});

Deno.test("startAgentsHost reports every unowned cancellation failure", async () => {
  const controller = new AbortController();
  const hostStarted = Promise.withResolvers<void>();
  const harness = startHarness({
    hostStart: (options) => {
      hostStarted.resolve();
      const signal = options?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            void Promise.resolve().then(() => Promise.resolve()).then(() => {
              reject(new Error("startup task failed while cancelling"));
            });
          },
          { once: true },
        );
      });
    },
    hostStop: () => Promise.reject(new Error("host stop failed")),
    runtimeSettled: () => Promise.reject(new Error("settle failed")),
    graphRuntimeDispose: () =>
      Promise.reject(new Error("graph dispose failed")),
    runtimeDispose: () => Promise.reject(new Error("dispose failed")),
  });
  const starting = startAgentsHost(
    startOptions(controller.signal),
    harness.dependencies,
  );
  await hostStarted.promise;
  controller.abort(new Error("cancel startup"));

  await assertRejects(
    () => starting,
    AggregateError,
    "cancel startup; startup task failed while cancelling; host stop failed; settle failed; graph dispose failed; dispose failed",
  );
});

Deno.test("startAgentsHost drains owned startup work after cancellation", async () => {
  const controller = new AbortController();
  const ownership = Promise.withResolvers<void>();
  const harness = startHarness({
    hostStart: (options) => {
      options?.onHealthOwnership?.();
      ownership.resolve();
      const signal = options?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("owned startup task failed")),
          { once: true },
        );
      });
    },
    hostStop: () => Promise.reject(new Error("owned host stop failed")),
  });
  const starting = startAgentsHost(
    startOptions(controller.signal),
    harness.dependencies,
  );
  await ownership.promise;
  controller.abort(new Error("cancel owned startup"));

  await assertRejects(
    () => starting,
    AggregateError,
    "cancel owned startup; owned host stop failed",
  );
});

Deno.test("startAgentsHost binds configured command producers and accepts their commands without a debug view", async () => {
  let bound = false;
  let acceptCommands: boolean | undefined;
  const harness = startHarness({
    commandsAreBound: () => bound,
    hostStart: (options) => {
      acceptCommands = options?.acceptCommands;
      return Promise.resolve(0);
    },
  });
  const originalBind = harness.dependencies.bindCommandProducers;
  harness.dependencies.bindCommandProducers = async (...args) => {
    const producers = await originalBind(...args);
    bound = true;
    return producers;
  };

  const running = await startAgentsHost(
    {
      ...startOptions(),
      debugView: false,
      commandProducers: [{ id: "workbench", piece: "piece-1" }],
    },
    harness.dependencies,
  );

  assertEquals(running.debugPieceId, undefined);
  assertEquals(running.commandProducers, [{
    id: "workbench",
    piece: "piece-1",
    commandCellId: "queue-workbench",
  }]);
  assertEquals(acceptCommands, true);
  assertEquals(harness.events.includes("producers.bind:workbench"), true);
  await running.stop();
});

Deno.test("startAgentsHost accepts no commands when nothing bound a queue", async () => {
  let acceptCommands: boolean | undefined;
  const harness = startHarness({
    commandsAreBound: () => false,
    hostStart: (options) => {
      acceptCommands = options?.acceptCommands;
      return Promise.resolve(0);
    },
  });

  const running = await startAgentsHost(
    { ...startOptions(), debugView: false },
    harness.dependencies,
  );

  assertEquals(running.commandProducers, []);
  assertEquals(acceptCommands, false);
  assertEquals(
    harness.events.some((event) => event.startsWith("producers.bind")),
    false,
  );
  await running.stop();
});
