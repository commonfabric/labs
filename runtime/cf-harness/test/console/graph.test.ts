import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  consoleGraphAtStep,
  consoleRunFamilyGraph,
  consoleRunGraph,
} from "../../console/graph.ts";
import { type ConsoleHandle, consoleRunSteps } from "../../console/steps.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
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

/** What a reader that ran out of nodes partway through that cell says. */
const truncatedLabels: ConsoleCellLabels = {
  confidentiality: [],
  integrity: [],
  derived: false,
  transformedBy: [],
  entries: [],
  unreadPaths: [["theirs"]],
  truncationReason: "node-budget-exhausted",
};

/** The reading the two above together support, in either order. */
const foldedLabels: ConsoleCellLabels = {
  confidentiality: ["Secret"],
  integrity: [],
  derived: false,
  transformedBy: [],
  entries: [{ path: [], confidentiality: ["Secret"], integrity: [] }],
  unreadPaths: [["theirs"]],
  truncationReason: "node-budget-exhausted",
};

/**
 * A parent and one child that both touch `/of:same`, each carrying its own
 * reading of it, reduced to what the coalesced cell node says.
 */
const familyCellLabels = (
  rootLabels: ConsoleCellLabels,
  childLabels: ConsoleCellLabels,
): ConsoleCellLabels | undefined => {
  const parentSteps = consoleRunSteps([
    call("c1", "delegate_task", { goal: "build it" }),
    result("c1", "delegate_task", {
      subagent: { childRunId: "r.subagent.1", status: "completed" },
    }),
    call("c2", "assign_slug", { token: "cfh:a:ppppp", slug: "books" }),
    result("c2", "assign_slug", { status: "ok", slug: "books" }),
  ]);
  const childSteps = consoleRunSteps([
    call("d1", "run_pattern", { sourceText: "x" }),
    result("d1", "run_pattern", { status: "ok", resultRef: "cfh:a:kkkkk" }),
  ]);
  const graph = consoleRunFamilyGraph(
    {
      runId: "r",
      steps: parentSteps,
      handles: [{ ...handle("cfh:a:ppppp", "/of:same"), labels: rootLabels }],
    },
    [{
      runId: "r.subagent.1",
      steps: childSteps,
      handles: [{ ...handle("cfh:a:kkkkk", "/of:same"), labels: childLabels }],
    }],
  );
  const cells = graph.nodes.filter((node) => node.kind === "cell");
  expect(cells).toHaveLength(1);
  return cells[0].labels;
};

