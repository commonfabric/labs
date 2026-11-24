/**
 * Unit coverage for recognizing and rendering the record an `assert(...)`
 * assertion carries. Both `cf test` runners read an assertion's value through
 * `asAssertRecord`, so a value that is not a record — a bare boolean from a
 * `computed()`, a null, an object missing a field — has to be told apart from a
 * genuine record at that point, and a failed record has to render its operands.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { AssertRecord } from "@commonfabric/api";
import {
  asAssertRecord,
  assertionOutcome,
  formatAssertRecord,
} from "../lib/assert-record.ts";

describe("assert-record", () => {
  it("rejects a value that is not an object", () => {
    expect(asAssertRecord(true)).toBeUndefined();
    expect(asAssertRecord(0)).toBeUndefined();
    expect(asAssertRecord("nope")).toBeUndefined();
  });

  it("rejects null", () => {
    expect(asAssertRecord(null)).toBeUndefined();
  });

  it("rejects an object missing or mistyping a required field", () => {
    expect(asAssertRecord({ source: "x", parts: [] })).toBeUndefined();
    expect(asAssertRecord({ ok: true, parts: [] })).toBeUndefined();
    expect(asAssertRecord({ ok: true, source: "x" })).toBeUndefined();
    expect(asAssertRecord({ ok: "yes", source: "x", parts: [] }))
      .toBeUndefined();
  });

  it("returns the record for a well-formed assert value", () => {
    const value = {
      ok: false,
      source: "a <= b",
      parts: [{ src: "a", rendered: "3" }, { src: "b", rendered: "2" }],
    };
    expect(asAssertRecord(value)).toEqual(value);
  });

  it("drops parts that are not well-formed operands", () => {
    const record = asAssertRecord({
      ok: false,
      source: "a <= b",
      parts: [
        { src: "a", rendered: "3" },
        { src: "b" },
        null,
        "garbage",
      ],
    });
    expect(record?.parts).toEqual([{ src: "a", rendered: "3" }]);
  });

  it("renders an empty record as the bare verdict when its source is empty", () => {
    const record: AssertRecord = { ok: false, source: "", parts: [] };
    expect(formatAssertRecord(record)).toBe("Expected true, got false");
  });

  it("renders an empty record with its source when the source is present", () => {
    const record: AssertRecord = {
      ok: false,
      source: "allPositive(...nums)",
      parts: [],
    };
    expect(formatAssertRecord(record)).toBe(
      "Expected true, got false: allPositive(...nums)",
    );
  });

  it("renders operands aligned under the source", () => {
    const record: AssertRecord = {
      ok: false,
      source: "a + b <= c",
      parts: [{ src: "a + b", rendered: "3" }, { src: "c", rendered: "2" }],
    };
    expect(formatAssertRecord(record)).toBe(
      "a + b <= c\n  a + b = 3\n  c     = 2",
    );
  });

  it("passes an assertion whose record holds", () => {
    const value = { ok: true, source: "a <= b", parts: [] };
    expect(assertionOutcome(value)).toEqual({ passed: true });
  });

  it("fails an assertion whose record does not hold, with its operands", () => {
    const value = {
      ok: false,
      source: "a <= b",
      parts: [{ src: "a", rendered: "3" }, { src: "b", rendered: "2" }],
    };
    expect(assertionOutcome(value)).toEqual({
      passed: false,
      error: "a <= b\n  a = 3\n  b = 2",
    });
  });

  it("fails a value that is not a record, reporting what it read", () => {
    expect(assertionOutcome(undefined)).toEqual({
      passed: false,
      error: "Expected true, got `undefined`",
    });
  });
});
