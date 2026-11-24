import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseSessionReport, SessionReportLog } from "../v2/session-reports.ts";
import { SESSION_REPORT_TEXT_MAX, type SessionReport } from "../v2.ts";

const trip: SessionReport = {
  kind: "echo-breaker",
  event: "trip",
  document: { id: "of:fid1:shared", scopeKey: "space" },
  action: "cf:module/abc:__cfLift_1:xyz",
};

const clear: SessionReport = {
  kind: "echo-breaker",
  event: "clear",
  document: { id: "of:fid1:shared", scopeKey: "space" },
  action: "cf:module/abc:__cfLift_1:xyz",
  reason: "convergence",
  renewals: 3,
  trippedMs: 4200,
};

describe("session-reports", () => {
  describe("parseSessionReport()", () => {
    it("returns a trip report holding only its defined fields", () => {
      expect(parseSessionReport({ ...trip, extra: "dropped" })).toEqual(trip);
    });

    it("returns a clear report with its reason and counts", () => {
      expect(parseSessionReport(clear)).toEqual(clear);
    });

    it("returns a report naming a session's scope instance", () => {
      const instance = {
        ...trip,
        document: {
          id: "of:fid1:shared",
          scopeKey: "session:did%3Akey%3Aalice:session-1",
        },
      };
      expect(parseSessionReport(instance)).toEqual(instance);
    });

    it("returns a clear by eviction", () => {
      const evicted = { ...clear, reason: "evicted" };
      expect(parseSessionReport(evicted)).toEqual(evicted);
    });

    it("returns `null` for a kind or an event it does not define", () => {
      expect(parseSessionReport({ ...trip, kind: "other" })).toBeNull();
      expect(parseSessionReport({ ...trip, event: "pause" })).toBeNull();
    });

    it("returns `null` for a scope key that is not canonical", () => {
      for (const scopeKey of ["global", "user:", "session:did:key:alice"]) {
        expect(
          parseSessionReport({
            ...trip,
            document: { id: "of:fid1:shared", scopeKey },
          }),
        ).toBeNull();
      }
      expect(
        parseSessionReport({
          ...trip,
          document: { id: "of:fid1:shared", scope: "space" },
        }),
      ).toBeNull();
    });

    it("returns `null` for text holding a line break or another control character", () => {
      // The server writes report text into its log, where a line break would
      // start a line of the client's choosing.

      expect(
        parseSessionReport({ ...trip, action: "cf:lift\n[memory] forged" }),
      ).toBeNull();
      expect(
        parseSessionReport({
          ...trip,
          document: { id: "of:fid1:shared\r", scopeKey: "space" },
        }),
      ).toBeNull();
      expect(parseSessionReport({ ...trip, action: "cf:\u007flift" }))
        .toBeNull();
    });

    it("returns `null` for a string longer than the protocol allows", () => {
      const long = "x".repeat(SESSION_REPORT_TEXT_MAX + 1);
      expect(parseSessionReport({ ...trip, action: long })).toBeNull();
      expect(
        parseSessionReport({
          ...trip,
          document: { id: long, scopeKey: "space" },
        }),
      ).toBeNull();
    });

    it("returns `null` for a clear whose count is negative or fractional", () => {
      expect(parseSessionReport({ ...clear, renewals: -1 })).toBeNull();
      expect(parseSessionReport({ ...clear, trippedMs: 1.5 })).toBeNull();
    });

    it("returns `null` for a clear reason it does not define", () => {
      expect(parseSessionReport({ ...clear, reason: "timeout" })).toBeNull();
    });
  });

  describe("SessionReportLog", () => {
    describe("instance members", () => {
      describe("record()", () => {
        it("returns the report stamped with the time, space, session, and principal", () => {
          const log = new SessionReportLog({ now: () => 1_000 });
          expect(
            log.record({
              space: "did:key:space",
              session: "session-1",
              principal: "did:key:alice",
              report: trip,
            }),
          ).toEqual({
            ...trip,
            at: 1_000,
            space: "did:key:space",
            session: "session-1",
            principal: "did:key:alice",
          });
        });
      });

      describe("report()", () => {
        it("counts trips, and clears by how they ended", () => {
          const log = new SessionReportLog();
          const entry = { space: "did:key:space", session: "session-1" };
          log.record({ ...entry, report: trip });
          log.record({ ...entry, report: trip });
          log.record({ ...entry, report: clear });
          log.record({
            ...entry,
            report: { ...clear, reason: "quiet" } as SessionReport,
          });
          expect(log.report().echoBreaker).toEqual({
            trips: 2,
            clears: { convergence: 1, quiet: 1, retired: 0, evicted: 0 },
          });
        });

        it("keeps the newest reports, oldest first, up to its capacity", () => {
          const log = new SessionReportLog({ recent: 2 });
          for (const session of ["one", "two", "three"]) {
            log.record({ space: "did:key:space", session, report: trip });
          }
          expect(log.report().recent.map((entry) => entry.session)).toEqual([
            "two",
            "three",
          ]);
          // The totals keep every report, not just the ones still listed.
          expect(log.report().echoBreaker.trips).toBe(3);
        });

        it("returns copies that changing does not change the log", () => {
          const log = new SessionReportLog();
          log.record({
            space: "did:key:space",
            session: "session-1",
            report: trip,
          });
          const first = log.report();
          first.recent[0].document.id = "of:fid1:changed";
          first.echoBreaker.clears.retired = 99;
          const second = log.report();
          expect(second.recent[0].document.id).toBe("of:fid1:shared");
          expect(second.echoBreaker.clears.retired).toBe(0);
        });
      });
    });
  });
});
