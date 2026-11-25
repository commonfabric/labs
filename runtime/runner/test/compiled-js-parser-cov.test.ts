import { expect } from "@std/expect";
import { parseFunctionText } from "../src/sandbox/compiled-js-parser.ts";
import { describe, it } from "@commonfabric/test-support/test";

const statementsOf = (source: string): string[] =>
  parseFunctionText(source, 0, source.length).body.statements.map((s) =>
    source.slice(s.start, s.end).trim()
  );

describe("parseFunctionText()", () => {
  it("ends a statement after the block of a `while` loop", () => {
    expect(statementsOf(`function () {
      while (x) { g(); }
      next();
    }`)).toEqual(["while (x) { g(); }", "next();"]);
  });

  it("does not end a statement after a block when the statement starts with another word beginning with `w`", () => {
    expect(statementsOf(`function () {
      wrap = { g: 1 }
      next();
    }`)).toEqual(["wrap = { g: 1 }\n      next();"]);
  });
});
