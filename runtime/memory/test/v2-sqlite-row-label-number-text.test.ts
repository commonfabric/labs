/**
 * CFC Phase 3: what a NON-TEXT row value presents to a row-rule regex.
 *
 * A rule's `match()`/`whenMatches()` regexes read a column's text, and a
 * column keyed by an INTEGER — a per-mailbox `source_id`, a per-account id —
 * is the ordinary case a rule wants to gate on. These tests pin the text the
 * evaluator hands the regex against SQLite's own conversion, and pin the
 * value classes that stay refused — the REAL among them, for a reason only a
 * real database can establish.
 *
 * Unlike its neighbor `v2-sqlite-row-label.test.ts`, this file opens a real
 * database: the claim under test is "the text SQLite would show", and only
 * SQLite can settle it.
 *
 * Spec: docs/specs/sqlite-builtin/06-cfc.md ("Per-row labels").
 */

import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  all,
  constant,
  dbOwner,
  evaluateRowLabel,
  match,
  principal,
  regexInputText,
  type RowLabelSpec,
  validateRowLabelSpec,
  whenMatches,
} from "../v2/sqlite/row-label.ts";
import { table } from "../v2/sqlite/schema.ts";

const OWNER = "did:key:zOwner";
const GATED = "did:mailto:seven@example.com";

/** A rule whose only data-dependent clause is a gate on column `v`. */
function gateSpec(re: RegExp, sqlType = "integer"): RowLabelSpec {
  const schema = table(
    { id: "integer primary key", v: sqlType },
    (f) => ({
      confidentiality: all(whenMatches(f.v, re, constant(GATED)), dbOwner()),
    }),
  );
  return schema.rowLabel as RowLabelSpec;
}

/** Whether the gate fired for `value`, or the refusal it produced. */
function gate(
  re: RegExp,
  value: unknown,
  sqlType?: string,
): { fired: boolean } | { error: string } {
  const res = evaluateRowLabel(gateSpec(re, sqlType), { id: 1, v: value }, {
    dbOwner: OWNER,
  });
  if ("error" in res) return res;
  return { fired: res.confidentiality.includes(GATED) };
}

/** The refusal a value produces, or `undefined` when it produced a label. */
function refusal(value: unknown): string | undefined {
  const res = gate(/^7$/, value);
  return "error" in res ? res.error : undefined;
}

/** A rule whose only clause extracts principals from column `v`. */
function extractorSpec(re: RegExp): RowLabelSpec {
  const schema = table(
    { id: "integer primary key", v: "integer" },
    (f) => ({ confidentiality: all(principal("acct", match(f.v, re))) }),
  );
  return schema.rowLabel as RowLabelSpec;
}

/** What `match()` extracts from `value`, or the refusal it produced. */
function extract(
  re: RegExp,
  value: unknown,
): { atoms: unknown[] } | { error: string } {
  const res = evaluateRowLabel(extractorSpec(re), { id: 1, v: value }, {
    dbOwner: OWNER,
  });
  return "error" in res ? res : { atoms: res.confidentiality };
}

