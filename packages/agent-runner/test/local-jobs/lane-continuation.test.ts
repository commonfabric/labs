import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { LocalJobLane } from "../../src/local-jobs/lane.ts";
import {
  LOCAL_JOB_TERMINAL_STATES,
  type LocalJob,
  LocalJobStore,
} from "../../src/local-jobs/store.ts";
import {
  answerReply,
  scriptedJob,
  toolReply,
} from "../fixtures/scripted-job.ts";

/** Resolves on the job's terminal event, including an unexpected failure. */
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

/** Runs a predecessor and its messaged follow-up through the real job runner. */
const conversation = async () => {
  const dir = await Deno.makeTempDir();
  const store = LocalJobStore.open(":memory:");
  const configPath = join(dir, "commands.json");
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      cliPath: "/trusted/loom",
      transport: { kind: "broker", queuePath: "/trusted/queue" },
    }),
  );
  const script = scriptedJob((_request, index) => {
    if (index === 0) {
      return toolReply("write_file", {
        path: "/workspace/predecessor.txt",
        content: "predecessor file",
      });
    }
    if (index === 1 || index === 3) {
      return toolReply("run_command", {
        command: index === 1 ? "command.prior" : "command.current",
        args: {},
      });
    }
    return answerReply(index === 2 ? "predecessor" : "follow-up");
  });
  const createLoop = script.deps.createPromptLoop!;
  const commandCalls: string[][] = [];
  script.deps.createPromptLoop = (options) =>
    createLoop({
      ...options,
      processRunner: {
        run(request) {
          commandCalls.push(request.args);
          return Promise.resolve({
            stdout: JSON.stringify(
              request.args[1] === "list"
                ? {
                  commands: ["command.prior", "command.current"].map((id) => ({
                    id,
                    scope: "global",
                    inputs: { type: "object" },
                  })),
                }
                : { ok: true },
            ),
            stderr: "",
            exitCode: 0,
          });
        },
      },
    });
  const lane = new LocalJobLane({
    store,
    profiles: new Map([["commands", {
      tools: ["write_file", "run_command"],
      maxModelTurns: 4,
      taskRole: "direct-command",
      retry: "never",
      model: "scripted",
      loomCommandsConfig: configPath,
    }]]),
    maxConcurrent: 1,
    workRoot: join(dir, "runs"),
    harnessDeps: script.deps,
  });
  try {
    const enqueued = store.enqueue("test", "commands", "first", {
      task: "Write a file and run the predecessor command",
      resultSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    });
    if ("conflict" in enqueued) throw new Error(enqueued.conflict);
    lane.kick();
    const first = await ended(store, enqueued.job.id);
    expect(first.state).toBe("completed");
    const follow = store.acceptMessage(first.id, {
      caller: "test",
      idempotencyKey: "follow",
      message: "Run this job's command",
    });
    if (!("job" in follow)) throw new Error(follow.error);
    const steer = store.acceptMessage(follow.job.id, {
      caller: "test",
      idempotencyKey: "steer",
      message: "Use the current command only",
    });
    if (!("job" in steer)) throw new Error(steer.error);
    lane.kick();
    const next = await ended(store, follow.job.id);
    expect(next.state).toBe("completed");
    expect(script.requests[3].transcript).toContainEqual({
      role: "user",
      content: "Use the current command only",
    });
    expect(
      await Deno.readTextFile(join(
        dir,
        "runs",
        first.id,
        "workspace",
        "predecessor.txt",
      )),
    ).toBe("predecessor file");
    return {
      first,
      firstEvents: store.events(first.id),
      next,
      events: store.events(next.id),
      commandCalls,
    };
  } finally {
    await lane.stop();
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
};

describe("local-jobs/lane continuation", () => {
  it("keeps predecessor steps and command receipts out of the follow-up", async () => {
    const { first, next, events, commandCalls } = await conversation();
    expect(first.commands.map((command) => command.command)).toEqual([
      "command.prior",
    ]);
    expect(next.commands.map((command) => command.command)).toEqual([
      "command.current",
    ]);
    expect(
      events.filter((event) => event.kind === "command").map((event) =>
        event.body.command
      ),
    ).toEqual(["command.current"]);
    expect(
      events.filter((event) => event.kind === "step").map((event) =>
        event.body.tool
      ),
    ).toEqual(["run_command", "run_command", "submit_result", "submit_result"]);
    expect(
      commandCalls.filter((args) => args[1] === "run").map((args) => args[2]),
    ).toEqual(["command.prior", "command.current"]);
  });

  it("numbers follow-up steps from its own first delivered turn without changing ordinary jobs", async () => {
    const { first, firstEvents, next, events } = await conversation();
    expect(
      firstEvents.filter((event) => event.kind === "step").map((
        event,
      ) => [event.body.turn, event.body.tool]),
    ).toEqual([
      [1, "write_file"],
      [1, "write_file"],
      [2, "run_command"],
      [2, "run_command"],
      [3, "submit_result"],
      [3, "submit_result"],
    ]);
    expect(first.report?.modelTurns).toBe(3);
    expect(next.messages).toContainEqual(expect.objectContaining({
      key: "steer",
      delivery: "delivered",
      turn: 1,
    }));
    expect(
      events.filter((event) => event.kind === "step").map((
        event,
      ) => [event.body.turn, event.body.tool]),
    ).toEqual([
      [1, "run_command"],
      [1, "run_command"],
      [2, "submit_result"],
      [2, "submit_result"],
    ]);
    expect(next.report?.modelTurns).toBe(2);
  });
});
