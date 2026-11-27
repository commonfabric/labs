/**
 * A template over a parser-backed host before and after the host's grammar
 * loads, in a file of its own so that nothing has loaded that grammar before
 * its first case runs.
 */

import { expect } from "@std/expect";

import { languageForName } from "../../../../lib/view/languages/language.ts";
import type { Line, TokenClass } from "../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** Every class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return lines.flatMap((line) =>
    line.spans.filter((span) => span.text === text).map((span) => span.cls)
  );
}

describe("template", () => {
  it("colors the template's regions before the host's grammar loads, and the host's text once it has", async () => {
    const language = languageForName("jinja-shell")!;
    const source = "echo {{ name }}\n";

    const before = language.highlightLines(source);
    expect(classesOf(before, "name")).toEqual(["identifier"]);
    expect(classesOf(before, "echo")).toEqual(["plain"]);

    await language.prepare!();

    const after = language.highlightLines(source);
    expect(classesOf(after, "name")).toEqual(["identifier"]);
    expect(classesOf(after, "echo")).toEqual(["callName"]);
  });

  it("has nothing to load over a host without a parser", () => {
    expect(languageForName("jinja")!.prepare).toBeUndefined();
  });
});
