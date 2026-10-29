import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  canonicalPieceAddress,
  decodePlan,
  deriveRollbackPlan,
  encodePlan,
  type PiecePlan,
} from "../../src/ops/bulk-plan.ts";

const header = {
  kind: "piece-plan",
  v: 1,
  space: "did:key:test",
  takenAt: "2026-08-24T00:00:00.000Z",
  selector: "collection" as const,
  enumerated: { collection: 2, registry: 1, registeredOutside: 0 },
} as const;

function retargetPlan(): PiecePlan {
  return {
    header,
    rows: [
      {
        piece: "fid1:aaY",
        phase: "topics",
        expect: { patternIdentity: "old-a", symbol: "default", retained: true },
        op: {
          kind: "retarget",
          source: { main: "topic.tsx" },
          rev: "abc123",
          patternIdentity: "new-a",
          symbol: "default",
          allowIncompatible: true,
        },
      },
      {
        piece: "fid1:bbY",
        phase: "holder",
        expect: {
          patternIdentity: "old-b",
          symbol: "Board",
          retained: true,
          revisionId: "rev-b",
        },
        op: {
          kind: "retarget",
          source: { main: "main.tsx", mainExport: "Board" },
          patternIdentity: "new-b",
          symbol: "Board",
        },
      },
    ],
  };
}

/** The same plan with the holder row's prior source not retained. */
function unretainedPlan(): PiecePlan {
  const plan = retargetPlan();
  return {
    header,
    rows: [plan.rows[0], {
      ...plan.rows[1],
      expect: { ...plan.rows[1].expect, retained: false },
    }],
  };
}

