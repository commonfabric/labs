/**
 * What `run_pattern` reads off a materialized pattern's own outputs, what it
 * tells the model, and what it keeps for the artifact alone. The end-to-end
 * statement — that a composed reader's failure reaches the run's answer while
 * the run still succeeds — is in run-pattern-pattern-index.test.ts, where a
 * composition has an index to resolve through.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import {
  dedupedObservedOutputs,
  type ObservedOutput,
  observedOutputCause,
  observedOutputsIn,
  OUTPUT_CONCERN_MESSAGES,
} from "../src/run-pattern-output-concerns.ts";

/** The outputs a connector-reading atom exposes beside its rows. */
const readerResult = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  month: "2026-09",
  rows: [{ id: 1 }],
  rowCount: 1,
  pending: false,
  errorMessage: "",
  ...overrides,
});

/** An object schema declaring each of `names` and nothing else. */
const declaring = (...names: readonly string[]): JSONSchema => ({
  type: "object",
  properties: Object.fromEntries(names.map((name) => [name, {}])),
});

/** The schema a connector-reading atom declares its outputs under. */
const READER_SCHEMA = declaring(
  "month",
  "rows",
  "rowCount",
  "pending",
  "errorMessage",
);

/** What each observation says, as `<key>:<kind>`. */
const positions = (observed: readonly ObservedOutput[]): string[] =>
  observed.map((one) => `${one.concern.key}:${one.concern.concern}`);