describe("row-label numeric regex input", () => {
  describe("a gate on an INTEGER column", () => {
    it("fires on the digits SQLite shows for the value", () => {
      // The msgvault case: every mailbox keyed by an INTEGER `source_id`, and
      // the per-mailbox facet rule written as the natural `/^7$/`.
      expect(gate(/^7$/, 7)).toEqual({ fired: true });
    });

    it("stays quiet for a different integer", () => {
      expect(gate(/^7$/, 8)).toEqual({ fired: false });
      expect(gate(/^7$/, 71)).toEqual({ fired: false });
      expect(gate(/^7$/, -7)).toEqual({ fired: false });
    });

    it("shows a negative integer with its sign", () => {
      expect(gate(/^-7$/, -7)).toEqual({ fired: true });
    });

    it('shows zero as "0", negative zero included', () => {
      expect(gate(/^0$/, 0)).toEqual({ fired: true });
      expect(gate(/^0$/, -0)).toEqual({ fired: true });
    });

    it("shows a bigint by its digits, for a driver in int64 mode", () => {
      expect(gate(/^9007199254740993$/, 9007199254740993n)).toEqual({
        fired: true,
      });
    });
  });

  describe("a REAL a column happens to hold", () => {
    // A rule cannot name a REAL-declared column at all (see "declaring the
    // rule"), but affinity is not a type: an INTEGER-affinity column keeps a
    // value it cannot convert losslessly, so a REAL still reaches a rule.
    it("refuses a fractional value rather than approximating its text", () => {
      // SQLite's own REAL text is not a function of the double (see "the text
      // SQLite shows" below), and a gate that nearly reproduces it is a gate
      // that silently misses rows.
      expect(gate(/^7\.5$/, 7.5)).toEqual({
        error: expect.stringContaining("REAL"),
      });
    });

    it("refuses an infinity", () => {
      expect(refusal(Infinity)).toMatch(/infinity/);
      expect(refusal(-Infinity)).toMatch(/infinity/);
    });
  });

  describe("the value classes that stay refused", () => {
    it("refuses NaN, which SQLite has no value for", () => {
      expect(refusal(NaN)).toMatch(/NaN/);
    });

    it("refuses a whole number too large to name one INTEGER", () => {
      // Past 2^53 a JS number no longer names one int64, and an INTEGER
      // column read into a double has already lost the stored digits: any
      // text we produced could name a different row.
      expect(refusal(1e21)).toMatch(/too large/);
      expect(refusal(2 ** 53)).toMatch(/too large/);
      expect(refusal(-(2 ** 53))).toMatch(/too large/);
    });

    it("refuses a bigint outside the int64 range SQLite stores", () => {
      expect(refusal(2n ** 63n)).toMatch(/regex input/);
    });

    it("refuses a boolean, which is not a SQLite value", () => {
      expect(refusal(true)).toMatch(/boolean/);
      expect(refusal(false)).toMatch(/boolean/);
    });

    it("refuses a BLOB", () => {
      expect(refusal(new Uint8Array([1, 2]))).toMatch(/regex input/);
    });

    it("names no value in the refusal, only its class", () => {
      // A refusal reaches a model-facing consumer, so it must not carry the
      // row's own data (CFC spec invariant 14: no existence channel).
      const reason = refusal(1234567890123456789012);
      expect(reason).toBeDefined();
      expect(reason).not.toMatch(/1234567890123456789/);
    });
  });

  describe("a NULL, an absent value, and a zero", () => {
    it("keeps a NULL gate quiet rather than refusing", () => {
      expect(gate(/^7$/, null)).toEqual({ fired: false });
      expect(gate(/^7$/, undefined)).toEqual({ fired: false });
      expect(gate(/^7$/, "")).toEqual({ fired: false });
    });

    it("distinguishes a zero from a NULL", () => {
      // `0` is a value SQLite shows as "0"; NULL shows nothing. An evaluator
      // that treated falsy-as-absent would collapse the two.
      expect(gate(/^0$/, 0)).toEqual({ fired: true });
      expect(gate(/^0$/, null)).toEqual({ fired: false });
    });
  });

  describe("match(), the extractor", () => {
    // The gate and the extractor read a column through one function, so what
    // one refuses the other refuses. These assert that on the extractor
    // directly: an extractor that rendered values its own way would mint
    // principals from a REAL's digits, from a BLOB's bytes, and from an
    // integer too large to be the one stored — silently, since a minted
    // principal looks like any other.
    it("refuses every value class the gate refuses", () => {
      for (const value of [7.5, Infinity, NaN, 2 ** 53, true, 2n ** 63n]) {
        expect(extract(/\d+/, value)).toEqual({
          error: expect.stringContaining("regex input"),
        });
      }
      expect(extract(/\d+/, new Uint8Array([1, 2]))).toEqual({
        error: expect.stringContaining("BLOB"),
      });
    });

    it("extracts from a zero, which is a value and not an absence", () => {
      expect(extract(/\d+/, 0)).toEqual({ atoms: ["did:acct:0"] });
    });

    it("extracts from a number the same text a gate compares", () => {
      const schema = table(
        { id: "integer primary key", source_id: "integer" },
        (f) => ({
          confidentiality: all(
            principal("mailbox", match(f.source_id, /\d+/, { min: 1 })),
          ),
        }),
      );
      const res = evaluateRowLabel(
        schema.rowLabel as RowLabelSpec,
        { id: 1, source_id: 7 },
        { dbOwner: OWNER },
      );
      expect(res).toEqual({
        confidentiality: ["did:mailbox:7"],
        integrity: [],
      });
    });

    it("still fails closed when a populated number matches nothing", () => {
      // Strict-if-present is unchanged: a value that yields no match under-
      // labels the row, so it refuses rather than dropping the principal.
      const schema = table(
        { id: "integer primary key", source_id: "integer" },
        (f) => ({
          confidentiality: all(
            principal("mailbox", match(f.source_id, /[a-z]+/)),
          ),
        }),
      );
      const res = evaluateRowLabel(
        schema.rowLabel as RowLabelSpec,
        { id: 1, source_id: 7 },
        { dbOwner: OWNER },
      );
      expect(res).toEqual({
        error: expect.stringContaining("matched nothing"),
      });
    });
  });

  describe("the text SQLite shows", () => {
    it("is what regexInputText() returns for every INTEGER", () => {
      const corpus = [
        0,
        7,
        -7,
        42,
        1000000,
        -9007199254740991,
        9007199254740991,
        9007199254740993n,
        -9007199254740993n,
        9223372036854775807n,
        -9223372036854775808n,
      ];
      const db = new Database(":memory:");
      try {
        const cast = db.prepare("SELECT CAST(?1 AS TEXT) AS text");
        for (const value of corpus) {
          const shown = cast.get<{ text: string }>(value as never)?.text;
          expect({ value: String(value), text: regexInputText(value) })
            .toEqual({ value: String(value), text: shown });
        }
      } finally {
        db.close();
      }
    });

    it("is not a function of the double, for a REAL", () => {
      // The evidence behind refusing a REAL, and it is stronger than one
      // build can show: SQLite renders a REAL from its own decoded digits,
      // and the builds behind this driver disagree about the last one. For
      // -0.009598882198146955 the arm64 build returns
      // "-0.00959888219814696" and the x86-64 build the correctly rounded
      // "-0.00959888219814695" — the decoder uses a long double where that is
      // wider than a double, so the split follows the architecture. The
      // rendering is therefore not a function of the double the evaluator
      // holds, and no formatter is right on both. A gate compares the text
      // SQLite would show, so "close" is a gate that misses rows: this
      // asserts the disagreement rather than either build's answer.
      const value = -0.009598882198146955;
      const correctlyRounded = "-0.00959888219814695";
      const longDoubleBuild = "-0.00959888219814696";
      expect(value.toPrecision(15)).toBe(correctlyRounded);

      const db = new Database(":memory:");
      try {
        const shown = db.prepare("SELECT CAST(?1 AS TEXT) AS text")
          .get<{ text: string }>(value)?.text;
        expect([correctlyRounded, longDoubleBuild]).toContain(shown);
        expect(regexInputText(value)).toBeUndefined();
      } finally {
        db.close();
      }
    });

    it("diverges only where a JS number has lost the storage class", () => {
      // The one documented gap for a value that DOES coerce: SQLite writes a
      // REAL 7.0 as "7.0", and the driver hands that same row value to the
      // evaluator as the JS number 7, which carries no REAL/INTEGER tag. The
      // evaluator shows the integer spelling, so a gate is written against
      // the digits rather than against the column's declared type.
      const db = new Database(":memory:");
      try {
        db.exec("CREATE TABLE t (r real, i integer)");
        db.exec("INSERT INTO t VALUES (7.0, 7)");
        const shown = db.prepare(
          "SELECT CAST(r AS TEXT) AS r, CAST(i AS TEXT) AS i FROM t",
        ).get<{ r: string; i: string }>();
        expect(shown).toEqual({ r: "7.0", i: "7" });

        const stored = db.prepare("SELECT r, i FROM t").get<
          { r: unknown; i: unknown }
        >();
        expect(stored).toEqual({ r: 7, i: 7 });
        expect(regexInputText(stored?.r)).toBe("7");
        expect(regexInputText(stored?.i)).toBe("7");
      } finally {
        db.close();
      }
    });
  });

  describe("declaring the rule", () => {
    it("refuses a rule that reads a REAL column", () => {
      // Every value a REAL-affinity column holds is a REAL, and this
      // evaluator will not render one. A rule there is either dead (the
      // fractional values refuse) or misleading (a whole value shows "7"
      // where SQLite shows "7.0", so a rule written from the column's type
      // never fires, and a gate that never fires drops a clause). Refusing
      // at declaration is the only place that can be said out loud.
      expect(() =>
        table({ id: "integer primary key", score: "real" }, (f) => ({
          confidentiality: all(
            whenMatches(f.score, /^7$/, constant(GATED)),
            dbOwner(),
          ),
        }))
      ).toThrow(/REAL/);
    });

    it("refuses a rule that reads a BLOB column", () => {
      expect(() =>
        table({ id: "integer primary key", raw: "blob" }, (f) => ({
          confidentiality: all(
            principal("acct", match(f.raw, /\d+/)),
            dbOwner(),
          ),
        }))
      ).toThrow(/BLOB/);
    });

    it("reads a column whose declared type says BLOB but is INTEGER to SQLite", () => {
      // Affinity, not substring: `INT BLOB` has INTEGER affinity (INT matches
      // first), so the rule reads whole integers as it does from `integer`.
      expect(() =>
        table({ id: "integer primary key", source_id: "int blob" }, (f) => ({
          confidentiality: principal("mailbox", match(f.source_id, /^\d+$/)),
        }))
      ).not.toThrow();
    });

    it("re-runs that refusal on a wire-supplied spec", () => {
      // `db.tables` arrives over the wire, so a spec that never went through
      // `table()` reaches the same refusal before anything is evaluated.
      const spec = table({ id: "integer primary key", score: "text" }, (f) => ({
        confidentiality: all(
          whenMatches(f.score, /^7$/, constant(GATED)),
          dbOwner(),
        ),
      })).rowLabel as RowLabelSpec;
      expect(validateRowLabelSpec(spec, ["id", "score"])).toBeUndefined();
      expect(
        validateRowLabelSpec(spec, ["id", "score"], {
          id: { sqlType: "integer primary key" },
          score: { sqlType: "double precision" },
        }),
      ).toMatch(/REAL/);
    });

    it("takes a gate on a non-TEXT column without complaint", () => {
      // The refusal was only ever at evaluation: no validator reads a
      // column's declared type, so nothing had to change at declaration.
      expect(() =>
        table({ id: "integer primary key", source_id: "integer" }, (f) => ({
          confidentiality: all(
            whenMatches(f.source_id, /^7$/, constant(GATED)),
            dbOwner(),
          ),
        }))
      ).not.toThrow();
    });
  });
});
