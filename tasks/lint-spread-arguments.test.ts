/// <reference lib="deno.unstable" />

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import plugin from "./lint-spread-arguments.ts";

/** The source text of each spread the rule reports in `source`. */
function reported(source: string): string[] {
  return Deno.lint.runPlugin(plugin, "sample.ts", source).map((diagnostic) =>
    source.slice(...diagnostic.range)
  );
}

describe("lint-spread-arguments", () => {
  it("reports a spread into `push`, `unshift`, and `splice` on any object", () => {
    expect(reported(`
      records.push(...more);
      lane.records.unshift(...more);
      held?.splice(0, 0, ...more);
    `)).toEqual(["...more", "...more", "...more"]);
  });

  it("reports a spread into `Math.max`, `Math.min`, and `String.fromCharCode`", () => {
    expect(reported(`
      Math.max(...times);
      Math.min(0, ...times);
      String.fromCharCode(...bytes);
      String.fromCodePoint(...points);
    `)).toEqual(["...times", "...times", "...bytes", "...points"]);
  });

  it("reports each spread of a call that has two", () => {
    expect(reported("Math.max(1, ...names, ...members);")).toEqual([
      "...names",
      "...members",
    ]);
  });

  it("returns nothing for the same calls without a spread", () => {
    expect(reported(`
      records.push(record);
      Math.max(most, seconds);
      String.fromCharCode(byte);
      for (const record of more) records.push(record);
    `)).toEqual([]);
  });

  it("returns nothing for a spread into another call or an array", () => {
    expect(reported(`
      path.join(root, ...segments);
      console.log(...parts);
      max(...times);
      Other.max(...times);
      records[push](...more);
      const all = [...records, ...more];
    `)).toEqual([]);
  });
});
