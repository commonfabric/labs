/** Reopens a durable store after stopping a real harness run mid-request. */
import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { HARNESS_CHAT_INTERRUPTED_TURN_NOTICE } from "@commonfabric/cf-harness/interactive-chat-service";

import { LocalJobLane } from "../../src/local-jobs/lane.ts";
import {
  LOCAL_JOB_TERMINAL_STATES,
  type LocalJob,
  LocalJobStore,
} from "../../src/local-jobs/store.ts";
import { scriptedJob, toolReply } from "../fixtures/scripted-job.ts";

/** Resolves from the job's terminal store notification. */
const ended = (store: LocalJobStore, id: string) =>
  new Promise<LocalJob>((resolve) => {
    const check = () => {
      const job = store.get(id)!;
      if (LOCAL_JOB_TERMINAL_STATES.has(job.state)) {
        stop();
        resolve(job);
      }
    };
    const stop = store.subscribe((jobId) => {
      if (jobId === id) check();
    });
    check();
  });

describe("local-jobs/lane restart", () => {
  let dir: string;
  let store: LocalJobStore;
  let lane: LocalJobLane;
  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    store = LocalJobStore.open(join(dir, "jobs.sqlite"));
  });
  afterEach(async () => {
    await lane?.stop();
    store.close();
    await Deno.remove(dir, { recursive: true });
  });

  const interrupted = async (completeTurn: boolean, pending: boolean) => {
    const held = Promise.withResolvers<void>();
    const script = scriptedJob((request, index) => {
      if (completeTurn && index === 0) {
        return {
          ...toolReply("write_file", {
            path: "/workspace/checkpoint.txt",
            content: "checkpoint",
          }),
          content: "Checkpoint answer",
        };
      }
      if (index === (completeTurn ? 1 : 0)) {
        held.resolve();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(request.signal!.reason);
          if (request.signal!.aborted) abort();
          else request.signal!.addEventListener("abort", abort, { once: true });
        });
      }
      return { role: "assistant", content: "Recovered answer" };
    });
    const createLane = () =>
      new LocalJobLane({
        store,
        profiles: new Map([["chat", {
          tools: ["write_file"],
          taskRole: "direct-command",
          retry: "never",
          model: "scripted",
          maxModelTurns: 4,
        }]]),
        workRoot: join(dir, "runs"),
        maxConcurrent: 1,
        harnessDeps: script.deps,
      });
    lane = createLane();
    await lane.start();
    const enqueued = store.enqueue("test", "chat", "first", {
      task: "Make a checkpoint and continue",
    });
    if ("conflict" in enqueued) throw new Error(enqueued.conflict);
    const id = enqueued.job.id;
    lane.kick();
    await held.promise;
    const recorded = store.runningRuns();
    expect(recorded).toEqual([{ id, runRoot: expect.any(String) }]);
    expect(recorded[0].runRoot!.startsWith(join(dir, "runs", id, "artifacts")))
      .toBe(true);
    if (pending) {
      const accepted = store.acceptMessage(id, {
        caller: "test",
        idempotencyKey: "pending",
        message: "Continue after restart",
      });
      if (!("message" in accepted)) throw new Error(accepted.error);
      expect(accepted.message.delivery).toBe("pending");
    }
    await lane.stop();
    expect(store.get(id)!.state).toBe("running");
    store.close();
    store = LocalJobStore.open(join(dir, "jobs.sqlite"));
    lane = createLane();
    await lane.start();
    return { id, script };
  };

  it("opens a waiting follow-up from the recovered checkpoint and marks the interrupted request", async () => {
    const { id, script } = await interrupted(true, true);
    const prior = store.get(id)!;
    expect(prior).toMatchObject({
      state: "interrupted",
      errorCode: "RUNNER_RESTARTED",
      messages: [{ delivery: "follow-up" }],
    });
    expect(prior.report!.runRef).toEqual(expect.any(String));
    const next = await ended(store, prior.continuedBy!);
    expect(next).toMatchObject({
      state: "completed",
      continues: id,
      result: "Recovered answer",
    });
    expect(script.workspaces.at(-1)).toBe(script.workspaces[0]);
    expect(store.conversation(next.id)).toMatchObject({
      root: { id },
      head: { id: next.id },
    });
    const history = script.requests[2].transcript;
    expect(history).toContainEqual(
      expect.objectContaining({ role: "tool", toolName: "write_file" }),
    );
    const notice = history.findIndex((message) =>
      message.content === HARNESS_CHAT_INTERRUPTED_TURN_NOTICE
    );
    const task = history.findIndex((message) =>
      message.content === "Continue after restart"
    );
    expect(notice).toBeGreaterThan(0);
    expect(task).toBeGreaterThan(notice);
    expect(
      await Deno.readTextFile(
        join(dir, "runs", id, "workspace/checkpoint.txt"),
      ),
    ).toBe("checkpoint");
  });

  it("drops a waiting message when no model checkpoint completed", async () => {
    const { id, script } = await interrupted(false, true);
    expect(store.get(id)).toMatchObject({
      state: "interrupted",
      messages: [{ delivery: "dropped", reason: "interrupted" }],
    });
    expect(store.get(id)!.continuedBy).toBeUndefined();
    expect(
      store.acceptMessage(id, {
        caller: "test",
        idempotencyKey: "later",
        message: "Try again",
      }),
    ).toMatchObject({ code: "not_continuable" });
    expect(script.requests).toHaveLength(1);
  });

  it("accepts a later message to an interrupted job with a recovered checkpoint", async () => {
    const { id, script } = await interrupted(true, false);
    const accepted = store.acceptMessage(id, {
      caller: "test",
      idempotencyKey: "later",
      message: "A later follow-up",
    });
    expect(accepted).toMatchObject({
      message: { delivery: "follow-up" },
      job: { continues: id },
    });
    if (!("job" in accepted)) throw new Error(accepted.error);
    lane.kick();
    const next = await ended(store, accepted.job.id);
    expect(next).toMatchObject({
      state: "completed",
      result: "Recovered answer",
    });
    expect(script.requests[2].transcript).toContainEqual({
      role: "user",
      content: "A later follow-up",
    });
  });
});
