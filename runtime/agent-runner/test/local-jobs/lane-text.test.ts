/** Exercises persisted text and usage over the API with the real harness loop. */
import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { readHarnessRunArtifacts } from "@commonfabric/cf-harness/artifacts";

import { createLocalJobApi } from "../../src/local-jobs/api.ts";
import { LocalJobLane } from "../../src/local-jobs/lane.ts";
import {
  LOCAL_JOB_TERMINAL_STATES,
  type LocalJob,
  type LocalJobEvent,
  LocalJobStore,
} from "../../src/local-jobs/store.ts";
import {
  answerReply,
  scriptedJob,
  toolReply,
} from "../fixtures/scripted-job.ts";

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};
const opening = "Starting the work. " + "x".repeat(12000);
const closing = "The work is complete.";

/** Awaits the store notification that closes this job's event stream. */
const ended = (store: LocalJobStore, id: string) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (LOCAL_JOB_TERMINAL_STATES.has(store.get(id)!.state)) {
        stop();
        resolve();
      }
    };
    const stop = store.subscribe((jobId) => {
      if (jobId === id) check();
    });
    check();
  });

describe("local-jobs/lane text", () => {
  let dir: string;
  let store: LocalJobStore;
  let lane: LocalJobLane;
  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    store = LocalJobStore.open(":memory:");
  });
  afterEach(async () => {
    await lane?.stop();
    store.close();
    await Deno.remove(dir, { recursive: true });
  });

  const start = (script: ReturnType<typeof scriptedJob>) => {
    const profiles = new Map([["chat", {
      tools: ["write_file", "delegate_task"],
      taskRole: "direct-command" as const,
      retry: "never" as const,
      maxModelTurns: 4,
      model: "scripted",
    }]]);
    lane = new LocalJobLane({
      store,
      profiles,
      workRoot: join(dir, "runs"),
      harnessDeps: script.deps,
      maxConcurrent: 1,
    });
    const api = createLocalJobApi({
      store,
      profiles,
      token: "test",
      kick: () => lane.kick(),
      cancel: (id) => lane.cancel(id),
    });
    const call = (path: string, body?: unknown) =>
      api(
        new Request(`http://runner${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: "Bearer test" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const enqueue = async (resultSchema?: unknown) => {
      const response = await call("/jobs", {
        caller: "test",
        profile: "chat",
        idempotencyKey: "first",
        task: "Reply to the caller",
        ...(resultSchema === undefined ? {} : { resultSchema }),
      });
      expect(response.status).toBe(201);
      return (await response.json()).job as LocalJob;
    };
    const finish = async (id: string) => {
      await ended(store, id);
      const { job } = await (await call(`/jobs/${id}`)).json();
      const stream = await (await call(`/jobs/${id}/events`)).text();
      const events: LocalJobEvent[] = stream.split("\n\n").filter(Boolean).map(
        (frame) => {
          const lines = frame.split("\n");
          const { seq, at, ...body } = JSON.parse(
            lines.find((line) => line.startsWith("data: "))!.slice(6),
          );
          return {
            seq,
            at,
            kind: lines.find((line) => line.startsWith("event: "))!.slice(7),
            body,
          };
        },
      );
      return { job: job as LocalJob, events };
    };
    return { call, enqueue, finish };
  };
  const textScript = () =>
    scriptedJob((_request, index) => ({
      ...(index === 0
        ? toolReply("write_file", {
          path: "/workspace/progress.txt",
          content: "done",
        })
        : answerReply("done")),
      content: index === 0 ? opening : closing,
    }));

  it("streams each whole root message in order with the tool steps and its own turns", async () => {
    const { enqueue, finish } = start(textScript());
    const { job, events } = await finish((await enqueue(schema)).id);
    expect(job).toMatchObject({
      state: "completed",
      result: { answer: "done" },
    });
    expect(
      events.filter((event) => event.kind === "text" || event.kind === "step")
        .map((event) => ({ kind: event.kind, ...event.body })),
    ).toEqual([
      { kind: "text", turn: 1, text: opening },
      { kind: "step", turn: 1, tool: "write_file" },
      { kind: "step", turn: 1, tool: "write_file", returned: true },
      { kind: "text", turn: 2, text: closing },
      { kind: "step", turn: 2, tool: "submit_result" },
      { kind: "step", turn: 2, tool: "submit_result", returned: true },
    ]);
    expect(
      await Deno.readTextFile(
        join(dir, "runs", job.id, "workspace/progress.txt"),
      ),
    ).toBe("done");
  });

  it("streams cumulative usage after every completed call with report coverage", async () => {
    const script = textScript();
    const { enqueue, finish } = start(script);
    const { job, events } = await finish((await enqueue(schema)).id);
    const usage = events.filter((event) => event.kind === "usage");
    expect(usage.map((event) => event.body)).toEqual(
      [12, 24].map((totalTokens) => ({
        usage: expect.objectContaining({
          inputTokens: totalTokens / 12 * 10,
          outputTokens: totalTokens / 6,
          totalTokens,
        }),
        coverage: "including-descendants",
      })),
    );
    expect(usage).toHaveLength(script.requests.length);
    expect(usage.at(-1)!.body).toEqual({
      usage: job.report!.usage,
      coverage: job.report!.usageCoverage,
    });
    expect(events.indexOf(usage[0])).toBeLessThan(
      events.findIndex((event) => event.kind === "text"),
    );
  });

  it("keeps delegated assistant text private while counting its usage", async () => {
    const script = scriptedJob((_request, index) =>
      index === 0
        ? toolReply("delegate_task", {
          goal: "Reply briefly",
          maxModelTurns: 1,
        })
        : index === 1
        ? { role: "assistant", content: "Private child answer" }
        : { ...answerReply("done"), content: "Parent answer" }
    );
    const createLoop = script.deps.createPromptLoop!;
    script.deps.createPromptLoop = (options) =>
      createLoop({ ...options, allowedSubagentProfiles: ["default"] });
    const { enqueue, finish } = start(script);
    const { job, events } = await finish((await enqueue(schema)).id);
    expect(job.state).toBe("completed");
    expect(script.requests).toHaveLength(3);
    expect(
      events.filter((event) => event.kind === "text").map((event) =>
        event.body
      ),
    ).toEqual([{ turn: 2, text: "Parent answer" }]);
    expect(
      events.filter((event) => event.kind === "usage").map((event) =>
        (event.body.usage as { totalTokens: number }).totalTokens
      ),
    ).toEqual([12, 24, 36]);
  });

  it("completes a schema-less job with final text and offers no result contract", async () => {
    const script = scriptedJob(() => ({
      role: "assistant",
      content: "A plain answer",
    }));
    const { enqueue, finish } = start(script);
    const { job, events } = await finish((await enqueue()).id);
    expect(job).toMatchObject({ state: "completed", result: "A plain answer" });
    expect(
      script.requests[0].tools.some((tool) => tool.toolId === "submit_result"),
    ).toBe(false);
    expect(
      script.requests[0].transcript.find((message) =>
        message.role === "system"
      )!.content,
    ).not.toContain("Structured result contract:");
    expect(
      events.filter((event) => event.kind === "text").map((event) =>
        event.body
      ),
    ).toEqual([{ turn: 1, text: "A plain answer" }]);
    const recorded = await readHarnessRunArtifacts(
      job.report!.runRef as string,
    );
    expect(recorded.runState.structuredResult).toBeUndefined();
    expect(
      Array.from(Deno.readDirSync(join(dir, "runs", job.id, "workspace"))).some(
        (entry) => entry.name === ".job-results",
      ),
    ).toBe(false);
  });

  it("inherits schema-less requests in follow-ups and emits only their own text", async () => {
    const script = scriptedJob((_request, index) => ({
      role: "assistant",
      content: index === 0 ? "First answer" : "Second answer",
    }));
    const { call, enqueue, finish } = start(script);
    const { job: first } = await finish((await enqueue()).id);
    const response = await call(`/jobs/${first.id}/messages`, {
      caller: "test",
      idempotencyKey: "second",
      message: "Follow up",
    });
    expect(response.status).toBe(201);
    const next = (await response.json()).job;
    const { job, events } = await finish(next.id);
    expect(job).toMatchObject({
      state: "completed",
      continues: first.id,
      result: "Second answer",
    });
    expect(script.requests[1].transcript).toContainEqual({
      role: "assistant",
      content: "First answer",
    });
    expect(
      script.requests[1].tools.some((tool) => tool.toolId === "submit_result"),
    ).toBe(false);
    expect(
      events.filter((event) => event.kind === "text").map((event) =>
        event.body
      ),
    ).toEqual([{ turn: 1, text: "Second answer" }]);
  });
});