describe("run-pattern-output-concerns", () => {
  describe("observedOutputsIn()", () => {
    it("returns nothing for a result whose reads all landed", () => {
      expect(observedOutputsIn(readerResult(), READER_SCHEMA)).toEqual([]);
    });

    it("names the output an error message was read from", () => {
      expect(
        observedOutputsIn(
          readerResult({ errorMessage: "no such column: x" }),
          READER_SCHEMA,
        ).map((one) => one.concern),
      ).toEqual([{
        concern: "error-branch",
        key: "errorMessage",
        message: OUTPUT_CONCERN_MESSAGES["error-branch"],
      }]);
    });

    it("names the pattern an output was read from when one is given", () => {
      expect(
        observedOutputsIn(
          readerResult({ errorMessage: "no such column: x" }),
          READER_SCHEMA,
          "patternIdentity",
        )[0].concern.patternId,
      ).toBe("patternIdentity");
    });

    it("keeps the error's own text out of what the model is told", () => {
      const observed = observedOutputsIn(
        readerResult({ errorMessage: "no such column: secretColumnName" }),
        READER_SCHEMA,
      );

      expect(JSON.stringify(observed.map((one) => one.concern)))
        .not.toContain("secretColumnName");
      expect(observed[0].text).toBe("no such column: secretColumnName");
    });

    it("reads a runtime SQLite failure under an output named anything", () => {
      expect(
        positions(observedOutputsIn(
          {
            status: "sqlite: param is undefined (it may be a value that " +
              "isn't ready yet); pass a resolved value, or null for SQL NULL",
          },
          declaring("status"),
        )),
      ).toEqual(["status:error-branch"]);
    });

    it("leaves a string that merely mentions sqlite alone", () => {
      expect(
        observedOutputsIn(
          { caption: "rows from the sqlite store" },
          declaring("caption"),
        ),
      ).toEqual([]);
    });

    it("names an output holding no rows, with no text to keep", () => {
      const observed = observedOutputsIn(
        readerResult({ rows: [], rowCount: 0 }),
        READER_SCHEMA,
      );

      expect(observed.map((one) => one.concern)).toEqual([{
        concern: "no-rows",
        key: "rows",
        message: OUTPUT_CONCERN_MESSAGES["no-rows"],
      }]);
      expect(observed[0].text).toBe("");
    });

    it("names both an output that failed and an output left empty", () => {
      expect(
        positions(observedOutputsIn(
          readerResult({
            rows: [],
            rowCount: 0,
            errorMessage: "sqlite: param is undefined",
          }),
          READER_SCHEMA,
        )),
      ).toEqual(["rows:no-rows", "errorMessage:error-branch"]);
    });

    it("marks an in-flight read as pending rather than empty data", () => {
      expect(
        positions(observedOutputsIn(
          readerResult({ rows: [], rowCount: 0, pending: true }),
          READER_SCHEMA,
        )),
      ).toEqual(["pending:pending"]);
    });

    it("names the failure of a read still in flight", () => {
      expect(
        positions(observedOutputsIn(
          readerResult({
            rows: [],
            pending: true,
            errorMessage: "no such column: x",
          }),
          READER_SCHEMA,
        )),
      ).toEqual(["pending:pending", "errorMessage:error-branch"]);
    });

    it("passes over an empty list on a result that reports no read", () => {
      expect(
        observedOutputsIn(
          { chosen: [], title: "nothing picked yet" },
          declaring("chosen", "title"),
        ),
      ).toEqual([]);
    });

    it("reads a failure off a result that reports no read", () => {
      expect(
        positions(observedOutputsIn(
          { error: "the handle is not a database" },
          declaring("error"),
        )),
      ).toEqual(["error:error-branch"]);
    });

    it("passes over an output the pattern's schema does not declare", () => {
      expect(
        observedOutputsIn(
          { rows: [], errorMessage: "broke" },
          declaring("rows"),
        ).map((one) => one.concern.key),
      ).toEqual([]);
    });

    it("passes over every output when the pattern declared no schema", () => {
      expect(observedOutputsIn(readerResult({ rows: [] }), undefined))
        .toEqual([]);
    });

    it("leaves the framework's own result keys alone", () => {
      expect(
        observedOutputsIn({ $UI: [], $NAME: "" }, declaring("$UI", "$NAME")),
      ).toEqual([]);
    });

    it("reads only the top level of a result", () => {
      expect(
        observedOutputsIn(
          { inner: { rows: [], errorMessage: "broke" } },
          declaring("inner"),
        ),
      ).toEqual([]);
    });

    it("returns nothing for a result that is not an object", () => {
      expect(observedOutputsIn(["rows"], READER_SCHEMA)).toEqual([]);
      expect(observedOutputsIn(undefined, READER_SCHEMA)).toEqual([]);
    });
  });

  describe("dedupedObservedOutputs()", () => {
    it("states an output one pattern reported many times once", () => {
      const repeated = observedOutputsIn(
        { rows: [] },
        declaring("rows", "errorMessage"),
        "reader",
      );

      expect(dedupedObservedOutputs([...repeated, ...repeated, ...repeated]))
        .toEqual(repeated);
    });

    it("keeps the same output read from two different patterns", () => {
      const schema = declaring("rows", "errorMessage");

      expect(
        dedupedObservedOutputs([
          ...observedOutputsIn({ rows: [] }, schema, "ledger"),
          ...observedOutputsIn({ rows: [] }, schema, "mailbox"),
        ]).map((one) => one.concern.patternId),
      ).toEqual(["ledger", "mailbox"]);
    });

    it("keeps two outputs of one pattern apart", () => {
      expect(
        positions(dedupedObservedOutputs(observedOutputsIn(
          { rows: [], errorMessage: "broke" },
          declaring("rows", "errorMessage"),
          "reader",
        ))),
      ).toEqual(["rows:no-rows", "errorMessage:error-branch"]);
    });
  });

  describe("observedOutputCause()", () => {
    it("returns nothing when nothing was observed", () => {
      expect(observedOutputCause([])).toBeUndefined();
    });

    it("names each position and the text the model was not told", () => {
      expect(
        observedOutputCause(observedOutputsIn(
          { errorMessage: "no such column: x" },
          declaring("errorMessage"),
          "reader",
        )),
      ).toBe("reader errorMessage (error-branch): no such column: x");
    });

    it("names the run's own result for an output no pattern id came with", () => {
      expect(
        observedOutputCause(observedOutputsIn(
          { rows: [] },
          declaring("rows", "errorMessage"),
        )),
      ).toBe("this run's own result rows (no-rows)");
    });

    it("writes one line per observation", () => {
      expect(
        observedOutputCause(observedOutputsIn(
          { rows: [], errorMessage: "broke" },
          declaring("rows", "errorMessage"),
          "reader",
        ))?.split("\n"),
      ).toEqual([
        "reader rows (no-rows)",
        "reader errorMessage (error-branch): broke",
      ]);
    });
  });
});
