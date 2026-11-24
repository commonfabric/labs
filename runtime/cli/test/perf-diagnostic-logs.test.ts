/**
 * Covers `isPerfDiagnosticWarnKey()`, which decides whether a warn-level
 * logger key names a perf diagnostic: a warning that fires on how long
 * something took, and so on how fast the machine is and how loaded it happens
 * to be, rather than on anything the program did. The list of them exists so
 * that a run's warnings can be held to account without a test's outcome
 * turning on the load, and each case here puts a key on one side of it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isPerfDiagnosticWarnKey } from "../lib/perf-diagnostic-logs.ts";

describe("isPerfDiagnosticWarnKey()", () => {
  it("returns `true` for the key a slow traversal reports under", () => {
    expect(isPerfDiagnosticWarnKey("traverse", "slow-traverse")).toBe(true);
  });

  it("returns `true` for a slow `Cell.get`, whose key carries its bucket", () => {
    expect(isPerfDiagnosticWarnKey("cell", "get >210ms")).toBe(true);
  });

  it("returns `false` for a perf key another logger emitted", () => {
    expect(isPerfDiagnosticWarnKey("cell", "slow-traverse")).toBe(false);
  });

  it("returns `false` for another key of a logger that has a perf key", () => {
    expect(isPerfDiagnosticWarnKey("cell", "pull")).toBe(false);
  });
});
