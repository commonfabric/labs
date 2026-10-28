import { expect } from "@std/expect";
import { basename, join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { readHarnessRunArtifacts } from "@commonfabric/cf-harness/artifacts";
import type { HarnessJobOptions, HarnessJobSpec } from "../src/harness-job.ts";
import { runHarnessJob } from "../src/harness-job.ts";
import {
  answerReply,
  scriptedJob,
  toolReply,
} from "./fixtures/scripted-job.ts";

const spec: HarnessJobSpec = {
  task: "First task",
  taskRole: "direct-command",
  instructions: "Original instructions",
  resultSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
  tools: ["write_file", "read_file"],
  model: "scripted",
  maxModelTurns: 4,
};

describe("harness-job continuation", () => {
  let root: string;
  beforeEach(async () => {
    root = await Deno.makeTempDir();
  });
  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  const run = (
    jobSpec: HarnessJobSpec,
    script: ReturnType<typeof scriptedJob>,
    id = "first",
    options: Partial<HarnessJobOptions> = {},
  ) =>
    runHarnessJob(jobSpec, {
      runRoot: join(root, id),
      signal: new AbortController().signal,
      harnessDeps: script.deps,
      ...options,
    });

  it("delivers a turn 2 steer after the tool result and returns the later submission", async () => {
    const script = scriptedJob((_request, index) =>
      answerReply(index === 0 ? "first" : "later")
    );
    let taken = false;
    const result = await run(spec, script, "first", {
      takeMessages: (turn) => {
        if (turn !== 2 || taken) return [];
        taken = true;
        return ["Use the later answer"];
      },
    });
    expect(result).toMatchObject({
      outcome: "completed",
      structuredResult: { answer: "later" },
    });
    const history = script.requests[1].transcript;
    const steer = history.findIndex((m) =>
      m.role === "user" && m.content === "Use the later answer"
    );
    expect(history[steer - 1]).toMatchObject({
      role: "tool",
      toolName: "submit_result",
    });
    const artifacts = await readHarnessRunArtifacts(result.report!.runRef!);
    expect(artifacts.transcript).toContainEqual({
      role: "user",
      content: "Use the later answer",
    });
  });

  for (const instructions of [undefined, ""]) {
    it(`${instructions === undefined ? "inherits predecessor instructions when omitted" : "clears predecessor instructions when explicitly empty"} in a follow-up spec`, async () => {
      const first = await run(spec, scriptedJob(() => answerReply("first")));
      expect(first.outcome).toBe("completed");
      const script = scriptedJob(() => answerReply("next"));
      const next = await run(
        {
          ...spec,
          task: "Follow-up task",
          instructions,
          continueFrom: { runRoot: first.report!.runRef! },
        },
        script,
        "second",
      );
      expect(next.outcome).toBe("completed");
      const system = script.requests[0].transcript.find((m) =>
        m.role === "system"
      )!.content;
      expect(system.includes(spec.instructions!)).toBe(
        instructions === undefined,
      );
      const recorded = await readHarnessRunArtifacts(next.report!.runRef!);
      expect(recorded.runState.systemPromptInputs?.systemPrompt).toBe(
        instructions ?? spec.instructions,
      );
    });
  }

  for (const replace of [false, true]) {
    it(`continues history with its own result file and ${replace ? "replaced" : "inherited"} instructions`, async () => {
      const firstScript = scriptedJob(() => answerReply("first"));
      const first = await run(spec, firstScript);
      expect(first.outcome).toBe("completed");
      const prior = await readHarnessRunArtifacts(first.report!.runRef!);
      const priorPath = prior.runState.structuredResult!.path;
      const before = await Deno.readTextFile(priorPath);
      const script = scriptedJob(() => answerReply("next"));
      const next = await run(
        {
          ...spec,
          task: "Follow-up task",
          instructions: replace
            ? "Replacement instructions"
            : spec.instructions,
          continueFrom: { runRoot: first.report!.runRef! },
          taskTags: ["find"],
          taskDomains: [],
        },
        script,
        "second",
      );
      expect(next).toMatchObject({
        outcome: "completed",
        structuredResult: { answer: "next" },
      });
      const history = script.requests[0].transcript;
      expect(
        history.filter((m) => m.role === "user" && !m.turnLocal).map((m) =>
          m.content
        ),
      )
        .toEqual(expect.arrayContaining(["First task", "Follow-up task"]));
      const firstTask = history.findIndex((m) =>
        m.role === "user" && m.content === "First task"
      );
      const nextTask = history.findIndex((m) =>
        m.role === "user" && m.content === "Follow-up task"
      );
      expect(firstTask).toBeLessThan(nextTask);
      expect(history).toContainEqual(
        expect.objectContaining({ role: "tool", toolName: "submit_result" }),
      );
      const system = history.find((m) => m.role === "system")!.content;
      expect(system).toContain(
        "You are cf-harness, an autonomous agent harness for Common Fabric work.",
      );
      expect(system).toContain(
        replace ? "Replacement instructions" : "Original instructions",
      );
      if (replace) expect(system).not.toContain("Original instructions");
      const nextArtifacts = await readHarnessRunArtifacts(next.report!.runRef!);
      expect(nextArtifacts.runState.structuredResult!.path).not.toBe(priorPath);
      expect(basename(nextArtifacts.runState.structuredResult!.path)).toContain(
        "second",
      );
      expect(system).toContain("second.json");
      expect(await Deno.readTextFile(priorPath)).toBe(before);
      expect(next.report?.usage?.totalTokens).toBe(12);
      expect(
        await Deno.readTextFile(nextArtifacts.runState.structuredResult!.path),
      )
        .toBe(JSON.stringify({ answer: "next" }, null, 2) + "\n");
    });
  }

  it("reports a completed run as recorded", async () => {
    const result = await run(spec, scriptedJob(() => answerReply("done")));
    expect(result).toMatchObject({ outcome: "completed", recordedRun: true });
    expect((await readHarnessRunArtifacts(result.report!.runRef!)).transcript)
      .toBeDefined();
  });

  it("reports a run cancelled after a complete turn as recorded", async () => {
    const abort = new AbortController();
    const script = scriptedJob((_request, index) => {
      if (index === 0) {
        return toolReply("write_file", {
          path: "/workspace/saved.txt",
          content: "saved",
        });
      }
      abort.abort();
      throw new Error("cancelled model request");
    });
    const result = await run(spec, script, "first", { signal: abort.signal });
    expect(result).toMatchObject({ outcome: "cancelled", recordedRun: true });
    expect(
      await Deno.readTextFile(join(root, "first", "workspace", "saved.txt")),
    ).toBe("saved");
  });

  it("reports a run failed before a complete checkpoint as unrecorded", async () => {
    const script = scriptedJob(() => {
      throw new Error("first model call failed");
    });
    const result = await run(spec, script);
    expect(result).toMatchObject({ outcome: "failed", recordedRun: false });
  });

  for (const completedTurn of [false, true]) {
    it(`reports ${completedTurn ? "a prior checkpoint" : "no checkpoint"} when cancellation leaves an unpaired call`, async () => {
      const abort = new AbortController();
      const script = scriptedJob((_request, index) =>
        toolReply("write_file", {
          path: `/workspace/turn-${index}.txt`,
          content: "saved",
        })
      );
      let turns = 0;
      const result = await run(spec, script, "first", {
        signal: abort.signal,
        onEvent: (event) => {
          if (
            event.message.role === "assistant" &&
            ++turns === (completedTurn ? 2 : 1)
          ) abort.abort();
        },
      });
      expect(result).toMatchObject({
        outcome: "cancelled",
        recordedRun: completedTurn,
      });
      if (completedTurn) {
        const nextScript = scriptedJob(() => answerReply("continued"));
        const next = await run(
          {
            ...spec,
            task: "Continue interrupted task",
            continueFrom: { runRoot: result.report!.runRef! },
          },
          nextScript,
          "second",
          {
            workspace: join(root, "first", "workspace"),
          },
        );
        expect(next).toMatchObject({ outcome: "completed", recordedRun: true });
        const history = nextScript.requests[0].transcript;
        expect(history.filter((m) => m.role === "assistant")).toHaveLength(1);
        expect(
          history.filter((m) => m.role === "user" && !m.turnLocal).at(-2)
            ?.content,
        )
          .toContain("interrupted");
        expect(history.filter((m) => m.role === "user").at(-1)?.content).toBe(
          "Continue interrupted task",
        );
      }
    });
  }
});
