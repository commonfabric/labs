import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import type {
  HistoryStep,
  PieceSourceRevisionView,
  PieceSourceView,
} from "@commonfabric/runtime-client";
import { describe, it } from "@commonfabric/test-support/test";

import { withOlderSteps, withPatternChanges } from "../src/space-history.ts";

describe("space-history", () => {
  const space = "did:key:z6Mk-lib-shell-space-history" as DID;

  /** The moment the cases count from, on a whole second. */
  const T0 = Date.parse("2026-03-01T12:00:00.000Z");

  /** A `write` step numbered `seq` that began `ms` after `T0`. */
  function stepAt(seq: number, ms: number): HistoryStep {
    return {
      seq,
      startSeq: seq,
      at: new Date(T0 + ms).toISOString(),
      kind: "write",
      events: 0,
      writes: 1,
      settled: true,
    };
  }

  /** An `edit` revision named `revisionId`, made `ms` after `T0`. */
  function revisionAt(
    revisionId: string,
    ms: number,
    extra: Partial<PieceSourceRevisionView> = {},
  ): PieceSourceRevisionView {
    return {
      revisionId,
      timestamp: T0 + ms,
      pattern: { identity: `identity-of-${revisionId}`, symbol: "default" },
      operation: "edit",
      ...extra,
    };
  }

  /** The source of the piece `pieceId`, holding `history`. */
  function sourceOf(
    pieceId: string,
    history: PieceSourceRevisionView[],
    extra: Partial<PieceSourceView> = {},
  ): PieceSourceView {
    return { space, pieceId, files: [], history, ...extra };
  }

  /** The revision ids each step of `steps` took, by the step's seq. */
  function revisionsBySeq(
    steps: ReturnType<typeof withPatternChanges>,
  ): Record<number, string[]> {
    return Object.fromEntries(
      steps.map((step) => [
        step.seq,
        step.patternChanges.map((change) => change.revisionId),
      ]),
    );
  }

  describe("withPatternChanges()", () => {
    it("returns each step's own fields with no pattern changes, given no source", () => {
      const steps: HistoryStep[] = [
        {
          ...stepAt(9, 5000),
          kind: "restore",
          restoredSeq: 4,
          principal: "did:key:z6Mk-someone",
          settled: false,
        },
        { ...stepAt(7, 0), startSeq: 5, kind: "event", events: 2, writes: 3 },
      ];

      expect(withPatternChanges(steps, [])).toEqual([
        { ...steps[0], patternChanges: [] },
        { ...steps[1], patternChanges: [] },
      ]);
    });

    it("returns new steps, leaving the ones it was given without `patternChanges`", () => {
      const steps = [stepAt(1, 0)];

      const result = withPatternChanges(steps, [
        { source: sourceOf("piece-a", [revisionAt("r1", 0)]) },
      ]);

      expect(result[0]).not.toBe(steps[0]);
      expect(steps).toEqual([stepAt(1, 0)]);
    });

    it("gives a revision to the earliest step that began at or after its time, and to no other", () => {
      const steps = [stepAt(3, 20_000), stepAt(2, 10_000), stepAt(1, 0)];

      const result = withPatternChanges(steps, [
        { source: sourceOf("piece-a", [revisionAt("r1", 4000)]) },
      ]);

      expect(revisionsBySeq(result)).toEqual({ 3: [], 2: ["r1"], 1: [] });
    });

    it("gives a revision to a step that began at exactly its time", () => {
      const steps = [stepAt(2, 10_000), stepAt(1, 0)];

      const result = withPatternChanges(steps, [
        { source: sourceOf("piece-a", [revisionAt("r1", 0)]) },
      ]);

      expect(revisionsBySeq(result)).toEqual({ 2: [], 1: ["r1"] });
    });

    describe("the one-second grain of a step's time", () => {
      it("gives a revision to a step whose second is the one the revision was made later in", () => {
        const steps = [stepAt(2, 10_000), stepAt(1, 0)];

        const result = withPatternChanges(steps, [
          { source: sourceOf("piece-a", [revisionAt("r1", 999)]) },
        ]);

        expect(revisionsBySeq(result)).toEqual({ 2: [], 1: ["r1"] });
      });

      it("gives a revision made a whole second after a step began to the next step", () => {
        const steps = [stepAt(2, 10_000), stepAt(1, 0)];

        const result = withPatternChanges(steps, [
          { source: sourceOf("piece-a", [revisionAt("r1", 1000)]) },
        ]);

        expect(revisionsBySeq(result)).toEqual({ 2: ["r1"], 1: [] });
      });
    });

    describe("the sixty seconds a step may begin after a revision", () => {
      it("gives a revision to a step that began just under sixty seconds after it", () => {
        const result = withPatternChanges([stepAt(1, 59_999)], [
          { source: sourceOf("piece-a", [revisionAt("r1", 0)]) },
        ]);

        expect(revisionsBySeq(result)).toEqual({ 1: ["r1"] });
      });

      it("leaves out a revision made sixty seconds or more before every step", () => {
        const result = withPatternChanges(
          [stepAt(2, 120_000), stepAt(1, 60_000)],
          [{
            source: sourceOf("piece-a", [
              revisionAt("r1", 0),
              revisionAt("r2", -3_600_000),
            ]),
          }],
        );

        expect(revisionsBySeq(result)).toEqual({ 2: [], 1: [] });
      });

      it("leaves out a revision whose first later step began too late, though a step after that one is listed", () => {
        // The revision falls in a gap: the step before it is too early to be
        // its commit, and the first one after it is past the window.

        const result = withPatternChanges(
          [stepAt(2, 200_000), stepAt(1, 0)],
          [{ source: sourceOf("piece-a", [revisionAt("r1", 100_000)]) }],
        );

        expect(revisionsBySeq(result)).toEqual({ 2: [], 1: [] });
      });
    });

    it("leaves out a revision made a second or more after every step began", () => {
      const result = withPatternChanges([stepAt(2, 10_000), stepAt(1, 0)], [
        { source: sourceOf("piece-a", [revisionAt("r1", 11_000)]) },
      ]);

      expect(revisionsBySeq(result)).toEqual({ 2: [], 1: [] });
    });

    it("returns no changes for any revision, given no step", () => {
      expect(
        withPatternChanges([], [
          { source: sourceOf("piece-a", [revisionAt("r1", 0)]) },
        ]),
      ).toEqual([]);
    });

    it("lists the revisions of several pieces on one step oldest first, whatever order they arrive in", () => {
      const result = withPatternChanges([stepAt(2, 10_000), stepAt(1, 0)], [
        {
          source: sourceOf("piece-a", [
            revisionAt("a-late", 9500),
            revisionAt("a-early", 2000),
          ]),
        },
        {
          source: sourceOf("piece-b", [
            revisionAt("b-middle", 5000),
            revisionAt("b-other-step", -500),
          ]),
        },
      ]);

      expect(revisionsBySeq(result)).toEqual({
        2: ["a-early", "b-middle", "a-late"],
        1: ["b-other-step"],
      });
      expect(result[0].patternChanges.map((change) => change.pieceId)).toEqual([
        "piece-a",
        "piece-b",
        "piece-a",
      ]);
    });

    it("marks as current the revision the piece's source names, and no other", () => {
      const [step] = withPatternChanges([stepAt(1, 10_000)], [
        {
          source: sourceOf(
            "piece-a",
            [revisionAt("r1", 1000), revisionAt("r2", 2000)],
            { currentRevisionId: "r2" },
          ),
        },
        // A source naming no current revision has none.
        { source: sourceOf("piece-b", [revisionAt("r2", 3000)]) },
      ]);

      expect(
        step.patternChanges.map((change) => [change.pieceId, change.current]),
      ).toEqual([["piece-a", false], ["piece-a", true], ["piece-b", false]]);
    });

    it("carries the piece's name, the scope, and the revision's origin with the labels of its operation and origin", () => {
      const origin = { url: "cf:piece:origin", kind: "fabric-piece" } as const;

      const [step] = withPatternChanges([stepAt(1, 0)], [
        {
          source: sourceOf(
            "piece-a",
            [revisionAt("r1", 0, { operation: "origin-update", origin })],
            { name: "Shopping list" },
          ),
          scope: "user",
        },
      ]);

      expect(step.patternChanges).toEqual([{
        pieceId: "piece-a",
        scope: "user",
        pieceName: "Shopping list",
        revisionId: "r1",
        madeAt: T0,
        operation: "origin-update",
        label: "Source update",
        pattern: { identity: "identity-of-r1", symbol: "default" },
        origin,
        originLabel: "Fabric piece",
        current: false,
      }]);
    });

    it("returns a change with no `pieceName`, `scope` or `origin` member where there is none, and the detached origin label", () => {
      const [step] = withPatternChanges([stepAt(1, 0)], [
        {
          source: sourceOf("piece-a", [
            revisionAt("r1", 0, { operation: "detach" }),
          ]),
        },
      ]);

      // `toStrictEqual` tells an absent member from one holding `undefined`.
      expect(step.patternChanges).toStrictEqual([{
        pieceId: "piece-a",
        revisionId: "r1",
        madeAt: T0,
        operation: "detach",
        label: "Stopped following source",
        pattern: { identity: "identity-of-r1", symbol: "default" },
        originLabel: "Detached",
        current: false,
      }]);
    });
  });

  describe("withOlderSteps()", () => {
    /** `steps` with the changes `sources` place on them standing alone. */
    const page = (steps: HistoryStep[], history: PieceSourceRevisionView[]) =>
      withPatternChanges(steps, [{ source: sourceOf("piece-a", history) }]);

    it("returns the listed steps followed by the older ones, each with its own fields", () => {
      const listed = page([stepAt(4, 30_000), stepAt(3, 20_000)], []);
      const older = page(
        [{ ...stepAt(2, 10_000), kind: "event", events: 2 }, stepAt(1, 0)],
        [],
      );

      expect(withOlderSteps(listed, older)).toEqual([...listed, ...older]);
    });

    it("moves a change the listed stretch placed on its oldest step to the older step it was made during, once", () => {
      // The revision was made just under a minute before the oldest listed
      // step, which takes it while nothing older is listed. Its own step is
      // the one that began as it was made, which the older page holds, and
      // which places it too.
      const history = [revisionAt("r1", 1000)];
      const listed = page([stepAt(3, 70_000), stepAt(2, 60_000)], history);
      const older = page([stepAt(1, 1000), stepAt(0, -50_000)], history);
      expect(revisionsBySeq(listed)).toEqual({ 3: [], 2: ["r1"] });
      expect(revisionsBySeq(older)).toEqual({ 1: ["r1"], 0: [] });

      expect(revisionsBySeq(withOlderSteps(listed, older))).toEqual({
        3: [],
        2: [],
        1: ["r1"],
        0: [],
      });
    });

    it("moves such a change though the older stretch, read without the piece, placed it nowhere", () => {
      const listed = page(
        [stepAt(2, 60_000)],
        [revisionAt("r1", 1000)],
      );
      const older = page([stepAt(1, 1000)], []);

      expect(revisionsBySeq(withOlderSteps(listed, older))).toEqual({
        2: [],
        1: ["r1"],
      });
    });

    it("leaves a change on the listed step it was made during, and an older step's on that one", () => {
      const history = [revisionAt("r2", 60_000), revisionAt("r1", 0)];
      const listed = page([stepAt(3, 70_000), stepAt(2, 60_000)], history);
      const older = page([stepAt(1, 0)], history);

      expect(revisionsBySeq(withOlderSteps(listed, older))).toEqual({
        3: [],
        2: ["r2"],
        1: ["r1"],
      });
    });

    it("lists the changes of both stretches that land on one step oldest first", () => {
      const listed = page([stepAt(2, 60_000)], [revisionAt("second", 500)]);
      const older = withPatternChanges([stepAt(1, 1000)], [
        { source: sourceOf("piece-b", [revisionAt("first", 200)]) },
      ]);

      expect(revisionsBySeq(withOlderSteps(listed, older))).toEqual({
        2: [],
        1: ["first", "second"],
      });
    });

    it("keeps the older stretch's copy of a change both stretches hold", () => {
      // The older stretch was read later, so what it says of whether the
      // piece is on the revision is the newer word.
      const listed = withPatternChanges([stepAt(2, 60_000)], [
        { source: sourceOf("piece-a", [revisionAt("r1", 1000)]) },
      ]);
      const older = withPatternChanges([stepAt(1, 1000)], [{
        source: sourceOf("piece-a", [revisionAt("r1", 1000)], {
          currentRevisionId: "r1",
          name: "Renamed",
        }),
      }]);
      expect(listed[0].patternChanges[0].current).toBe(false);

      const [, step] = withOlderSteps(listed, older);

      expect(step.patternChanges).toHaveLength(1);
      expect(step.patternChanges[0].current).toBe(true);
      expect(step.patternChanges[0].pieceName).toBe("Renamed");
    });

    it("keeps apart the changes of two pieces to revisions of one id", () => {
      const listed = withPatternChanges([stepAt(2, 60_000)], [
        { source: sourceOf("piece-a", [revisionAt("r1", 60_000)]) },
      ]);
      const older = withPatternChanges([stepAt(1, 0)], [
        { source: sourceOf("piece-b", [revisionAt("r1", 0)]) },
      ]);

      const merged = withOlderSteps(listed, older);

      expect(
        merged.map((step) =>
          step.patternChanges.map((change) => change.pieceId)
        ),
      ).toEqual([["piece-a"], ["piece-b"]]);
    });

    it("keeps both changes of one piece to one revision that the two stretches read in different scopes", () => {
      const history = [revisionAt("r1", 1000)];
      const listed = withPatternChanges([stepAt(2, 60_000)], [
        { source: sourceOf("piece-a", history), scope: "user" },
      ]);
      const older = withPatternChanges([stepAt(1, 1000)], [
        { source: sourceOf("piece-a", history), scope: "session" },
      ]);

      const [newer, step] = withOlderSteps(listed, older);

      expect(newer.patternChanges).toEqual([]);
      expect(
        step.patternChanges.map((change) => [
          change.pieceId,
          change.revisionId,
          change.scope,
        ]),
      ).toEqual([["piece-a", "r1", "user"], ["piece-a", "r1", "session"]]);
    });

    it("keeps one change, the older stretch's, where one stretch read it in the scope `space` and the other in none", () => {
      const history = [revisionAt("r1", 1000)];
      const scoped = {
        source: sourceOf("piece-a", history),
        scope: "space",
      } as const;
      const plain = { source: sourceOf("piece-a", history) };

      const scopedLast = withOlderSteps(
        withPatternChanges([stepAt(2, 60_000)], [plain]),
        withPatternChanges([stepAt(1, 1000)], [scoped]),
      );
      const plainLast = withOlderSteps(
        withPatternChanges([stepAt(2, 60_000)], [scoped]),
        withPatternChanges([stepAt(1, 1000)], [plain]),
      );

      expect(scopedLast[1].patternChanges.map((change) => change.scope))
        .toEqual(["space"]);
      expect(plainLast[1].patternChanges.map((change) => change.scope))
        .toEqual([undefined]);
      expect(scopedLast[0].patternChanges).toEqual([]);
      expect(plainLast[0].patternChanges).toEqual([]);
    });

    it("returns the listed steps and their changes, given no older step", () => {
      const listed = page([stepAt(2, 60_000), stepAt(1, 0)], [
        revisionAt("r2", 59_000),
        revisionAt("r1", 0),
      ]);

      const merged = withOlderSteps(listed, []);

      expect(merged).toEqual(listed);
      expect(merged[0]).not.toBe(listed[0]);
    });

    it("returns the older steps and their changes, given no listed step", () => {
      const older = page([stepAt(1, 0)], [revisionAt("r1", 0)]);

      expect(withOlderSteps([], older)).toEqual(older);
    });

    it("returns no step, given none", () => {
      expect(withOlderSteps([], [])).toEqual([]);
    });
  });
});
