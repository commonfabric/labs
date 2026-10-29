import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { consoleRunFlow } from "../../console/flow.ts";
import { type ConsoleHandle, consoleRunSteps } from "../../console/steps.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import type { HarnessPolicyEvent } from "../../src/contracts/policy.ts";
import type { ConsoleCellLabels } from "../../console/cell-labels.ts";

const call = (
  id: string,
  name: string,
  args: unknown,
): HarnessTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

const result = (
  toolCallId: string,
  toolName: string,
  content: unknown,
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId,
  toolName,
  content: JSON.stringify(content),
});

const handle = (token: string, ref: string): ConsoleHandle => ({
  token,
  ref,
  addressKey: `[null,"${ref}","space",[]]`,
  introducedAtStep: 0,
  uses: [],
  confidentiality: [],
});

/** What the space says about a cell it labels `Secret` at its root. */
const secretLabels: ConsoleCellLabels = {
  confidentiality: ["Secret"],
  integrity: [],
  derived: false,
  transformedBy: [],
  entries: [{ path: [], confidentiality: ["Secret"], integrity: [] }],
};

describe("console/flow", () => {
  it("cuts the map into a turn for each thing a person asked", () => {
    const steps = consoleRunSteps([
      { role: "user", content: "first" },
      call("c1", "run_pattern", { sourceText: "x" }),
      result("c1", "run_pattern", { status: "ok" }),
      { role: "user", content: "second" },
      call("c2", "assign_slug", { slug: "a" }),
      result("c2", "assign_slug", { status: "ok", slug: "a" }),
    ]);
    const flow = consoleRunFlow({ runId: "r", steps, handles: [] });
    expect(flow.turns).toHaveLength(2);
    expect(flow.turns[0].text).toBe("first");
    expect(flow.turns[0].nodes.map((node) => node.label)).toEqual([
      "run_pattern",
    ]);
    expect(flow.turns[1].nodes.map((node) => node.label)).toEqual([
      "assign_slug",
    ]);
  });

  it("nests a delegated child's calls under the call that delegated", () => {
    const parent = consoleRunSteps([
      { role: "user", content: "build it" },
      call("c1", "delegate_task", { goal: "author" }),
      result("c1", "delegate_task", {
        subagent: { childRunId: "r.subagent.1", status: "completed" },
      }),
    ]);
    const child = consoleRunSteps([
      call("d1", "run_pattern", { sourceText: "x" }),
      result("d1", "run_pattern", { status: "ok" }),
    ]);
    const flow = consoleRunFlow(
      { runId: "r", steps: parent, handles: [] },
      [{ runId: "r.subagent.1", steps: child, handles: [] }],
    );
    const delegate = flow.turns[0].nodes[0];
    expect(delegate.label).toBe("delegate_task");
    expect(delegate.children.map((node) => node.label)).toEqual([
      "run_pattern",
    ]);
    expect(delegate.children[0].depth).toBe(1);
    expect(delegate.children[0].runId).toBe("r.subagent.1");
  });

  it("counts what went wrong across the whole family", () => {
    const denial: HarnessPolicyEvent = {
      type: "cf-harness.policy-event",
      severity: "denied",
      mode: "enforce-explicit",
      toolId: "bash",
      toolCallId: "c2",
      detail: "no trusted mediation metadata",
      at: "2026-01-01T00:00:00.000Z",
    };
    const steps = consoleRunSteps(
      [
        { role: "user", content: "go" },
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "compile-error" }),
        call("c2", "bash", { command: "cat x" }),
        result("c2", "bash", { type: "cf-harness.observation-denied" }),
      ],
      [],
      [denial],
    );
    const flow = consoleRunFlow({ runId: "r", steps, handles: [] });
    expect(flow.failures).toBe(1);
    expect(flow.denials).toBe(1);
    // The pattern read no cell, so it was built from literals.
    expect(flow.unwiredPatterns).toBe(1);
  });

  it("carries the cells a call read and the cell it produced", () => {
    const steps = consoleRunSteps([
      { role: "user", content: "go" },
      call("c1", "run_pattern", {
        sourceText: "y",
        inputs: { source: "cfh:a:aaaaa" },
      }),
      result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:bbbbb" }),
    ]);
    const flow = consoleRunFlow({
      runId: "r",
      steps,
      handles: [
        handle("cfh:a:aaaaa", "/of:fid1:abc"),
        handle("cfh:a:bbbbb", "/of:fid1:def"),
      ],
    });
    const node = flow.turns[0].nodes[0];
    expect(node.reads).toHaveLength(1);
    expect(node.reads[0].as).toBe("source");
    expect(node.reads[0].ref).toBe("/of:fid1:abc");
    expect(node.produces).toHaveLength(1);
    expect(node.produces[0].ref).toBe("/of:fid1:def");
    expect(flow.unwiredPatterns).toBe(0);
  });

  it("carries the labels the space holds on a cell a call read", () => {
    const steps = consoleRunSteps([
      { role: "user", content: "go" },
      call("c1", "run_pattern", {
        sourceText: "y",
        inputs: { source: "cfh:a:aaaaa" },
      }),
      result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:bbbbb" }),
    ]);
    const flow = consoleRunFlow({
      runId: "r",
      steps,
      handles: [
        { ...handle("cfh:a:aaaaa", "/of:fid1:abc"), labels: secretLabels },
        handle("cfh:a:bbbbb", "/of:fid1:def"),
      ],
    });
    const node = flow.turns[0].nodes[0];
    expect(node.reads[0].labels?.confidentiality).toEqual(["Secret"]);
    // The cell the call produced carries no label of its own.
    expect(node.produces[0].labels).toBeUndefined();
  });

  it("states the label regime once for the whole map", () => {
    const steps = consoleRunSteps([{ role: "user", content: "go" }]);
    const flow = consoleRunFlow(
      { runId: "r", steps, handles: [] },
      [],
      undefined,
      {
        status: "unavailable",
        detail: "no space database on this host",
        cellsRead: 0,
        cellsLabelled: 0,
        cellsPartial: 0,
      },
    );
    // Without this a cell drawn bare would read as a space with nothing to say.
    expect(flow.cellLabels?.status).toBe("unavailable");
    expect(flow.cellLabels?.detail).toBe("no space database on this host");
  });

  it("holds a run that delegates to itself to one visit", () => {
    const steps = consoleRunSteps([
      { role: "user", content: "go" },
      call("c1", "delegate_task", { goal: "loop" }),
      result("c1", "delegate_task", {
        subagent: { childRunId: "r", status: "completed" },
      }),
    ]);
    const flow = consoleRunFlow(
      { runId: "r", steps, handles: [] },
      [{ runId: "r", steps, handles: [] }],
    );
    expect(flow.turns[0].nodes[0].children).toEqual([]);
  });
});
