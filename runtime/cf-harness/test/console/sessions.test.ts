import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CONSOLE_TASK_PREVIEW_LIMIT,
  summarizeConsoleSessions,
} from "../../console/sessions.ts";
import {
  createHarnessChatSessionStatus,
  type HarnessChatSessionStatus,
  type HarnessChatTurnRecord,
} from "../../src/contracts/interactive-chat.ts";

const session = (
  sessionId: string,
  updatedAt: string,
  overrides: Partial<HarnessChatSessionStatus> = {},
): HarnessChatSessionStatus => ({
  ...createHarnessChatSessionStatus({
    sessionId,
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
  updatedAt,
  ...overrides,
});

const turn = (
  sessionId: string,
  turnId: string,
  startedAt: string,
  text: string,
): HarnessChatTurnRecord => ({
  sessionId,
  turn: {
    turnId,
    status: "completed",
    startedAt,
    updatedAt: startedAt,
  },
  input: { text },
  policy: createHarnessChatSessionStatus({ sessionId }).policy,
});

describe("console/sessions", () => {
  describe("summarizeConsoleSessions()", () => {
    it("carries the lifecycle a session list is chosen from", () => {
      const listing = summarizeConsoleSessions({
        sessions: [
          session("session-1", "2026-01-01T00:05:00.000Z", {
            status: "turn_running",
            reusable: false,
            turnCount: 3,
          }),
        ],
      }, []);

      expect(listing.sessions).toEqual([{
        sessionId: "session-1",
        status: "turn_running",
        reusable: false,
        turnCount: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
      }]);
    });

    it("names a session by the text of its earliest turn", () => {
      const listing = summarizeConsoleSessions({
        sessions: [session("session-1", "2026-01-01T00:05:00.000Z")],
      }, [
        turn("session-1", "turn-2", "2026-01-01T00:02:00.000Z", "and again"),
        turn("session-1", "turn-1", "2026-01-01T00:01:00.000Z", "track books"),
      ]);

      expect(listing.sessions[0].firstTaskText).toBe("track books");
    });

    it("ignores the turns of every other session", () => {
      const listing = summarizeConsoleSessions({
        sessions: [session("session-1", "2026-01-01T00:05:00.000Z")],
      }, [
        turn("session-2", "turn-1", "2026-01-01T00:01:00.000Z", "other work"),
      ]);

      expect(listing.sessions[0].firstTaskText).toBeUndefined();
    });

    it("elides a first task past the preview limit", () => {
      const listing = summarizeConsoleSessions({
        sessions: [session("session-1", "2026-01-01T00:05:00.000Z")],
      }, [
        turn(
          "session-1",
          "turn-1",
          "2026-01-01T00:01:00.000Z",
          "x".repeat(400),
        ),
      ]);

      expect(listing.sessions[0].firstTaskText).toBe(
        `${"x".repeat(CONSOLE_TASK_PREVIEW_LIMIT)}…`,
      );
    });

    it("orders the most recently touched session first", () => {
      const listing = summarizeConsoleSessions({
        sessions: [
          session("session-1", "2026-01-01T00:01:00.000Z"),
          session("session-3", "2026-01-01T00:09:00.000Z"),
          session("session-2", "2026-01-01T00:05:00.000Z"),
        ],
      }, []);

      expect(listing.sessions.map((entry) => entry.sessionId)).toEqual([
        "session-3",
        "session-2",
        "session-1",
      ]);
    });

    it("orders sessions touched at the same instant by identifier", () => {
      const listing = summarizeConsoleSessions({
        sessions: [
          session("session-b", "2026-01-01T00:01:00.000Z"),
          session("session-a", "2026-01-01T00:01:00.000Z"),
        ],
      }, []);

      expect(listing.sessions.map((entry) => entry.sessionId)).toEqual([
        "session-a",
        "session-b",
      ]);
    });
  });
});
