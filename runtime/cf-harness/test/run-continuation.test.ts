import { expect } from "@std/expect";
import { join } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import {
  createHarnessRunState,
  type HarnessRunState,
} from "../src/run-state.ts";
import {
  prepareHarnessContinuation,
  prepareNextHarnessRun,
  resolveHostPathThroughNearestRealParent,
} from "../src/run-continuation.ts";

const completedRun = (): HarnessRunState =>
  createHarnessRunState({
    runId: "prior-run",
    status: "completed",
    currentDir: "/workspace",
    cfcEnforcementMode: "disabled",
    systemPromptInputs: {},
  });

const checkpoint: readonly HarnessTranscriptMessage[] = [
  { role: "user", content: "first task" },
  { role: "assistant", content: "done" },
];

const answerSchema: JSONSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
};

describe("run-continuation", () => {
  let root: string;

  beforeEach(async () => {
    root = await Deno.realPath(await Deno.makeTempDir());
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  describe("prepareNextHarnessRun()", () => {
    it("refuses a source whose prompt-slot binding is digest-bound", async () => {
      const runState = completedRun();
      runState.promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test", subject: "prior" },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        valueDigest: "sha256:prior",
      };
      await expect(prepareNextHarnessRun({ runState, transcript: checkpoint }))
        .rejects.toThrow("cannot continue a digest-bound prompt-slot binding");
    });

    it("names the source as the parent of a new run when nothing is digest-bound", async () => {
      const next = await prepareNextHarnessRun({
        runState: completedRun(),
        transcript: checkpoint,
        runId: "next-run",
      });
      expect(next.runState.runId).toBe("next-run");
      expect(next.runState.lineage).toEqual({
        role: "continuation",
        rootRunId: "prior-run",
        parentRunId: "prior-run",
      });
      expect(next.transcript).toEqual(checkpoint);
    });
  });

  describe("prepareHarnessContinuation()", () => {
    const continuation = (
      runState: HarnessRunState,
      overrides: Partial<Parameters<typeof prepareHarnessContinuation>[0]>,
    ) =>
      prepareHarnessContinuation({
        runState,
        transcript: checkpoint,
        prompt: "next task",
        artifactRoot: join(root, "artifacts"),
        workspace: root,
        schemaExplicit: false,
        ...overrides,
      });

    it("refuses an explicit schema that differs from the recorded one", async () => {
      const runState = completedRun();
      runState.structuredResult = {
        schema: answerSchema,
        path: join(root, "prior", "result.json"),
      };
      await expect(continuation(runState, {
        schemaExplicit: true,
        structuredResult: {
          schema: { type: "object", properties: { other: {} } },
          path: join(root, "next.json"),
          sandboxPath: "/workspace/next.json",
        },
      })).rejects.toThrow(
        "continued run structured-result schema does not match the recorded schema",
      );
    });

    it("accepts an explicit schema equal to the recorded one at a new path", async () => {
      const runState = completedRun();
      runState.structuredResult = {
        schema: answerSchema,
        path: join(root, "prior", "result.json"),
      };
      const next = await continuation(runState, {
        schemaExplicit: true,
        structuredResult: {
          schema: structuredClone(answerSchema),
          path: join(root, "next.json"),
          sandboxPath: "/workspace/next.json",
        },
      });
      expect(next.structuredResult).toEqual({
        schema: answerSchema,
        path: join(root, "next.json"),
        sandboxPath: "/workspace/next.json",
      });
    });

    it("refuses a result path when the source records no schema and none is explicit", async () => {
      await expect(continuation(completedRun(), {
        structuredResult: {
          schema: answerSchema,
          path: join(root, "next.json"),
          sandboxPath: "/workspace/next.json",
        },
      })).rejects.toThrow(
        "--structured-result-path requires a recorded or explicit schema",
      );
    });

    it("returns no result contract when neither side asks for one", async () => {
      const next = await continuation(completedRun(), {});
      expect(next.structuredResult).toBeUndefined();
      expect(next.runState.structuredResult).toBeUndefined();
    });
  });

  describe("resolveHostPathThroughNearestRealParent()", () => {
    it("rethrows a failure other than a missing path", async () => {
      const file = join(root, "file");
      await Deno.writeTextFile(file, "");
      expect(() => resolveHostPathThroughNearestRealParent(join(file, "child")))
        .toThrow();
    });

    it("appends missing components to the nearest real parent", () => {
      expect(resolveHostPathThroughNearestRealParent(join(root, "a", "b")))
        .toBe(join(root, "a", "b"));
    });

    it("returns a relative path unchanged when no ancestor exists", async () => {
      // A removed working directory leaves even `.` unresolvable, so the walk
      // reaches the top of the relative path without finding a real parent.
      const original = Deno.cwd();
      const gone = join(root, "gone");
      await Deno.mkdir(gone);
      Deno.chdir(gone);
      try {
        await Deno.remove(gone);
        expect(resolveHostPathThroughNearestRealParent(join("a", "b")))
          .toBe(join("a", "b"));
      } finally {
        Deno.chdir(original);
      }
    });
  });
});
