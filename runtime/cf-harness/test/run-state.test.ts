import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import {
  addHarnessDocsQueryFailures,
  createHarnessRunState,
  setHarnessRunStatus,
} from "../src/run-state.ts";

describe("run-state", () => {
  describe("setHarnessRunStatus()", () => {
    const completed = () =>
      createHarnessRunState({
        runId: "run-done",
        status: "completed",
        endedAt: "2026-09-02T00:00:01.000Z",
        terminalReason: "assistant_completed",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        now: "2026-09-02T00:00:00.000Z",
      });

    it("stamps `endedAt` and `terminalReason` with a terminal status", () => {
      const state = setHarnessRunStatus(
        createHarnessRunState({
          cfcEnforcementMode: "disabled",
          currentDir: "/workspace",
        }),
        "failed",
        "2026-09-02T00:00:02.000Z",
        "prompt_loop_error",
      );

      expect(state.status).toBe("failed");
      expect(state.endedAt).toBe("2026-09-02T00:00:02.000Z");
      expect(state.terminalReason).toBe("prompt_loop_error");
    });

    it("throws when a run that has its outcome is given another", () => {
      expect(() =>
        setHarnessRunStatus(
          completed(),
          "failed",
          "2026-09-02T00:00:02.000Z",
          "prompt_loop_error",
        )
      ).toThrow("run run-done is already completed");
    });

    it("clears `endedAt` and `terminalReason` when a resumed run goes back to `running`", () => {
      const state = setHarnessRunStatus(
        completed(),
        "running",
        "2026-09-02T00:00:02.000Z",
      );

      expect(state.status).toBe("running");
      expect(state.endedAt).toBeUndefined();
      expect(state.terminalReason).toBeUndefined();
    });
  });

  describe("createHarnessRunState()", () => {
    it("carries a defensive copy of a given handle table", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        `/of:fid1:${"A".repeat(43)}`,
      );

      const state = createHarnessRunState({
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        handleTable: table,
      });

      expect(state.handleTable).toEqual(table);
      expect(state.handleTable).not.toBe(table);
      table.entries.pop();
      expect(state.handleTable?.entries.length).toBe(1);
    });

    it("carries a defensive copy of given well-known grants", () => {
      const grants = [{
        name: "piece-registry" as const,
        token: "cfh:a:abcdefgh",
        ref: `/of:fid1:${"A".repeat(43)}/pieceRegistry`,
      }];

      const state = createHarnessRunState({
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        wellKnownGrants: grants,
      });

      expect(state.wellKnownGrants).toEqual(grants);
      expect(state.wellKnownGrants).not.toBe(grants);
      grants.pop();
      expect(state.wellKnownGrants?.length).toBe(1);
    });
  });

  describe("addHarnessDocsQueryFailures()", () => {
    const state = () =>
      createHarnessRunState({
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        now: "2026-09-02T00:00:00.000Z",
      });

    it("adds `count` to the failures the run already holds", () => {
      const once = addHarnessDocsQueryFailures(
        state(),
        2,
        "2026-09-02T00:00:01.000Z",
      );
      const twice = addHarnessDocsQueryFailures(
        once,
        3,
        "2026-09-02T00:00:02.000Z",
      );

      expect(once.docsQueryFailures).toBe(2);
      expect(twice.docsQueryFailures).toBe(5);
      expect(twice.updatedAt).toBe("2026-09-02T00:00:02.000Z");
    });

    it("returns the run itself when `count` is not positive", () => {
      const run = state();

      expect(addHarnessDocsQueryFailures(run, 0)).toBe(run);
      expect(addHarnessDocsQueryFailures(run, -1)).toBe(run);
    });
  });
});
