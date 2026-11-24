/**
 * The Dockerfile language before and after the shell grammar loads, in a file
 * of its own so that nothing has loaded that grammar before its one case runs.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { dockerfileLanguage } from "../../../../../lib/view/languages/dockerfile/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

/** Every class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return lines.flatMap((line) =>
    line.spans.filter((span) => span.text === text).map((span) => span.cls)
  );
}

describe("dockerfileLanguage", () => {
  it("colors Dockerfile syntax before the shell grammar loads, and a command's shell once it has", async () => {
    const source = "FROM base AS build\nRUN echo hi\n";

    const before = dockerfileLanguage.highlightLines(source);
    expect(classesOf(before, "build")).toEqual(["functionName"]);
    expect(classesOf(before, "echo")).toEqual(["plain"]);

    await dockerfileLanguage.prepare!();

    const after = dockerfileLanguage.highlightLines(source);
    expect(classesOf(after, "build")).toEqual(["functionName"]);
    expect(classesOf(after, "echo")).toEqual(["callName"]);
  });
});
