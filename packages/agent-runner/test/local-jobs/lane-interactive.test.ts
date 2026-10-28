import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { HarnessJobResult } from "../../src/harness-job.ts";
import { createLocalJobApi } from "../../src/local-jobs/api.ts";
import { LocalJobLane } from "../../src/local-jobs/lane.ts";
import type { LocalJobProfile } from "../../src/local-jobs/profiles.ts";
import { LocalJobStore } from "../../src/local-jobs/store.ts";

/** Builds an API and lane whose runs stay open until settled or aborted. */
const heldLane = (maxConcurrent: number) => {
  const store = LocalJobStore.open(":memory:");
  const profiles = new Map<string, LocalJobProfile>([["ask", {
    tools: [],
    maxModelTurns: 1,
    taskRole: "direct-command",
    retry: "never",
  }]]);
  const runs: { task: string; finish: () => void }[] = [];
  const waiting: (() => void)[] = [];
  const lane = new LocalJobLane({
    store,
    profiles,
    maxConcurrent,
    workRoot: "/unused/interactive-jobs",
    runJob: (spec, options) => {
      const held = Promise.withResolvers<HarnessJobResult>();
      const finish = () => held.resolve({ outcome: "cancelled" });
      options.signal.addEventListener("abort", finish, { once: true });
      if (options.signal.aborted) finish();
      runs.push({ task: spec.task, finish });
      waiting.shift()?.();
      return held.promise;
    },
  });
  const api = createLocalJobApi({
    store,
    profiles,
    token: "test",
    kick: () => lane.kick(),
    cancel: (id) => lane.cancel(id),
  });
  const enqueue = async (task: string, interactive?: boolean) => {
    const response = await api(
      new Request("http://runner/jobs", {
        method: "POST",
        headers: { authorization: "Bearer test" },
        body: JSON.stringify({
          caller: "test",
          profile: "ask",
          idempotencyKey: task,
          task,
          ...(interactive === undefined ? {} : { interactive }),
        }),
      }),
    );
    expect(response.status).toBe(201);
    const id: unknown = (await response.json()).job.id;
    if (typeof id !== "string") throw new Error("Enqueue returned no job id.");
    return id;
  };
  const nextRun = async (index: number) => {
    if (runs[index] === undefined) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    return runs[index];
  };
  const close = async () => {
    await lane.stop();
    store.close();
  };
  return { store, runs, enqueue, nextRun, close };
};

describe("local-jobs/lane-interactive", () => {
  it("holds the third slot for an interactive job behind two running background jobs", async () => {
    const { store, runs, enqueue, nextRun, close } = heldLane(3);
    try {
      await enqueue("background-1");
      await enqueue("background-2", false);
      await nextRun(1);
      const background = await enqueue("background-3");
      expect(store.get(background)?.state).toBe("queued");
      await enqueue("interactive", true);
      expect((await nextRun(2)).task).toBe("interactive");
      expect(runs).toHaveLength(3);
      expect(store.get(background)?.state).toBe("queued");
    } finally {
      await close();
    }
  });

  it("starts queued interactive jobs oldest first ahead of every queued background job", async () => {
    const { store, enqueue, nextRun, close } = heldLane(3);
    try {
      await enqueue("background-1");
      await enqueue("background-2");
      const first = await nextRun(0);
      await nextRun(1);
      await enqueue("interactive-1", true);
      const interactive = await nextRun(2);
      const background = await enqueue("background-3");
      const nextBackground = await enqueue("background-4");
      const second = await enqueue("interactive-2", true);
      const third = await enqueue("interactive-3", true);
      expect(store.get(second)?.state).toBe("queued");
      first.finish();
      expect((await nextRun(3)).task).toBe("interactive-2");
      interactive.finish();
      expect((await nextRun(4)).task).toBe("interactive-3");
      expect(store.get(third)?.state).toBe("running");
      expect(store.get(background)?.state).toBe("queued");
      expect(store.get(nextBackground)?.state).toBe("queued");
      (await nextRun(1)).finish();
      expect((await nextRun(5)).task).toBe("background-3");
    } finally {
      await close();
    }
  });

  it("runs background jobs oldest first with one slot and reserves nothing", async () => {
    const { store, runs, enqueue, nextRun, close } = heldLane(1);
    try {
      await enqueue("background-1");
      const first = await nextRun(0);
      const second = await enqueue("background-2", false);
      const third = await enqueue("background-3");
      expect(store.get(second)?.state).toBe("queued");
      first.finish();
      expect((await nextRun(1)).task).toBe("background-2");
      expect(store.get(third)?.state).toBe("queued");
      expect(runs).toHaveLength(2);
    } finally {
      await close();
    }
  });
});
