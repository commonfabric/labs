import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import type { GithubClient } from "@commonfabric/github-connector/client";
import type { GithubFabricTarget } from "@commonfabric/github-connector/fabric";
import type { GithubPullRequestCollection } from "@commonfabric/github-connector/types";
import {
  type GithubHostCliDependencies,
  runGithubHostCli,
} from "../src/cli.ts";
import type { GithubFabricRuntime } from "../src/fabric-runtime.ts";
import { GITHUB_HOST_CONFIG_SCHEMA } from "../src/config.ts";

async function writeConfig(
  collectionIntervalMs = 0,
): Promise<{ directory: string; path: string }> {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "github.jsonc");
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      schema: GITHUB_HOST_CONFIG_SCHEMA,
      account: "acme",
      graphqlEndpoint: "https://github.example.test/graphql",
      collectionIntervalMs,
    }),
  );
  return { directory, path };
}

function args(configPath: string, once = false): string[] {
  return [
    "--config",
    configPath,
    "--api-url",
    "https://fabric.example.test",
    "--identity",
    "./operator.key",
    "--space",
    "github-space",
    ...(once ? ["--once"] : []),
  ];
}

class FakeTarget {
  readonly health: object[] = [];
  readonly collections: GithubPullRequestCollection[] = [];

  indexCellId(): string {
    return "index-cell";
  }

  healthCellId(): string {
    return "health-cell";
  }

