/**
 * The loader's job is to survive the trees it will actually be pointed at:
 * runs written before an artifact existed, runs interrupted mid-write, and
 * runs from a generation whose shapes have since moved on. What it must never
 * do is throw, and what it must never do quietly is report an artifact it did
 * not read as one it read and found clean.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { auditRunFamily } from "../checks/structural.ts";
import {
  discoverRunFamilies,
  loadRunEvidence,
  loadRunFamily,
} from "../evidence.ts";

/**
 * Builds a tree of files under a temporary directory, hands the directory to
 * `body`, and removes it afterwards.
 *
 * A key is a path relative to the directory; a `/` in one makes the parent
 * directories it names.
 */
const withTree = async (
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: "cfc-audit-evidence-" });
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await Deno.mkdir(join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, contents);
    }
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

/** The smallest run state the loader admits, as a run would persist it. */
const runState = (runId: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    runId,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    cfcEnforcementMode: "enforce-explicit",
    currentDir: "/workspace",
    policyEvents: [],
    toolOutputs: [],
    ...extra,
  });

describe("evidence", () => {
  describe("loadRunEvidence()", () => {
    it("reports every artifact of an empty directory as absent", async () => {
      await withTree({ "run/.keep": "" }, async (root) => {
        const run = await loadRunEvidence(join(root, "run"));

        expect(run.runState.status).toBe("absent");
        expect(run.transcript.status).toBe("absent");
        expect(run.runReport.status).toBe("absent");
        expect(run.policyTrace.status).toBe("absent");
        expect(run.policySnapshot.status).toBe("absent");
        expect(run.cellLabels.status).toBe("absent");
        expect(run.toolOutputs.status).toBe("absent");
      });
    });

    it("names the directory as the run when no run state names one", async () => {
      await withTree({ "orphan-run/.keep": "" }, async (root) => {
        expect((await loadRunEvidence(join(root, "orphan-run"))).runId).toBe(
          "orphan-run",
        );
      });
    });

    it("reports a half-written artifact as unparseable rather than absent", async () => {
      await withTree({
        "run/run-state.json": '{"runId": "half-writ',
      }, async (root) => {
        const state = (await loadRunEvidence(join(root, "run"))).runState;

        expect(state.status).toBe("unparseable");
        expect(
          state.status === "unparseable" ? state.detail : "",
        ).toContain("is not valid JSON");
      });
    });

    it("reports an artifact whose top level is the wrong shape as unparseable", async () => {
      await withTree({
        "run/run-state.json": runState("run"),
        "run/transcript.json": '{"messages": []}',
      }, async (root) => {
        const transcript = (await loadRunEvidence(join(root, "run")))
          .transcript;

        expect(transcript.status).toBe("unparseable");
        expect(
          transcript.status === "unparseable" ? transcript.detail : "",
        ).toBe("is not an array of transcript messages");
      });
    });

    it("keeps a tool output it could not parse, without its contents", async () => {
      await withTree({
        "run/run-state.json": runState("run"),
        "run/tool-outputs/one-bash.json": '{"outputId": "run:bash:1"}',
        "run/tool-outputs/two-bash.json": "not json at all",
      }, async (root) => {
        const outputs = (await loadRunEvidence(join(root, "run"))).toolOutputs;

        expect(outputs.status).toBe("present");
        expect(
          outputs.status === "present"
            ? outputs.entries.map((entry) => [
              entry.fileName,
              entry.value !== undefined,
            ])
            : [],
        ).toEqual([["one-bash.json", true], ["two-bash.json", false]]);
      });
    });

    it("reports a path it could not read at all as unparseable", async () => {
      // A directory where a file belongs is the readable stand-in for every
      // read that fails for a reason other than the file being absent.

      await withTree({ "run/run-state.json/inside.txt": "" }, async (root) => {
        const state = (await loadRunEvidence(join(root, "run"))).runState;

        expect(state.status).toBe("unparseable");
        expect(
          state.status === "unparseable" ? state.detail : "",
        ).toContain("could not be read");
      });
    });

    it("reports a `tool-outputs` that is not a directory as unparseable", async () => {
      await withTree({
        "run/run-state.json": runState("run"),
        "run/tool-outputs": "not a directory",
      }, async (root) => {
        const outputs = (await loadRunEvidence(join(root, "run"))).toolOutputs;

        expect(outputs.status).toBe("unparseable");
        expect(
          outputs.status === "unparseable" ? outputs.detail : "",
        ).toContain("could not be listed");
      });
    });

    it("loads a run state a newer generation added fields to", async () => {
      await withTree({
        "run/run-state.json": runState("run", {
          somethingThisReaderHasNoNameFor: { version: 9 },
        }),
      }, async (root) => {
        expect((await loadRunEvidence(join(root, "run"))).runId).toBe("run");
      });
    });
  });

  describe("loadRunFamily()", () => {
    it("returns a family of one when the parent directory cannot be listed", async () => {
      // A run directory nested under a plain file has no listable parent, so
      // no sibling is discoverable. The root is still the audit's subject.

      await withTree({ "afile": "" }, async (root) => {
        const family = await loadRunFamily(join(root, "afile", "run"));

        expect(family.children).toEqual([]);
        expect(family.root.runId).toBe("run");
      });
    });

    it("returns the children written beside the run, at any depth", async () => {
      await withTree({
        "runs/parent/run-state.json": runState("parent"),
        "runs/parent.subagent.1/run-state.json": runState("parent.subagent.1"),
        "runs/parent.subagent.1.subagent.1/run-state.json": runState(
          "parent.subagent.1.subagent.1",
        ),
        "runs/unrelated/run-state.json": runState("unrelated"),
      }, async (root) => {
        const family = await loadRunFamily(join(root, "runs", "parent"));

        expect(family.children.map((child) => child.runId)).toEqual([
          "parent.subagent.1",
          "parent.subagent.1.subagent.1",
        ]);
        expect(family.children.map((child) => child.parentRunId)).toEqual([
          "parent",
          "parent",
        ]);
      });
    });
  });

  describe("discoverRunFamilies()", () => {
    it("returns no family for a directory holding no run", async () => {
      await withTree({ "empty/nothing/.keep": "" }, async (root) => {
        expect(await discoverRunFamilies(join(root, "empty"))).toEqual([]);
      });
    });

    it("returns the one family for a run directory", async () => {
      await withTree({
        "runs/parent/run-state.json": runState("parent"),
        "runs/parent.subagent.1/run-state.json": runState("parent.subagent.1"),
      }, async (root) => {
        const families = await discoverRunFamilies(
          join(root, "runs", "parent"),
        );

        expect(families.map((family) => family.root.runId)).toEqual(["parent"]);
      });
    });

    it("returns one family per run under an artifact root's `runs`", async () => {
      await withTree({
        "console/runs/first/run-state.json": runState("first"),
        "console/runs/second/run-state.json": runState("second"),
        "console/runs/first.subagent.1/run-state.json": runState(
          "first.subagent.1",
        ),
      }, async (root) => {
        const families = await discoverRunFamilies(join(root, "console"));

        expect(families.map((family) => family.root.runId)).toEqual([
          "first",
          "second",
        ]);
      });
    });

    it("returns one family per run for a directory of run directories", async () => {
      await withTree({
        "v0-runs/first/run-state.json": runState("first"),
        "v0-runs/second/run-state.json": runState("second"),
      }, async (root) => {
        const families = await discoverRunFamilies(join(root, "v0-runs"));

        expect(families.map((family) => family.root.runId)).toEqual([
          "first",
          "second",
        ]);
      });
    });
  });

  describe("auditing what the loader returns", () => {
    it("returns a verdict for every check over a run with no artifacts", async () => {
      await withTree({ "run/.keep": "" }, async (root) => {
        const results = auditRunFamily(
          await loadRunFamily(join(root, "run")),
        );

        expect(new Set(results.map((result) => result.verdict))).toEqual(
          new Set(["inconclusive"]),
        );
      });
    });

    it("returns a verdict for every check over a run whose artifacts are all unparseable", async () => {
      await withTree({
        "run/run-state.json": "{",
        "run/transcript.json": "{",
        "run/run-report.json": "{",
        "run/policy-trace.json": "{",
      }, async (root) => {
        const results = auditRunFamily(
          await loadRunFamily(join(root, "run")),
        );

        expect(new Set(results.map((result) => result.verdict))).toEqual(
          new Set(["inconclusive"]),
        );
      });
    });
  });
});