describe("console/graph", () => {
  describe("consoleRunGraph()", () => {
    it("draws a pattern producing the cell its result addressed", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
      ]);
      const graph = consoleRunGraph(steps, [handle("cfh:a:aaaaa", "/of:a")]);
      expect(graph.nodes.map((node) => node.kind).sort()).toEqual([
        "cell",
        "pattern",
      ]);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].kind).toBe("produces");
    });

    it("draws a read edge for an input wired to a handle", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {
          sourceText: "x",
          inputs: { books: "cfh:a:aaaaa" },
        }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:bbbbb" }),
      ]);
      const graph = consoleRunGraph(steps, [
        handle("cfh:a:aaaaa", "/of:a"),
        handle("cfh:a:bbbbb", "/of:b"),
      ]);
      const reads = graph.edges.filter((edge) => edge.kind === "reads");
      expect(reads).toHaveLength(1);
      expect(reads[0].label).toBe("books");
      expect(reads[0].to).toContain("pattern:");
      expect(graph.unwiredPatterns).toBe(0);
    });

    it("counts a pattern built from literals as unwired", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x", inputs: { bill: 100 } }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
      ]);
      const graph = consoleRunGraph(steps, [handle("cfh:a:aaaaa", "/of:a")]);
      expect(graph.edges.filter((edge) => edge.kind === "reads")).toHaveLength(
        0,
      );
      expect(graph.unwiredPatterns).toBe(1);
    });

    it("is one cell when two handles name one address", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
        call("c2", "assign_slug", { token: "cfh:a:bbbbb", slug: "books" }),
        result("c2", "assign_slug", { status: "ok", slug: "books" }),
      ]);
      const graph = consoleRunGraph(steps, [
        handle("cfh:a:aaaaa", "/of:same"),
        handle("cfh:a:bbbbb", "/of:same"),
      ]);
      const cells = graph.nodes.filter((node) => node.kind === "cell");
      expect(cells).toHaveLength(1);
      expect(cells[0].slug).toBe("books");
    });

    it("draws a read edge for an input written as a whole link", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {
          sourceText: "x",
          inputs: { source: "  /of:fid1:abc" },
        }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
      ]);
      const graph = consoleRunGraph(steps, [handle("cfh:a:aaaaa", "/of:b")]);
      const reads = graph.edges.filter((edge) => edge.kind === "reads");
      expect(reads).toHaveLength(1);
      expect(reads[0].label).toBe("source");
      expect(reads[0].from).toBe("cell:/of:fid1:abc");
    });

    it("is one cell when a link addresses a path inside a handled document", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
        call("c2", "run_pattern", {
          sourceText: "y",
          inputs: { source: "/of:fid1:abc/numbers" },
        }),
        result("c2", "run_pattern", { status: "ok", resultRef: "cfh:a:bbbbb" }),
      ]);
      const graph = consoleRunGraph(steps, [
        handle("cfh:a:aaaaa", "/of:fid1:abc"),
        handle("cfh:a:bbbbb", "/of:fid1:def"),
      ]);
      const cells = graph.nodes.filter((node) => node.kind === "cell");
      // The produced cell, and the one the second pattern read — not a third
      // for the path inside the first.
      expect(cells).toHaveLength(2);
      expect(graph.unwiredPatterns).toBe(1);
    });

    it("keeps complete document addresses distinct and coalesces their aliases", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
        call("c2", "run_pattern", {
          sourceText: "y",
          inputs: {
            source: "/@did:key:bakery/of:fid1:abc/numbers",
            other: "//did:key:other/of:fid1:abc@space/numbers",
          },
        }),
        result("c2", "run_pattern", { status: "ok" }),
      ]);
      const graph = consoleRunGraph(steps, [
        handle("cfh:a:aaaaa", "//did:key:bakery/of:fid1:abc@space"),
      ]);
      const cells = graph.nodes.filter((node) => node.kind === "cell");
      expect(cells.map((node) => node.id).sort()).toEqual([
        "cell://did:key:bakery/of:fid1:abc",
        "cell://did:key:other/of:fid1:abc",
      ]);
      expect(graph.edges.filter((edge) => edge.kind === "reads")).toHaveLength(
        2,
      );
    });

    it("leaves a cell unnamed when assign_slug refused it", () => {
      const steps = consoleRunSteps([
        call("c1", "assign_slug", { token: "cfh:a:aaaaa", slug: "books" }),
        result("c1", "assign_slug", { status: "error", message: "taken" }),
      ]);
      const graph = consoleRunGraph(steps, [handle("cfh:a:aaaaa", "/of:a")]);
      expect(graph.nodes[0].slug).toBeUndefined();
    });
  });

  describe("cell labels", () => {
    it("carries the labels the space holds on a cell a token named", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
      ]);
      const graph = consoleRunGraph(steps, [
        { ...handle("cfh:a:aaaaa", "/of:a"), labels: secretLabels },
      ]);
      const cell = graph.nodes.find((node) => node.kind === "cell");
      expect(cell?.labels?.confidentiality).toEqual(["Secret"]);
    });

    it("carries them onto a cell an input named by whole link", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {
          sourceText: "x",
          inputs: { source: "/of:fid1:abc" },
        }),
        result("c1", "run_pattern", { status: "ok" }),
      ]);
      const graph = consoleRunGraph(steps, [
        { ...handle("cfh:a:aaaaa", "/of:fid1:abc"), labels: secretLabels },
      ]);
      const cell = graph.nodes.find((node) => node.kind === "cell");
      expect(cell?.address).toBe("/of:fid1:abc");
      expect(cell?.labels?.confidentiality).toEqual(["Secret"]);
    });
  });

  describe("consoleRunFamilyGraph()", () => {
    it("joins a parent's named cell to the child pattern that made it", () => {
      const parentSteps = consoleRunSteps([
        call("c1", "delegate_task", { goal: "build it" }),
        result("c1", "delegate_task", {
          subagent: { childRunId: "r.subagent.1", status: "completed" },
        }),
        call("c2", "assign_slug", { token: "cfh:a:ppppp", slug: "books" }),
        result("c2", "assign_slug", { status: "ok", slug: "books" }),
      ]);
      const childSteps = consoleRunSteps([
        call("d1", "run_pattern", { sourceText: "x" }),
        result("d1", "run_pattern", { status: "ok", resultRef: "cfh:a:kkkkk" }),
      ]);
      const graph = consoleRunFamilyGraph(
        {
          runId: "r",
          steps: parentSteps,
          handles: [handle("cfh:a:ppppp", "/of:same")],
        },
        [{
          runId: "r.subagent.1",
          steps: childSteps,
          handles: [handle("cfh:a:kkkkk", "/of:same")],
        }],
      );
      const cells = graph.nodes.filter((node) => node.kind === "cell");
      expect(cells).toHaveLength(1);
      expect(cells[0].slug).toBe("books");
      // The child's pattern and the parent's slug meet on one cell, which a
      // per-run graph would have split in two.
      expect(graph.edges.filter((edge) => edge.kind === "produces"))
        .toHaveLength(1);
    });

    it("keeps the labels whichever run of the family read them", () => {
      const parentSteps = consoleRunSteps([
        call("c1", "delegate_task", { goal: "build it" }),
        result("c1", "delegate_task", {
          subagent: { childRunId: "r.subagent.1", status: "completed" },
        }),
        call("c2", "assign_slug", { token: "cfh:a:ppppp", slug: "books" }),
        result("c2", "assign_slug", { status: "ok", slug: "books" }),
      ]);
      const childSteps = consoleRunSteps([
        call("d1", "run_pattern", { sourceText: "x" }),
        result("d1", "run_pattern", { status: "ok", resultRef: "cfh:a:kkkkk" }),
      ]);
      const graph = consoleRunFamilyGraph(
        {
          runId: "r",
          steps: parentSteps,
          handles: [handle("cfh:a:ppppp", "/of:same")],
        },
        [{
          runId: "r.subagent.1",
          steps: childSteps,
          handles: [
            { ...handle("cfh:a:kkkkk", "/of:same"), labels: secretLabels },
          ],
        }],
      );
      const cells = graph.nodes.filter((node) => node.kind === "cell");
      // One cell, and the child is the run that read the space for it.
      expect(cells).toHaveLength(1);
      expect(cells[0].labels?.confidentiality).toEqual(["Secret"]);
    });

    it("keeps a cell partial when the root did not finish reading it", () => {
      // The child read the cell whole. Taking its reading alone would drop
      // the root's truncation and show the cell as fully read.
      expect(familyCellLabels(truncatedLabels, secretLabels)).toEqual(
        foldedLabels,
      );
    });

    it("keeps a cell partial when a child did not finish reading it", () => {
      // The same two readings, met in the other order. Every field of the
      // fold is an OR or a union, so the answer cannot depend on the order.
      expect(familyCellLabels(secretLabels, truncatedLabels)).toEqual(
        foldedLabels,
      );
    });

    it("visits a run once when a delegation points back at an ancestor", () => {
      const steps = consoleRunSteps([
        call("c1", "delegate_task", { goal: "loop" }),
        result("c1", "delegate_task", {
          subagent: { childRunId: "r", status: "completed" },
        }),
      ]);
      // A cycle would otherwise recurse until the stack gave out.
      const graph = consoleRunFamilyGraph(
        { runId: "r", steps, handles: [] },
        [{ runId: "r", steps, handles: [] }],
      );
      expect(graph.nodes.filter((node) => node.kind === "pattern")).toEqual([]);
    });

    it("dates a child's nodes to the step that delegated into it", () => {
      const parentSteps = consoleRunSteps([
        { role: "user", content: "go" },
        call("c1", "delegate_task", { goal: "build it" }),
        result("c1", "delegate_task", {
          subagent: { childRunId: "r.subagent.1", status: "completed" },
        }),
      ]);
      const childSteps = consoleRunSteps([
        call("d1", "run_pattern", { sourceText: "x" }),
        result("d1", "run_pattern", { status: "ok", resultRef: "cfh:a:kkkkk" }),
      ]);
      const graph = consoleRunFamilyGraph(
        { runId: "r", steps: parentSteps, handles: [] },
        [{
          runId: "r.subagent.1",
          steps: childSteps,
          handles: [handle("cfh:a:kkkkk", "/of:c")],
        }],
      );
      // The delegate_task call is the parent's step 1.
      expect(graph.nodes.every((node) => node.atStep === 1)).toBe(true);
    });
  });

  describe("consoleGraphAtStep()", () => {
    it("holds back what had not happened yet", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
        call("c2", "run_pattern", { sourceText: "y" }),
        result("c2", "run_pattern", { status: "ok", resultRef: "cfh:a:bbbbb" }),
      ]);
      const graph = consoleRunGraph(steps, [
        handle("cfh:a:aaaaa", "/of:a"),
        handle("cfh:a:bbbbb", "/of:b"),
      ]);
      expect(graph.nodes).toHaveLength(4);
      const early = consoleGraphAtStep(graph, 0);
      expect(early.nodes).toHaveLength(2);
      expect(early.edges).toHaveLength(1);
    });

    it("drops an edge whose other end has not appeared", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
      ]);
      const graph = consoleRunGraph(steps, [handle("cfh:a:aaaaa", "/of:a")]);
      expect(consoleGraphAtStep(graph, -1).edges).toHaveLength(0);
    });
  });
});