  readLastComplete(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  readPullRequests(): Promise<[]> {
    return Promise.resolve([]);
  }

  publishHealth(value: object): Promise<void> {
    this.health.push(structuredClone(value));
    return Promise.resolve();
  }

  publish(collection: GithubPullRequestCollection) {
    this.collections.push(structuredClone(collection));
    return Promise.resolve({
      completedAt: collection.observedAt,
      pullRequestCount: collection.pullRequests.length,
    });
  }
}

function harness(options: {
  collect?: GithubClient["collectOpenPullRequests"];
  logs?: string[];
  errors?: string[];
  listeners?: Map<Deno.Signal, () => void>;
  events?: string[];
  scheduleEvery?: GithubHostCliDependencies["scheduleEvery"];
} = {}): {
  dependencies: GithubHostCliDependencies;
  target: FakeTarget;
} {
  const target = new FakeTarget();
  const listeners = options.listeners ?? new Map();
  const events = options.events ?? [];
  const runtime = {
    settled: (rounds?: number) => {
      events.push(`runtime.settled:${rounds}`);
      return Promise.resolve();
    },
    storageManager: {
      synced: () => {
        events.push("runtime.synced");
        return Promise.resolve();
      },
    },
    dispose: () => {
      events.push("runtime.dispose");
      return Promise.resolve();
    },
  };
  const fabric = {
    runtime,
    spaceDid: "did:key:github-space",
    target: target as unknown as GithubFabricTarget,
  } as unknown as GithubFabricRuntime;
  const client = {
    collectOpenPullRequests: options.collect ?? (() =>
      Promise.resolve({
        viewer: "octocat",
        observedAt: "2026-08-26T00:00:00.000Z",
        pullRequests: [],
      })),
  } as GithubClient;
  return {
    target,
    dependencies: {
      readEnv: () => undefined,
      resolveToken: () => Promise.resolve("test-token"),
      openFabric: () => Promise.resolve(fabric),
      acquireProcessLock: () => {
        events.push("lock.acquire");
        return Promise.resolve({
          release: () => {
            events.push("lock.release");
            return Promise.resolve();
          },
        });
      },
      createClient: (token, endpoint) => {
        assertEquals(token, "test-token");
        assertEquals(endpoint, "https://github.example.test/graphql");
        return client;
      },
      addSignalListener: (signal, listener) => {
        listeners.set(signal, listener);
      },
      removeSignalListener: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
      scheduleEvery: options.scheduleEvery ?? (() => () => undefined),
      log: (...values) => options.logs?.push(values.map(String).join(" ")),
      error: (...values) => options.errors?.push(values.map(String).join(" ")),
    },
  };
}

Deno.test("GitHub CLI help exits without opening the host", async () => {
  const logs: string[] = [];
  const { dependencies } = harness({ logs });
  dependencies.openFabric = () => {
    throw new Error("must not open Fabric for help");
  };

  assertEquals(await runGithubHostCli(["--help"], dependencies), 0);
  assertEquals(logs.some((line) => line.includes("github-host")), true);
});

Deno.test("GitHub CLI once mode collects and cleans up", async () => {
  const { directory, path } = await writeConfig();
  const events: string[] = [];
  const logs: string[] = [];
  const { dependencies, target } = harness({ events, logs });
  try {
    assertEquals(await runGithubHostCli(args(path, true), dependencies), 0);
    assertEquals(target.collections.length, 1);
    assertEquals(target.health.at(-1), {
      service: "github-host",
      formatVersion: 1,
      status: "stopped",
      startedAt: (target.health[0] as { startedAt: string }).startedAt,
      updatedAt: (target.health.at(-1) as { updatedAt: string }).updatedAt,
      target: {
        spaceDid: "did:key:github-space",
        cells: { index: "index-cell", health: "health-cell" },
      },
      sync: (target.health.at(-1) as { sync: object }).sync,
      lastComplete: {
        completedAt: "2026-08-26T00:00:00.000Z",
        pullRequestCount: 0,
      },
    });
    assertEquals(events, [
      "lock.acquire",
      "runtime.settled:Infinity",
      "runtime.synced",
      "runtime.dispose",
      "lock.release",
    ]);
    assertEquals(
      logs.some((line) => line.includes("initial GitHub collection completed")),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub CLI returns failure when initial collection fails", async () => {
  const { directory, path } = await writeConfig();
  const errors: string[] = [];
  const events: string[] = [];
  const { dependencies } = harness({
    errors,
    events,
    collect: () => Promise.reject(new Error("GitHub offline")),
  });
  try {
    assertEquals(await runGithubHostCli(args(path, true), dependencies), 1);
    assertEquals(errors.some((line) => line.includes("GitHub offline")), true);
    assertEquals(events.includes("lock.release"), true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub CLI schedules collections and drains on SIGTERM", async () => {
  const { directory, path } = await writeConfig(1234);
  const logs: string[] = [];
  const listeners = new Map<Deno.Signal, () => void>();
  const scheduled = Promise.withResolvers<() => void>();
  const secondCollection = Promise.withResolvers<void>();
  let collections = 0;
  let scheduleCancelled = 0;
  const { dependencies } = harness({
    logs,
    listeners,
    collect: () => {
      collections++;
      if (collections === 2) secondCollection.resolve();
      return Promise.resolve({
        viewer: "octocat",
        observedAt: `2026-08-26T00:00:0${collections}.000Z`,
        pullRequests: [],
      });
    },
    scheduleEvery: (interval, callback) => {
      assertEquals(interval, 1234);
      scheduled.resolve(callback);
      return () => scheduleCancelled++;
    },
  });
  try {
    const running = runGithubHostCli(args(path), dependencies);
    const periodic = await scheduled.promise;
    assertExists(listeners.get("SIGINT"));
    assertExists(listeners.get("SIGTERM"));
    assertExists(listeners.get("SIGHUP"));

    periodic();
    await secondCollection.promise;
    listeners.get("SIGHUP")?.();
    listeners.get("SIGTERM")?.();

    assertEquals(await running, 0);
    assertEquals(collections >= 2, true);
    assertEquals(scheduleCancelled, 1);
    assertEquals(listeners.size, 0);
    assertEquals(logs.some((line) => line.includes("SIGTERM received")), true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub CLI reports setup and cleanup failures", async () => {
  const errors: string[] = [];
  const { dependencies } = harness({ errors });
  dependencies.openFabric = () => Promise.reject("fabric unavailable");
  assertEquals(await runGithubHostCli([], dependencies), 1);
  assertEquals(
    errors.some((line) => line.includes("missing required option")),
    true,
  );

  const { directory, path } = await writeConfig();
  const cleanup = harness({ errors });
  cleanup.dependencies.acquireProcessLock = () =>
    Promise.resolve({
      release: () => Promise.reject(new Error("lock cleanup failed")),
    });
  const fabric = await cleanup.dependencies.openFabric({} as never);
  fabric.runtime.settled = () => Promise.reject(new Error("settle failed"));
  fabric.runtime.storageManager.synced = () =>
    Promise.reject(new Error("sync failed"));
  fabric.runtime.dispose = () => Promise.reject(new Error("dispose failed"));
  try {
    assertEquals(
      await runGithubHostCli(args(path, true), cleanup.dependencies),
      0,
    );
    assertEquals(errors.some((line) => line.includes("settle failed")), true);
    assertEquals(errors.some((line) => line.includes("sync failed")), true);
    assertEquals(errors.some((line) => line.includes("dispose failed")), true);
    assertEquals(
      errors.some((line) => line.includes("lock cleanup failed")),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