describe("bulk-plan", () => {
  describe("encodePlan()", () => {
    it("returns the header line first, then one row per line, in order", () => {
      const lines = encodePlan(retargetPlan()).trimEnd().split("\n");
      expect(lines.length).toBe(3);
      expect(JSON.parse(lines[0]).kind).toBe("piece-plan");
      expect(JSON.parse(lines[1]).piece).toBe("fid1:aaY");
      expect(JSON.parse(lines[2]).piece).toBe("fid1:bbY");
    });

    it("returns text ending in a newline", () => {
      expect(encodePlan({ header, rows: [] }).endsWith("\n")).toBe(true);
    });
  });

  describe("decodePlan()", () => {
    it("returns the encoded plan unchanged on a round-trip", () => {
      const plan = retargetPlan();
      expect(decodePlan(encodePlan(plan))).toEqual(plan);
    });

    it("returns an op-less row as the pre-state record it is", () => {
      const row = {
        piece: "fid1:aaY",
        expect: { patternIdentity: "idA", symbol: "default", retained: true },
      };
      const decoded = decodePlan(
        JSON.stringify(header) + "\n" + JSON.stringify(row),
      );
      expect(decoded.rows[0]).toEqual(row);
    });

    it("returns the plan when blank lines were inserted by hand", () => {
      const text = encodePlan(retargetPlan()).replace("\n", "\n\n");
      expect(decodePlan(text)).toEqual(retargetPlan());
    });

    it("throws for empty text", () => {
      expect(() => decodePlan("\n\n")).toThrow("empty");
    });

    it("throws when the first line is not a piece-plan header", () => {
      const rowOnly = encodePlan(retargetPlan()).split("\n").slice(1).join(
        "\n",
      );
      expect(() => decodePlan(rowOnly)).toThrow("header");
    });

    it("throws when the first line is not an object at all", () => {
      expect(() => decodePlan('"hello"\n')).toThrow("header");
    });

    it("throws for a header whose enumerated counts are not numbers", () => {
      const bad = {
        ...header,
        enumerated: { collection: "3", registry: 0, registeredOutside: 0 },
      };
      expect(() => decodePlan(JSON.stringify(bad) + "\n")).toThrow("header");
    });

    it("throws for a row missing its precondition, naming the row", () => {
      const text = JSON.stringify(header) + "\n" +
        JSON.stringify({ piece: "fid1:aaY" }) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });

    it("throws for a precondition without its export symbol", () => {
      const text = JSON.stringify(header) + "\n" +
        JSON.stringify({
          piece: "fid1:aaY",
          expect: { patternIdentity: "x", retained: true },
        }) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });

    it("throws for a row that is not an object, and for a numeric piece", () => {
      const withNumber = JSON.stringify(header) + "\n5\n";
      expect(() => decodePlan(withNumber)).toThrow("row 1");
      const numericPiece = JSON.stringify(header) + "\n" +
        JSON.stringify({ piece: 7, expect: {} }) + "\n";
      expect(() => decodePlan(numericPiece)).toThrow("row 1");
    });

    it("refuses to derive a rollback across repair rows, naming them", () => {
      const plan = retargetPlan();
      const withRepair = {
        header: plan.header,
        rows: [{
          piece: plan.rows[0].piece,
          expect: { ...plan.rows[0].expect, documentHash: "9f2c" },
          op: {
            kind: "repair" as const,
            fixer: "fix-titles.ts",
            fixerIdentity: "impl-v1",
          },
        }],
      };
      expect(() => deriveRollbackPlan(withRepair, "later")).toThrow(
        "no derivable",
      );
      expect(() => deriveRollbackPlan(withRepair, "later")).toThrow(
        plan.rows[0].piece,
      );
    });

    it("returns a derived rollback unchanged on a round-trip", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(decodePlan(encodePlan(rollback))).toEqual(rollback);
    });

    it("throws for a phase that is not a string, and for an op that is not an object", () => {
      const plan = retargetPlan();
      const badPhase = { ...plan.rows[0], phase: 7 };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(badPhase))
      ).toThrow("row 1");
      const badOp = { ...plan.rows[0], op: 5 };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(badOp))
      ).toThrow("row 1");
    });

    it("throws for an empty symbol, and for an empty source export", () => {
      const plan = retargetPlan();
      const emptySymbol = {
        ...plan.rows[0],
        op: {
          kind: "restore",
          patternIdentity: "x",
          symbol: "",
        },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(emptySymbol))
      ).toThrow("row 1");
      // The resolver drops a falsy export and runs the default, so a row
      // saying "" would execute something its text does not say.
      // The symbol here is the one an empty export would resolve to, so the
      // refusal this case exercises is the export's, not the symbol's.
      const emptyExport = {
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: { main: "topic.tsx", mainExport: "" },
          patternIdentity: "x",
          symbol: "default",
        },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(emptyExport))
      ).toThrow("row 1");
    });

    it("throws for an empty revision, on a restore op and on an expectation", () => {
      const plan = retargetPlan();
      const emptyRestore = {
        ...plan.rows[0],
        op: {
          kind: "restore",
          patternIdentity: "x",
          symbol: "default",
          revisionId: "",
        },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(emptyRestore))
      ).toThrow("row 1");
      const emptyExpect = {
        ...plan.rows[0],
        op: undefined,
        expect: { ...plan.rows[0].expect, revisionId: "" },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(emptyExpect))
      ).toThrow("row 1");
    });

    it("throws for an empty origin on an expectation", () => {
      const plan = retargetPlan();
      const emptyOrigin = {
        ...plan.rows[0],
        expect: { ...plan.rows[0].expect, origin: "" },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(emptyOrigin))
      ).toThrow("row 1");
    });

    it("carries the origin a row records, and a row that records none", () => {
      const plan = retargetPlan();
      const following: PiecePlan = {
        header,
        rows: [
          {
            ...plan.rows[0],
            expect: {
              ...plan.rows[0].expect,
              origin: "https://origins.test/topic.tsx",
            },
          },
          plan.rows[1],
        ],
      };

      const decoded = decodePlan(encodePlan(following));

      expect(decoded.rows[0].expect.origin).toBe(
        "https://origins.test/topic.tsx",
      );
      // The field is additive: a row that records no origin is a valid row,
      // so every plan an earlier survey wrote is still a plan.
      expect(decoded.rows[1].expect.origin).toBeUndefined();
    });

    it("throws for an enumeration count that no selection can produce", () => {
      for (const collection of [-1, 2.5, Number.NaN]) {
        const bad = {
          ...header,
          enumerated: { ...header.enumerated, collection },
        };
        expect(() => decodePlan(JSON.stringify(bad) + "\n")).toThrow("header");
      }
    });

    it("carries a repair row only with its document-hash precondition", () => {
      const plan = retargetPlan();
      const repairRow = {
        piece: plan.rows[0].piece,
        phase: plan.rows[0].phase,
        expect: { ...plan.rows[0].expect, documentHash: "9f2c" },
        op: {
          kind: "repair",
          fixer: "fix-titles.ts",
          fixerIdentity: "impl-v1",
        },
      };
      const good = JSON.stringify(header) + "\n" + JSON.stringify(repairRow);
      expect(decodePlan(good).rows[0].op).toEqual({
        kind: "repair",
        fixer: "fix-titles.ts",
        fixerIdentity: "impl-v1",
      });
      const hashless = {
        ...repairRow,
        expect: { ...plan.rows[0].expect },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(hashless))
      ).toThrow("row 1");
      const nameless = {
        ...repairRow,
        op: { kind: "repair", fixer: "", fixerIdentity: "impl-v1" },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(nameless))
      ).toThrow("row 1");
      // A repair op without its implementation pin is the bypass the codec
      // exists to refuse: nothing could hold the run to what was reviewed.
      const pinless = {
        ...repairRow,
        op: { kind: "repair", fixer: "fix-titles.ts" },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(pinless))
      ).toThrow("row 1");
    });

    it("throws for a restore op whose revision is not a string", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: {
          kind: "restore",
          patternIdentity: "x",
          symbol: "default",
          revisionId: 7,
        },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(row))
      ).toThrow("row 1");
    });

    it("throws when the outside count and the outside list disagree", () => {
      const laundered = {
        ...header,
        enumerated: { ...header.enumerated, registeredOutside: 3 },
      };
      expect(() => decodePlan(JSON.stringify(laundered) + "\n")).toThrow(
        "header",
      );
    });

    it("throws for an empty phase", () => {
      const plan = retargetPlan();
      const empty = { ...plan.rows[0], op: undefined, phase: "" };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(empty))
      ).toThrow("row 1");
    });

    it("throws for a piece that is not a piece address", () => {
      const plan = retargetPlan();
      for (const bad of ["", "garbage", "of:"]) {
        const row = { ...plan.rows[0], piece: bad };
        expect(() =>
          decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(row))
        ).toThrow("Not a piece address");
      }
    });

    it("throws for an empty precondition reference", () => {
      const plan = retargetPlan();
      const emptySymbol = {
        ...plan.rows[0],
        op: undefined,
        expect: { ...plan.rows[0].expect, symbol: "" },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(emptySymbol))
      ).toThrow("row 1");
    });

    it("throws for an op that produces the reference the row records", () => {
      const plan = retargetPlan();
      const noop = {
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: { main: "topic.tsx" },
          patternIdentity: plan.rows[0].expect.patternIdentity,
          symbol: plan.rows[0].expect.symbol,
        },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(noop))
      ).toThrow("row 1");
    });

    it("round-trips an incomplete header, and rollback derivation refuses it", () => {
      const incomplete = {
        header: {
          ...header,
          enumerated: { ...header.enumerated, registeredOutside: 1 },
          problems: [{ piece: "fid1:ccc", problem: "carries no identity" }],
          outside: [{
            piece: "fid1:ddc",
            patternIdentity: "idA",
            symbol: "default",
          }],
        },
        rows: retargetPlan().rows,
      };
      const decoded = decodePlan(encodePlan(incomplete));
      expect(decoded.header.problems).toEqual(incomplete.header.problems);
      expect(decoded.header.outside).toEqual(incomplete.header.outside);
      expect(() => deriveRollbackPlan(decoded, "later")).toThrow(
        "incomplete plan",
      );
    });

    it("normalizes non-canonical hash spellings onto one key", () => {
      const canonical = "fid1:" + "A".repeat(43);
      expect(canonicalPieceAddress(canonical + "=")).toBe(canonical);
      const plan = retargetPlan();
      const dup = JSON.stringify(header) + "\n" +
        JSON.stringify({ ...plan.rows[0], op: undefined, piece: canonical }) +
        "\n" +
        JSON.stringify({
          ...plan.rows[1],
          op: undefined,
          piece: canonical + "=",
        });
      expect(() => decodePlan(dup)).toThrow("more than once");
    });

    it("throws for a hash spelling with nonzero bits past its last byte", () => {
      expect(() => canonicalPieceAddress("fid1:" + "A".repeat(42) + "B"))
        .toThrow("Not a piece address");
    });

    it("canonicalizes the of: alias, and refuses an alias-spelled duplicate", () => {
      const plan = retargetPlan();
      const aliased = { ...plan.rows[0], piece: "of:fid1:aaY" };
      const text = JSON.stringify(header) + "\n" + JSON.stringify(aliased);
      expect(decodePlan(text).rows[0].piece).toBe("fid1:aaY");
      const dup = JSON.stringify(header) + "\n" +
        JSON.stringify(plan.rows[0]) + "\n" + JSON.stringify(aliased);
      expect(() => decodePlan(dup)).toThrow("more than once");
    });

    it("throws for a plan listing one piece twice", () => {
      const plan = retargetPlan();
      const text = JSON.stringify(header) + "\n" +
        JSON.stringify(plan.rows[0]) + "\n" + JSON.stringify(plan.rows[0]);
      expect(() => decodePlan(text)).toThrow("more than once");
    });

    it("throws for a retarget whose symbol disagrees with its source export", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: { main: "topic.tsx", mainExport: "Other" },
          patternIdentity: "x",
          symbol: "default",
        },
      };
      expect(() =>
        decodePlan(JSON.stringify(header) + "\n" + JSON.stringify(row))
      ).toThrow("row 1");
      const numericExport = {
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: { main: "topic.tsx", mainExport: 7 },
          patternIdentity: "x",
          symbol: "default",
        },
      };
      expect(() =>
        decodePlan(
          JSON.stringify(header) + "\n" + JSON.stringify(numericExport),
        )
      ).toThrow("row 1");
    });

    it("throws for an op of an unknown kind", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: { kind: "repaint", patternIdentity: "x", symbol: "default" },
      };
      const text = JSON.stringify(header) + "\n" + JSON.stringify(row) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });

    it("throws for a retarget op without a source main", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: {},
          patternIdentity: "x",
          symbol: "default",
        },
      };
      const text = JSON.stringify(header) + "\n" + JSON.stringify(row) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });

    it("throws for an op without its export symbol", () => {
      const plan = retargetPlan();
      const row = {
        ...plan.rows[0],
        op: { kind: "restore", patternIdentity: "x" },
      };
      const text = JSON.stringify(header) + "\n" + JSON.stringify(row) + "\n";
      expect(() => decodePlan(text)).toThrow("row 1");
    });
  });

  describe("deriveRollbackPlan()", () => {
    it("returns rows whose precondition is the reference the retarget produced", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(rollback.rows.map((row) => row.expect)).toEqual([
        { patternIdentity: "new-a", symbol: "default", retained: true },
        { patternIdentity: "new-b", symbol: "Board", retained: true },
      ]);
    });

    it("returns restore ops naming each row's recorded reference and revision", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(rollback.rows.map((row) => row.op)).toEqual([
        { kind: "restore", patternIdentity: "old-a", symbol: "default" },
        {
          kind: "restore",
          patternIdentity: "old-b",
          symbol: "Board",
          revisionId: "rev-b",
        },
      ]);
    });

    it("returns a precondition recording no origin, the retarget having detached the piece", () => {
      const plan = retargetPlan();
      const following: PiecePlan = {
        header,
        rows: plan.rows.map((row) => ({
          ...row,
          expect: { ...row.expect, origin: "https://origins.test/topic.tsx" },
        })),
      };

      const rollback = deriveRollbackPlan(following, "later");

      // The forward run detached every piece it wrote, so a detached piece
      // is what the reversal is proved against. Carrying the forward row's
      // origin here would claim the reversal detaches something already
      // gone, and the restore it runs re-attaches nothing.
      expect(rollback.rows.every((row) => row.expect.origin === undefined))
        .toBe(true);
    });

    it("returns a header stamped with the given time, same space", () => {
      const rollback = deriveRollbackPlan(retargetPlan(), "later");
      expect(rollback.header).toEqual({ ...header, takenAt: "later" });
    });

    it("leaves out rows that carry no retarget", () => {
      const plan = retargetPlan();
      const mixed: PiecePlan = {
        header,
        rows: [plan.rows[0], {
          piece: "fid1:ccc",
          expect: {
            patternIdentity: "old-c",
            symbol: "default",
            retained: true,
          },
        }],
      };
      const rollback = deriveRollbackPlan(mixed, "later");
      expect(rollback.rows.map((row) => row.piece)).toEqual(["fid1:aaY"]);
    });

    it("throws for a retarget row whose prior source is not retained, naming it", () => {
      expect(() => deriveRollbackPlan(unretainedPlan(), "later")).toThrow(
        "fid1:bbY",
      );
    });

    it("names the unretained rows in the spelling the acceptance takes", () => {
      // The refusal is the only place these addresses can be read: they are
      // rows of the plan in hand rather than pieces of a registry, so nothing
      // enumerates them at the prompt and the slot is deliberately left
      // without completion candidates (tasks/check-completion-slots.ts).
      // Pasting what the refusal prints therefore has to be accepted
      // unedited — including when the plan file spelled the address the other
      // legal way, since the message must name the canonical form and not the
      // input's.
      const aliased = encodePlan(unretainedPlan()).replace(
        '"fid1:bbY"',
        '"of:fid1:bbY"',
      );
      const plan = decodePlan(aliased);
      expect(plan.rows[1].piece).toBe("fid1:bbY");
      let message = "";
      try {
        deriveRollbackPlan(plan, "later");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // Whole words as the message prints them, never a substring mined out
      // of one: what an operator pastes is a token of this text, so a
      // truncated or decorated address has to red here rather than be
      // repaired by the reader.
      const pasted = message.split(/[\s,]+/).filter((word) =>
        word.includes("fid1:")
      );
      expect(pasted).toEqual(["fid1:bbY"]);
      const rollback = deriveRollbackPlan(plan, "later", { accepted: pasted });
      expect(rollback.rows.map((row) => row.piece)).toEqual(["fid1:aaY"]);
    });

    it("leaves out an unretained row the caller accepted by name", () => {
      const rollback = deriveRollbackPlan(unretainedPlan(), "later", {
        accepted: ["fid1:bbY"],
      });
      expect(rollback.rows.map((row) => row.piece)).toEqual(["fid1:aaY"]);
      // The header's count is the rollback's own rows, so an accepted piece
      // cannot read as one the reversal covers.
      expect(rollback.header.enumerated.collection).toBe(1);
    });

    it("throws naming the unretained rows an acceptance did not cover", () => {
      const plan = unretainedPlan();
      const both: PiecePlan = {
        header,
        rows: [{
          ...plan.rows[0],
          expect: { ...plan.rows[0].expect, retained: false },
        }, plan.rows[1]],
      };
      expect(() =>
        deriveRollbackPlan(both, "later", { accepted: ["fid1:bbY"] })
      ).toThrow("not retained for fid1:aaY");
    });

    it("throws for an acceptance naming a row whose prior source is retained", () => {
      // The operator believes they dropped a piece from the reversal, and
      // dropping nothing looks exactly like dropping something.
      expect(() =>
        deriveRollbackPlan(unretainedPlan(), "later", {
          accepted: ["fid1:bbY", "fid1:aaY"],
        })
      ).toThrow("nothing accepts as unrollbackable for fid1:aaY");
    });

    it("throws when accepting every row would leave an empty rollback", () => {
      const plan = retargetPlan();
      const none: PiecePlan = {
        header,
        rows: plan.rows.map((row) => ({
          ...row,
          expect: { ...row.expect, retained: false },
        })),
      };
      expect(() =>
        deriveRollbackPlan(none, "later", {
          accepted: ["fid1:aaY", "fid1:bbY"],
        })
      ).toThrow("would be empty");
    });

    it("throws for a plan with no retarget rows", () => {
      const surveyOnly: PiecePlan = {
        header,
        rows: [{
          piece: "fid1:aaY",
          expect: {
            patternIdentity: "old-a",
            symbol: "default",
            retained: true,
          },
        }],
      };
      expect(() => deriveRollbackPlan(surveyOnly, "later")).toThrow(
        "no retarget rows",
      );
    });
  });
});
