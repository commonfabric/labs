/**
 * Reading and rendering the record an `assert(...)` test assertion carries.
 *
 * Both `cf test` runners evaluate an assertion step to a value and report a
 * failure from it, so the recognition and the rendering live here rather than
 * in either runner.
 */

import type { AssertPart, AssertRecord } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Recognizes the record an `assert(...)` assertion carries. A `computed(...)`
 * assertion carries a bare boolean instead, so this is what tells the two
 * apart at the point the harness reads the value.
 */
export function asAssertRecord(value: unknown): AssertRecord | undefined {
  if (!isObjectOrArray(value)) return undefined;
  const candidate = value as Partial<AssertRecord>;
  if (
    typeof candidate.ok !== "boolean" ||
    typeof candidate.source !== "string" ||
    !Array.isArray(candidate.parts)
  ) {
    return undefined;
  }
  const parts = candidate.parts.filter((part): part is AssertPart =>
    isObjectOrArray(part) &&
    typeof (part as Partial<AssertPart>).src === "string" &&
    typeof (part as Partial<AssertPart>).rendered === "string"
  );
  return { ok: candidate.ok, source: candidate.source, parts };
}

/**
 * Renders a failed `assert(...)` as its authored text followed by the operands
 * recorded while it ran, for example:
 *
 *     a + b <= c
 *       a + b = 3
 *       c     = 2
 *
 * The operands say the assertion was false, so saying it again adds nothing.
 * An assertion that recorded none — a bare value, or one whose operands are
 * all literals — has nothing to explain itself with, so that one still reports
 * what happened rather than restating the source on its own.
 */
export function formatAssertRecord(record: AssertRecord): string {
  if (record.parts.length === 0) {
    return record.source.length > 0
      ? `Expected true, got false: ${record.source}`
      : "Expected true, got false";
  }

  const width = Math.max(...record.parts.map((part) => part.src.length));
  const lines = record.parts.map((part) =>
    `  ${part.src.padEnd(width)} = ${part.rendered}`
  );
  return [record.source, ...lines].join("\n");
}

/**
 * The pass/fail outcome both runners report for an assertion step, from the
 * value they read for it. A well-formed `assert(...)` value is a record: it
 * passes when the record's `ok` holds, and fails with the recorded operands
 * otherwise. A value that is not a record — an assertion that did not
 * materialize, read back as `undefined` — fails and reports what arrived
 * rather than crashing.
 */
export function assertionOutcome(
  value: unknown,
): { passed: boolean; error?: string } {
  const record = asAssertRecord(value);
  if (record) {
    return record.ok
      ? { passed: true }
      : { passed: false, error: formatAssertRecord(record) };
  }
  return {
    passed: false,
    error: debugStr`Expected true, got $quote,long${value}`,
  };
}
