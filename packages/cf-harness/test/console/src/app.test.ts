import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  consoleEventPiece,
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
  pieceUrls: [],
});

/** A space created with a random key, which only its DID addresses. */
const CREATED_SPACE =
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/** A completed `assign_slug` tool event, as the model read its result. */
const named = (summary: Record<string, unknown>) => ({
  kind: "tool_completed" as const,
  turnId: "turn",
  tool: { toolCallId: "call", toolId: "assign_slug" },
  status: "completed" as const,
  resultSummary: JSON.stringify(summary),
});

describe("console/src/app", () => {
  describe("consoleEventPiece()", () => {
    it("returns the piece `assign_slug` told the model the address of", () => {
      expect(consoleEventPiece(named({
        status: "ok",
        slug: "reading-list",
        url: "http://localhost:8000/my-space/reading-list",
      }))).toEqual({
        slug: "reading-list",
        url: "http://localhost:8000/my-space/reading-list",
      });
    });

    it("returns the piece a completed turn's result names in a space created by DID", () => {
      // The model is told the slug alone there, so the link is the one the
      // console composed into the turn's result.
      const url = `http://localhost:8000/${CREATED_SPACE}/reading-list`;
      expect(consoleEventPiece(named({ status: "ok", slug: "reading-list" })))
        .toBeUndefined();
      expect(consoleEventPiece({
        kind: "turn_completed",
        turnId: "turn",
        outcome: "completed",
        finalText: "done",
        result: {
          outcome: "completed",
          sessionId: "session",
          continuable: true,
          looms: [],
          pieces: [{ slug: "draft", url: "http://x.test/a" }, {
            slug: "reading-list",
            url,
          }],
          spaceName: CREATED_SPACE,
          finalText: "done",
        },
      })).toEqual({ slug: "reading-list", url });
    });

    it("returns nothing for a turn that named no piece", () => {
      expect(consoleEventPiece({
        kind: "turn_completed",
        turnId: "turn",
        outcome: "completed",
        finalText: "done",
        result: {
          outcome: "completed",
          sessionId: "session",
          continuable: true,
          looms: [],
          pieces: [],
          spaceName: CREATED_SPACE,
          finalText: "done",
        },
      })).toBeUndefined();
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
