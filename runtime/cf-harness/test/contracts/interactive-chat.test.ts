import { expect } from "@std/expect";

import {
  createHarnessChatEventEnvelope,
  createHarnessChatSessionStatus,
  type HarnessChatSessionStatus,
  type HarnessChatStructuredEvent,
  reduceHarnessChatSessionStatus,
} from "../../src/contracts/interactive-chat.ts";
import { describe, it } from "@commonfabric/test-support/test";

const CREATED_AT = "2026-05-22T00:00:00.000Z";
const EMITTED_AT = "2026-05-22T00:05:00.000Z";

const runningSession = (
  status: HarnessChatSessionStatus["status"] = "turn_running",
): HarnessChatSessionStatus => ({
  ...createHarnessChatSessionStatus({
    sessionId: "session-1",
    createdAt: CREATED_AT,
  }),
  status,
  turnCount: 1,
  activeTurnId: "turn-1",
  activeTurn: {
    turnId: "turn-1",
    status: "running",
    startedAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
});

const reduce = (
  status: HarnessChatSessionStatus,
  event: HarnessChatStructuredEvent,
): HarnessChatSessionStatus =>
  reduceHarnessChatSessionStatus(
    status,
    createHarnessChatEventEnvelope({
      sessionId: status.sessionId,
      sequence: 2,
      emittedAt: EMITTED_AT,
      event,
    }),
  );

describe("interactive-chat", () => {
  describe("reduceHarnessChatSessionStatus()", () => {
    const endings: readonly HarnessChatStructuredEvent[] = [
      { kind: "turn_completed", turnId: "turn-1", finalText: "done" },
      {
        kind: "turn_failed",
        turnId: "turn-1",
        error: { code: "internal_error", message: "boom" },
      },
    ];

    for (const ending of endings) {
      describe(ending.kind, () => {
        it("returns a running session to a reusable idle state without its turn", () => {
          const next = reduce(runningSession(), ending);
          expect(next.status).toBe("idle");
          expect(next.reusable).toBe(true);
          expect(next.activeTurnId).toBeUndefined();
          expect(next.activeTurn).toBeUndefined();
          expect(next.updatedAt).toBe(EMITTED_AT);
        });

        for (const terminal of ["closed", "failed"] as const) {
          it(`keeps a ${terminal} session ${terminal} and not reusable`, () => {
            const next = reduce(runningSession(terminal), ending);
            expect(next.status).toBe(terminal);
            expect(next.reusable).toBe(false);
            expect(next.activeTurnId).toBeUndefined();
            expect(next.activeTurn).toBeUndefined();
            expect(next.updatedAt).toBe(EMITTED_AT);
          });
        }
      });
    }

    describe("error", () => {
      it("touches only the update time of a session on a nonfatal error", () => {
        const before = runningSession();
        const next = reduce(before, {
          kind: "error",
          error: { code: "internal_error", message: "transient" },
        });
        expect(next).toEqual({ ...before, updatedAt: EMITTED_AT });
      });

      it("fails a session and drops its turn on a fatal error", () => {
        const next = reduce(runningSession(), {
          kind: "error",
          error: { code: "internal_error", message: "fatal" },
          fatal: true,
        });
        expect(next.status).toBe("failed");
        expect(next.reusable).toBe(false);
        expect(next.activeTurnId).toBeUndefined();
        expect(next.activeTurn).toBeUndefined();
        expect(next.updatedAt).toBe(EMITTED_AT);
      });
    });
  });
});
