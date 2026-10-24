import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  consolePieceAfterTurn,
  freshConsoleRun,
} from "../../../console/src/app.ts";
import type {
  ConsoleListedRun,
  ConsoleRunSource,
} from "../../../console/run-store.ts";

/** A row with the fields that decide which run a turn opens. */
const row = (
  runId: string,
  source: ConsoleRunSource,
  parentRunId?: string,
): ConsoleListedRun => ({
  runId,
  source,
  parentRunId,
  status: "running",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  toolCallCount: 0,
  pieceSlugs: [],
});

describe("console/src/app", () => {
  describe("consolePieceAfterTurn()", () => {
    const piece = (slug: string) => ({
      slug,
      url: `http://localhost:8000/did:key:z6MkApp/${slug}`,
    });

    it("returns the last piece a turn named", () => {
      expect(
        consolePieceAfterTurn(
          [piece("draft"), piece("final")],
          piece("earlier"),
        ),
      ).toEqual(piece("final"));
    });

    it("keeps the piece already shown when a turn named none", () => {
      expect(consolePieceAfterTurn([], piece("earlier"))).toEqual(
        piece("earlier"),
      );
      expect(consolePieceAfterTurn([], undefined)).toBeUndefined();
    });
  });

  describe("freshConsoleRun()", () => {
    it("opens a new console parent while external runs and children appear first", () => {
      const runs = [
        row("asked", "ask"),
        row("agent", "agent"),
        row("old", "console"),
        row("child", "console", "parent"),
        row("fresh", "console"),
      ];
      expect(freshConsoleRun(runs, new Set(["old"]))?.runId).toBe("fresh");
    });

    it("leaves the run closed when only external runs, children and existing parents are present", () => {
      expect(
        freshConsoleRun([
          row("asked", "ask"),
          row("agent", "agent"),
          row("old", "console"),
          row("child", "console", "old"),
        ], new Set(["old"])),
      ).toBeUndefined();
      expect(freshConsoleRun([], new Set())).toBeUndefined();
    });
  });
});
