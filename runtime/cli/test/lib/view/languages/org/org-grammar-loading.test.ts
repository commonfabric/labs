/**
 * Tests that preparing a view loads the parser of a language that an Org
 * source block names, which no selection names. Every other case that reaches
 * a parser lives in another file, because a case here that loaded one would
 * leave this file's evidence unable to fail.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { finishGrammarLoads } from "../../../../../lib/view/languages/language.ts";
import { buildPreparedView } from "../../../../../lib/view/mod.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

/** Every class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return lines.flatMap((line) =>
    line.spans.filter((span) => span.text === text).map((span) => span.cls)
  );
}

describe("org grammar loading", () => {
  it("colors a source block in its language once the view is prepared", async () => {
    // A view built before the shell parser loads shows the block as plain
    // text, so the coloring shows that preparing the view waited for the load
    // its parse started.

    expect(await finishGrammarLoads()).toBe(false);
    const source = "* Demo\n#+begin_src bash\necho hello\n#+end_src\n";

    const { doc } = await buildPreparedView(source, undefined, false, {
      fileName: "scenarios.org",
    });

    expect(classesOf(doc.lines, "Demo")).toEqual(["sectionHeader"]);
    expect(classesOf(doc.lines, "echo")).toEqual(["callName"]);
    expect(await finishGrammarLoads()).toBe(false);
  });
});
