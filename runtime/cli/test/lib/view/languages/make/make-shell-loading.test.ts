/**
 * The makefile language before and after the shell grammar loads, in a file of
 * its own so that nothing has loaded that grammar before its one case runs.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { makeLanguage } from "../../../../../lib/view/languages/make/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

/** Every class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return lines.flatMap((line) =>
    line.spans.filter((span) => span.text === text).map((span) => span.cls)
  );
}

describe("makeLanguage", () => {
  it("colors make's syntax before the shell grammar loads, and a recipe's shell once it has", async () => {
    const source = "all:\n\techo $(X)\n";

    const before = makeLanguage.highlightLines(source);
    expect(classesOf(before, "all")).toEqual(["functionName"]);
    expect(classesOf(before, "X")).toEqual(["propertyName"]);
    expect(classesOf(before, "echo")).toEqual(["plain"]);

    await makeLanguage.prepare!();

    const after = makeLanguage.highlightLines(source);
    expect(classesOf(after, "X")).toEqual(["propertyName"]);
    expect(classesOf(after, "echo")).toEqual(["callName"]);
  });
});
