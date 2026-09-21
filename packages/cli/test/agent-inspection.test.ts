import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { renderCellReference } from "@commonfabric/runner/shared";

import {
  type AgentInspectionDeps,
  cancelAgentRun,
  readAgentRun,
  readAgentRuns,
  selectAgentRun,
} from "../lib/agent-inspection.ts";

const HOME_HOST = "https://home.example";
const OTHER_HOST = "https://other.example";

describe("agent-inspection", () => {
  let home: `did:key:${string}`;
  let runtimes: Map<string, Runtime>;
  let managers: ReturnType<typeof StorageManager.emulate>[];
  let deps: AgentInspectionDeps;
  const config = { identity: "/test.key", apiUrl: HOME_HOST };

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(crypto.randomUUID());
    home = signer.did();
    managers = [];
    runtimes = new Map();
    for (const host of [HOME_HOST, OTHER_HOST]) {
      const storageManager = StorageManager.emulate({ as: signer });
      managers.push(storageManager);
      runtimes.set(
        host,
        new Runtime({ apiUrl: new URL(host), storageManager }),
      );
    }
    deps = {
      loadIdentity: () => Promise.resolve(signer),
      loadPieces: ({ apiUrl }) =>
        Promise.resolve({
          runtime: runtimes.get(apiUrl)!,
          getSpace: () => home,
        }),
      openHost: (_identity, host) => Promise.resolve(runtimes.get(host)!),
      now: () => new Date("2026-09-20T12:00:00Z"),
    };
  });

  afterEach(async () => {
    for (const runtime of runtimes.values()) await runtime.dispose();
    for (const manager of managers) await manager.close();
  });

  const seed = async () => {
    const remote = runtimes.get(OTHER_HOST)!;
    const completed = remote.getCell(home, "completed-run");
    const result = remote.getCell(home, "private-result");
    await remote.editWithRetry((tx) => {
      result.withTx(tx).set({ secret: "must never be rendered" });
      completed.withTx(tx).set({
        request: remote.getCell(home, "request"),
        piece: remote.getCell(home, "piece"),
        space: remote.getCell(home, home),
        inputs: {},
        resultSchema: true,
        requestHash: "hash-completed",
        task: "Recommend a book",
        state: "completed",
        stateSince: "2026-09-20T10:01:00Z",
        submittedAt: "2026-09-20T10:00:00Z",
        outcome: "completed",
        result,
        usage: {
          costUsd: 0.12,
          estimatedCostUsd: 0.09,
          estimateWithheldReason: "partial_usage",
        },
      });
    });
    const runtime = runtimes.get(HOME_HOST)!;
    const queued = runtime.getCell(home, "queued-run");
    await runtime.editWithRetry((tx) => {
      queued.withTx(tx).set({
        request: runtime.getCell(home, "request"),
        piece: runtime.getCell(home, "piece"),
        space: runtime.getCell(home, home),
        inputs: {},
        resultSchema: true,
        requestHash: "hash-queued",
        task: "Find more books",
        state: "queued",
        submittedAt: "2026-09-20T11:00:00Z",
        stateSince: "2026-09-20T11:00:00Z",
      });
      const homePattern = runtime.getCell(home, "home-pattern", undefined, tx);
      homePattern.set({
        agentQueue: {
          entries: [
            { run: completed, host: OTHER_HOST },
            { run: queued, host: HOME_HOST },
          ],
        },
      });
      runtime.getHomeSpaceCell(tx).key("defaultPattern").set(homePattern);
    });
    return { completed, queued, result };
  };

  it("reads cross-host records through the home wish and keeps result payloads as addresses", async () => {
    const { result } = await seed();
    const runs = await readAgentRuns(config, deps);

    expect(runs.map((run) => run.state)).toEqual(["completed", "queued"]);
    expect(runs[0].result).toBe(
      renderCellReference(result.getAsNormalizedFullLink()),
    );
    expect(runs[0].usage).toEqual({
      costUsd: 0.12,
      estimatedCostUsd: 0.09,
      estimateWithheldReason: "partial_usage",
    });
    expect(JSON.stringify(runs)).not.toContain("must never be rendered");
    expect(selectAgentRun(runs, "hash-queued").state).toBe("queued");
  });

  it("uses the full connection only for the home deployment", async () => {
    await seed();
    const fullConnections: string[] = [];
    const load = deps.loadPieces;
    deps.loadPieces = (options) => {
      fullConnections.push(options.apiUrl);
      return load(options);
    };

    await readAgentRuns(config, deps);

    expect(fullConnections).toEqual([HOME_HOST]);
  });

  it("writes a durable cancellation timestamp without changing a queued state", async () => {
    await seed();
    const run = await cancelAgentRun(config, "hash-queued", deps);

    expect(run.cancelRequestedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(run.state).toBe("queued");
  });

  it("cancels a running record on the toolshed named by its queue entry", async () => {
    const { completed } = await seed();
    await runtimes.get(OTHER_HOST)!.editWithRetry((tx) => {
      completed.withTx(tx).key("state").set("running");
      completed.withTx(tx).key("outcome").set(undefined);
    });

    const run = await cancelAgentRun(config, "hash-completed", deps);

    expect(run.host).toBe(OTHER_HOST);
    expect(run.state).toBe("running");
    expect(run.cancelRequestedAt).toBe("2026-09-20T12:00:00.000Z");
  });

  it("reads an exact record without opening an unrelated unavailable host", async () => {
    const { queued } = await seed();
    const address = renderCellReference(queued.getAsNormalizedFullLink());
    const homeRuntime = runtimes.get(HOME_HOST)!;
    await homeRuntime.editWithRetry((tx) => {
      homeRuntime.getCell(home, "home-pattern", undefined, tx)
        .key("agentQueue").key("entries").key(0).key("host").set("not a url");
    });
    deps.openHost = () => Promise.reject(new Error("stale toolshed"));

    const run = await readAgentRun(config, address, deps);

    expect(run.id).toBe(queued.getAsNormalizedFullLink().id);
    expect(run.host).toBe(HOME_HOST);
  });

  it("cancels an exact record without opening an unrelated unavailable host", async () => {
    const { queued } = await seed();
    deps.openHost = () => Promise.reject(new Error("stale toolshed"));

    const run = await cancelAgentRun(
      config,
      queued.getAsNormalizedFullLink().id,
      deps,
    );

    expect(run.cancelRequestedAt).toBe("2026-09-20T12:00:00.000Z");
  });

  it("leaves a terminal record unchanged when cancellation is requested", async () => {
    await seed();
    const run = await cancelAgentRun(config, "hash-completed", deps);

    expect(run.state).toBe("completed");
    expect(run.cancelRequestedAt).toBeUndefined();
  });

  it("returns terminal metadata written before the cancellation transaction", async () => {
    const { queued } = await seed();
    const runtime = runtimes.get(HOME_HOST)!;
    const edit = runtime.editWithRetry.bind(runtime);
    let advanced = false;
    runtime.editWithRetry = async (action) => {
      if (!advanced) {
        advanced = true;
        await edit((tx) => {
          queued.withTx(tx).key("state").set("failed");
          queued.withTx(tx).key("outcome").set("failed");
          queued.withTx(tx).key("errorCode").set("PROVIDER_FAILURE");
          queued.withTx(tx).key("finishedAt").set("2026-09-20T11:59:00Z");
          queued.withTx(tx).key("modelTurns").set(3);
        });
      }
      return edit(action);
    };

    const run = await cancelAgentRun(
      config,
      queued.getAsNormalizedFullLink().id,
      deps,
    );

    expect(run).toMatchObject({
      state: "failed",
      outcome: "failed",
      errorCode: "PROVIDER_FAILURE",
      finishedAt: "2026-09-20T11:59:00Z",
      modelTurns: 3,
    });
    expect(run.cancelRequestedAt).toBeUndefined();
  });

  it("keeps an existing cancellation timestamp", async () => {
    const { queued } = await seed();
    await runtimes.get(HOME_HOST)!.editWithRetry((tx) => {
      queued.withTx(tx).key("cancelRequestedAt").set("2026-09-20T11:30:00Z");
    });

    const run = await cancelAgentRun(config, "hash-queued", deps);

    expect(run.cancelRequestedAt).toBe("2026-09-20T11:30:00Z");
  });

  it("rejects an ambiguous request hash", async () => {
    await seed();
    const runs = await readAgentRuns(config, deps);
    const sameHash = {
      ...runs[0],
      id: "another-record",
      address: "another-address",
    };

    expect(() => selectAgentRun([...runs, sameHash], "hash-completed"))
      .toThrow("Ambiguous agent run");
  });

  it("lists no runs when the home queue is absent", async () => {
    expect(await readAgentRuns(config, deps)).toEqual([]);
  });

  it("deduplicates repeated queue entries and reuses their remote connection", async () => {
    const { completed } = await seed();
    const runtime = runtimes.get(HOME_HOST)!;
    await runtime.editWithRetry((tx) => {
      runtime.getCell(home, "home-pattern", undefined, tx)
        .key("agentQueue").key("entries").push({
          run: completed,
          host: OTHER_HOST,
        });
    });
    const hosts: string[] = [];
    const open = deps.openHost;
    deps.openHost = (identity, host) => {
      hosts.push(host);
      return open(identity, host);
    };

    const runs = await readAgentRuns(config, deps);

    expect(runs).toHaveLength(2);
    expect(hosts).toEqual([OTHER_HOST]);
  });

  it("reports a deleted remote record instead of presenting incomplete metadata", async () => {
    const { completed } = await seed();
    await runtimes.get(OTHER_HOST)!.editWithRetry((tx) => {
      completed.withTx(tx).setRaw(undefined);
    });

    await expect(readAgentRuns(config, deps)).rejects.toThrow(
      "unavailable on https://other.example",
    );
  });

  it("propagates a home wish error without reading another host", async () => {
    runtimes.get(HOME_HOST)!.homeSpacePrincipalFor = () => undefined;
    const hosts: string[] = [];
    deps.openHost = (_identity, host) => {
      hosts.push(host);
      return Promise.resolve(runtimes.get(host)!);
    };

    await expect(readAgentRuns(config, deps)).rejects.toThrow(
      "User identity DID not available for #agent_queue",
    );
    expect(hosts).toEqual([]);
  });

  it("reports a rejected cancellation write without claiming it succeeded", async () => {
    const { completed } = await seed();
    const remote = runtimes.get(OTHER_HOST)!;
    await remote.editWithRetry((tx) => {
      completed.withTx(tx).key("state").set("running");
    });
    const rejection = {
      name: "StorageTransactionAborted" as const,
      message: "remote cancellation write rejected",
      reason: new Error("remote storage unavailable"),
    };
    remote.editWithRetry = () => Promise.resolve({ error: rejection });

    await expect(cancelAgentRun(config, "hash-completed", deps)).rejects.toBe(
      rejection,
    );
    expect(completed.key("cancelRequestedAt").get()).toBeUndefined();
  });

  it("rejects an unknown identifier", async () => {
    await seed();
    await expect(cancelAgentRun(config, "missing", deps)).rejects.toThrow(
      "No agent run",
    );
  });
});
